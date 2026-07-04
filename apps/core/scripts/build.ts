/**
 * Builds the self-hosted core server binary — the same entry the container runs
 * (apps/core/Dockerfile). Compiles at the host's default target; the Docker
 * build compiles at the amd64 cluster target.
 */

import { $ } from "bun";
import { syncSystemPromptModule } from "./system-prompt.ts";

await $`rm -rf dist`;
await syncSystemPromptModule();

console.log("Building core server...");
await $`bun build --compile --minify src/server.ts --outfile dist/core-server`;
console.log("Core server built at dist/core-server.");
