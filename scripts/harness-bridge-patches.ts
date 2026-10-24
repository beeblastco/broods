/**
 * Re-cuts the root `patches/` for the AI SDK harness adapters that start a
 * bridge. Each adapter reads its bridge files with
 * `new URL("./bridge/<file>", import.meta.url)`, which `bun build --compile`
 * does not embed, so the patch turns them into `with { type: "file" }` imports.
 * It also adds back `dist/bridge/pnpm-lock.yaml` when upstream ships none, since
 * the bootstrap still runs `pnpm install --frozen-lockfile`.
 * Run after bumping an adapter: `bun scripts/harness-bridge-patches.ts`, then
 * `bun install` and `bun run format`.
 */

import { $ } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ADAPTERS = [
  "@ai-sdk/harness-claude-code",
  "@ai-sdk/harness-codex",
  "@ai-sdk/harness-deepagents",
  "@ai-sdk/harness-opencode",
];
const BRIDGE_ASSET = /new URL\("\.\/bridge\/([^"]+)", import\.meta\.url\)/g;

interface PackageJson {
  dependencies: Record<string, string>;
  patchedDependencies?: Record<string, string>;
}

const core: PackageJson = await Bun.file(
  join(ROOT, "apps/core/package.json"),
).json();
const root: PackageJson = await Bun.file(join(ROOT, "package.json")).json();
const patched: Record<string, string> = {};
for (const [key, path] of Object.entries(root.patchedDependencies ?? {})) {
  if (!ADAPTERS.some((name) => key.startsWith(`${name}@`))) patched[key] = path;
}
for (const name of ADAPTERS) {
  const version = core.dependencies[name];
  if (!version) throw new Error(`apps/core does not depend on ${name}`);
  const path = `patches/${name.replaceAll("/", "%2F")}@${version}.patch`;
  await Bun.write(join(ROOT, path), await adapterPatch(name, version));
  patched[`${name}@${version}`] = path;
  console.log(`${name}@${version}: ${path}`);
}
for (const file of await readdir(join(ROOT, "patches"))) {
  if (
    file.endsWith(".patch") &&
    !Object.values(patched).includes(`patches/${file}`)
  ) {
    await rm(join(ROOT, "patches", file));
  }
}
root.patchedDependencies = patched;
await Bun.write(
  join(ROOT, "package.json"),
  `${JSON.stringify(root, null, 2)}\n`,
);

/** Diffs one pristine adapter tarball against its embedded, lockfile-complete copy. */
async function adapterPatch(name: string, version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-bridge-"));
  try {
    await $`npm pack --silent ${name}@${version} && tar -xzf *.tgz`
      .cwd(dir)
      .quiet();
    const pkg = join(dir, "package");
    await $`git init -q && git add -A && git -c user.name=patch -c user.email=patch@localhost commit -qm pristine`
      .cwd(pkg)
      .quiet();
    const bridge = join(pkg, "dist/bridge");
    if (!(await Bun.file(join(bridge, "pnpm-lock.yaml")).exists())) {
      await $`bunx pnpm@10 install --lockfile-only --ignore-scripts`
        .cwd(bridge)
        .quiet();
    }
    const index = join(pkg, "dist/index.js");
    await Bun.write(index, embedBridgeAssets(await Bun.file(index).text()));
    const diff = await $`git add -A && git diff --cached --full-index`
      .cwd(pkg)
      .quiet();

    return diff.stdout.toString();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Rewrites each bridge `new URL(...)` into an embedded file import. */
function embedBridgeAssets(source: string): string {
  const imports: string[] = [];
  const rewritten = source.replace(BRIDGE_ASSET, (_match, file: string) => {
    const binding = `bridgeAsset${imports.length}`;
    imports.push(
      `import ${binding} from "./bridge/${file}" with { type: "file" };`,
    );

    return binding;
  });
  if (imports.length === 0) throw new Error("no bridge assets to embed");

  return `${imports.join("\n")}\n${rewritten}`;
}
