const RUNTIME_ENTRY = new URL("../src/runtime.ts", import.meta.url).pathname;
const OUTPUT = new URL("../.generated/runtime.txt", import.meta.url).pathname;

export async function buildRuntime(): Promise<string> {
  const build = await Bun.build({
    entrypoints: [RUNTIME_ENTRY],
    format: "esm",
    target: "browser",
    minify: true,
    external: ["cloudflare:workers"],
    // workerd provides node:zlib under nodejs_compat.
    plugins: [
      {
        name: "keep-node-zlib",
        setup: function (build): void {
          build.onResolve(
            { filter: /^node:zlib$/ },
            (args): { path: string; external: boolean } => ({
              path: args.path,
              external: true,
            }),
          );
        },
      },
    ],
  });
  if (!build.success) {
    throw new Error(build.logs.map((log): string => log.message).join("\n"));
  }
  const text = await build.outputs[0]!.text();
  await Bun.write(OUTPUT, text);

  return text;
}

if (import.meta.main) {
  const text = await buildRuntime();
  console.log(`runtime: ${(text.length / 1024).toFixed(0)} KiB -> ${OUTPUT}`);
}
