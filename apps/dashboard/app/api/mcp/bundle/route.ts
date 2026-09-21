/**
 * Bundles dashboard-authored MCP server source with the same esbuild flags
 * the CLI uses at deploy; validation, upload and the sandboxed probe live in
 * the Convex mcp service. AuthKit's proxy gates this path.
 */
import type { BuildFailure, Metafile, Plugin } from "esbuild";
import { build } from "esbuild";
import { builtinModules } from "node:module";

const MAX_SOURCE_BYTES = 512 * 1024;
const ALLOWED_PACKAGES = new Set(["@modelcontextprotocol/server", "zod"]);
const NODE_BUILTINS = new Set(builtinModules);
const SOURCE_FILE = "mcp-server.ts";
const IMPORT_RULE = `hosted MCP source may import ${[...ALLOWED_PACKAGES].join(", ")} and node builtins`;

/**
 * Source imports are limited to the allowlist plus node builtins; default
 * resolution would inline any file the server process can read. Imports
 * resolved from inside node_modules stay open so allowed packages can reach
 * their own deps.
 */
const importAllowlist: Plugin = {
  name: "import-allowlist",
  setup: function (builder): void {
    builder.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return null;
      if (args.importer.includes("node_modules")) return null;
      const bare = args.path.replace(/^node:/, "");
      // A "." or ".." segment on an allowed package (e.g. "zod/../../secret")
      // escapes node_modules and inlines arbitrary server files into the bundle.
      const traverses =
        args.path.includes("\\") ||
        args.path
          .split("/")
          .some((segment) => segment === "." || segment === "..");
      if (
        !traverses &&
        (NODE_BUILTINS.has(bare) ||
          ALLOWED_PACKAGES.has(packageRoot(args.path)))
      ) {
        return null;
      }

      return {
        errors: [
          {
            text: `import "${args.path}" is not allowed here: ${IMPORT_RULE}`,
          },
        ],
      };
    });
  },
};

export async function POST(request: Request): Promise<Response> {
  const mediaType = request.headers.get("content-type")?.split(";")[0];
  if (mediaType?.trim().toLowerCase() !== "application/json") {
    return Response.json(
      { error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  let sourceCode: unknown;
  try {
    sourceCode = ((await request.json()) as { sourceCode?: unknown })
      .sourceCode;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (typeof sourceCode !== "string" || !sourceCode.trim()) {
    return Response.json(
      { error: "sourceCode must be a non-empty string" },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(sourceCode) > MAX_SOURCE_BYTES) {
    return Response.json(
      { error: `sourceCode must be at most ${MAX_SOURCE_BYTES} bytes` },
      { status: 413 },
    );
  }

  try {
    const result = await build({
      stdin: {
        contents: sourceCode,
        resolveDir: process.cwd(),
        sourcefile: SOURCE_FILE,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      minify: false,
      write: false,
      logLevel: "silent",
      metafile: true,
      plugins: [importAllowlist],
    });
    // esbuild expands a computed import path without calling onResolve.
    const foreign = foreignInputs(result.metafile);
    if (foreign.length > 0) {
      console.warn("mcp bundle refused, inputs outside the allowlist", foreign);

      return Response.json(
        {
          error: `MCP server failed to build: import paths must be literal, ${IMPORT_RULE}`,
        },
        { status: 422 },
      );
    }
    if (result.outputFiles.length !== 1) {
      return Response.json(
        { error: "Build produced no output" },
        { status: 422 },
      );
    }

    return Response.json({ bundle: result.outputFiles[0]!.text });
  } catch (error) {
    // Messages located outside the submitted source can carry server paths.
    const details = isBuildFailure(error)
      ? error.errors
          .flatMap((entry) =>
            entry.location?.file === SOURCE_FILE
              ? [
                  `${entry.location.line}:${entry.location.column} ${entry.text}`,
                ]
              : [],
          )
          .join("; ")
      : "";

    return Response.json(
      {
        error: details
          ? `MCP server failed to build: ${details}`
          : "MCP server failed to build",
      },
      { status: 422 },
    );
  }
}

/**
 * Inputs outside the source and node_modules, plus source imports that are
 * computed paths or resolve outside the allowed packages.
 */
function foreignInputs(metafile: Metafile): string[] {
  const foreign = Object.keys(metafile.inputs).filter(
    (input) =>
      input !== SOURCE_FILE && !input.split("/").includes("node_modules"),
  );
  for (const record of metafile.inputs[SOURCE_FILE]?.imports ?? []) {
    const allowed = record.external
      ? !record.path.includes("*")
      : ALLOWED_PACKAGES.has(
          packageRoot(record.path.split("node_modules/").pop()!),
        );
    if (!allowed) foreign.push(record.path);
  }

  return foreign;
}

function isBuildFailure(error: unknown): error is BuildFailure {
  return (
    error instanceof Error && Array.isArray((error as BuildFailure).errors)
  );
}

function packageRoot(specifier: string): string {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
}
