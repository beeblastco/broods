/**
 * One cold `compileProject` of the fixture project in a fresh process, which
 * is what every `broods dev`, `deploy` and `run` pays before it talks to the
 * stage. Spawned by bench/cases/cli.ts; prints nothing on success.
 */

import { compileProject } from "../../packages/broods/src/manifest.ts";

const compiled = await compileProject({
  cwd: process.argv[2],
  project: "bench",
  command: "dev",
  stage: "development",
  useRuntimeStage: false,
});
if (compiled.manifest.resources.length === 0) {
  throw new Error("fixture project compiled to no resources");
}
