import { $ } from "bun";
import { syncCompactionPromptModule } from "./compaction-prompt.ts";

await $`rm -rf dist`;
await syncCompactionPromptModule();

console.log("Building core server...");
await $`bun build --compile --minify src/server.ts --outfile dist/core-server`;
console.log("Core server built at dist/core-server.");
