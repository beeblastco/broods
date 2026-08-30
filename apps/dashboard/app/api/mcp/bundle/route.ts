/**
 * Bundles dashboard-authored MCP server source with the same esbuild flags
 * the CLI uses at deploy; validation, upload and the sandboxed probe live in
 * the Convex mcp service. AuthKit's proxy gates this path. Source imports are
 * limited to the packages the editor promises plus node builtins — default
 * resolution would otherwise inline any file the server process can read.
 */
import type { BuildFailure, Plugin } from "esbuild";
import { build } from "esbuild";
import { builtinModules } from "node:module";

const MAX_SOURCE_BYTES = 512 * 1024;
const ALLOWED_PACKAGES = new Set(["@modelcontextprotocol/server", "zod"]);
const NODE_BUILTINS = new Set(builtinModules);

export async function POST(request: Request): Promise<Response> {
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
        sourcefile: "mcp-server.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      minify: false,
      write: false,
      logLevel: "silent",
      plugins: [importAllowlist],
    });
    if (result.outputFiles.length !== 1) {
      return Response.json(
        { error: "Build produced no output" },
        { status: 422 },
      );
    }

    return Response.json({ bundle: result.outputFiles[0]!.text });
  } catch (error) {
    const details = isBuildFailure(error)
      ? error.errors
          .map((entry) => entry.text)
          .filter(Boolean)
          .join("; ")
      : error instanceof Error
        ? error.message
        : String(error);

    return Response.json(
      { error: `MCP server failed to build: ${details}` },
      { status: 422 },
    );
  }
}

/**
 * Refuses source imports outside the allowlist. Imports resolved from inside
 * node_modules stay open so allowed packages can reach their own deps.
 */
const importAllowlist: Plugin = {
  name: "import-allowlist",
  setup: function (builder): void {
    builder.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return null;
      if (args.importer.includes("node_modules")) return null;
      const bare = args.path.replace(/^node:/, "");
      const packageRoot = args.path.startsWith("@")
        ? args.path.split("/").slice(0, 2).join("/")
        : args.path.split("/")[0]!;
      if (NODE_BUILTINS.has(bare) || ALLOWED_PACKAGES.has(packageRoot)) {
        return null;
      }

      return {
        errors: [
          {
            text: `import "${args.path}" is not allowed here: hosted MCP source may import ${[...ALLOWED_PACKAGES].join(", ")} and node builtins`,
          },
        ],
      };
    });
  },
};

function isBuildFailure(error: unknown): error is BuildFailure {
  return (
    error instanceof Error && Array.isArray((error as BuildFailure).errors)
  );
}
