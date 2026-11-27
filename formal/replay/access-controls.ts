import { spawnSync } from "node:child_process";
import { suite } from "./suites/access.ts";

let caught = 0;
for (let index = -1; index < suite.mutations.length; index += 1) {
  const result = spawnSync(
    "bun",
    ["test", "--preload", "./formal/replay/access-preload.ts", ...suite.tests],
    {
      cwd: `${import.meta.dir}/../..`,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        ...suite.env,
        SPEC_MUTATION: index < 0 ? "" : String(index),
      },
    },
  );
  const output = result.stdout + result.stderr;
  const passed = Number(/(\d+) pass\b/.exec(output)?.[1] ?? 0);
  const failed = Number(/(\d+) fail\b/.exec(output)?.[1] ?? 0);
  if (
    output.includes("no longer matches") ||
    passed + failed === 0 ||
    (index < 0 && result.status !== 0)
  )
    throw new Error(output);
  if (index < 0) console.log(`baseline ${passed} pass`);
  else {
    if (failed > 0) caught += 1;
    console.log(
      `${failed > 0 ? "caught" : "SURVIVED"}: ${suite.mutations[index]!.name}`,
    );
  }
}
console.log(`${caught}/${suite.mutations.length} faults caught`);
if (caught !== suite.mutations.length) process.exit(1);
