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
