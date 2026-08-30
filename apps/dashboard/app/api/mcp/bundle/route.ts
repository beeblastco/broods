/**
 * Bundles dashboard-authored MCP server source with the same esbuild flags
 * the CLI uses at deploy; validation, upload and the sandboxed probe live in
 * the Convex mcpService. AuthKit's proxy gates this path.
 */
import { build } from "esbuild";

const MAX_SOURCE_BYTES = 512 * 1024;

interface EsbuildFailure {
  errors: Array<{ text: string }>;
}

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
  if (new TextEncoder().encode(sourceCode).byteLength > MAX_SOURCE_BYTES) {
    return Response.json(
      { error: `sourceCode must be at most ${MAX_SOURCE_BYTES} bytes` },
      { status: 413 },
    );
  }

  try {
    const result = await build({
      stdin: {
        contents: sourceCode,
        // Resolves against the dashboard's node_modules: pinned deps only.
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
    });
    if (result.outputFiles.length !== 1) {
      return Response.json(
        { error: "Build produced no output" },
        { status: 422 },
      );
    }

    return Response.json({ bundle: result.outputFiles[0]!.text });
  } catch (error) {
    const failure = error as Partial<EsbuildFailure>;
    const details = Array.isArray(failure.errors)
      ? failure.errors
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
