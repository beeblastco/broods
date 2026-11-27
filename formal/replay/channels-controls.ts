import { spawnSync } from "node:child_process";
import { suite } from "./suites/channels.ts";

let caught = 0;
for (const index of [-1, ...suite.mutations.map((_, index): number => index)]) {
  const env = { ...process.env };
  delete env.CHANNELS_FAULT;
  if (index >= 0) env.CHANNELS_FAULT = String(index);
  const result = spawnSync("bun", ["test", ...suite.tests], {
    env: env,
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
  const output = result.stdout + result.stderr;
  if (index === -1) {
    if (result.status !== 0 || !/\d+ pass/.test(output))
      throw new Error(output);
  } else {
    if (output.includes("fault no longer matches")) throw new Error(output);
    const failed = Number(/(\d+) fail\b/.exec(output)?.[1] ?? 0);
    if (failed > 0) caught += 1;
    console.log(
      `${failed > 0 ? "caught" : "SURVIVED"}: ${suite.mutations[index]?.name}`,
    );
  }
}
console.log(`${caught}/${suite.mutations.length} faults caught`);
if (caught !== suite.mutations.length) process.exit(1);
