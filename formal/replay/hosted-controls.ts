import { spawnSync } from "node:child_process";
import { suite } from "./suites/hosted.ts";

let caught = 0;
for (let index = -1; index < suite.mutations.length; index += 1) {
  const run = spawnSync(
    "bun",
    ["test", "--preload", "./formal/replay/hosted-preload.ts", ...suite.tests],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SPEC_SUITE: "hosted",
        SPEC_MUTATION: index < 0 ? "" : String(index),
      },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const output = run.stdout + run.stderr;
  if (output.includes("no longer matches")) throw new Error(output);
  if (index < 0) {
    if (run.status !== 0) throw new Error(output);
    console.log("baseline passed");
  } else {
    const failed = Number(/(\d+) fail\b/.exec(output)?.[1] ?? 0);
    if (failed > 0) caught += 1;
    console.log(
      `${failed > 0 ? "caught" : "SURVIVED"}: ${suite.mutations[index]?.name}`,
    );
  }
}
console.log(`${caught}/${suite.mutations.length} faults caught`);
if (caught !== suite.mutations.length) process.exit(1);
