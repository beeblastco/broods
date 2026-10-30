/**
 * The `broods machine` daemon in its own process, so the machine sandbox's CPU
 * (its own and every bash it runs) can be read from /proc apart from the bench.
 * Env: BENCH_ACCOUNT_SECRET, BENCH_MACHINE_NAME, BENCH_EDGE_URL.
 */

import { runMachineDaemon } from "../../../packages/broods/src/cli/machine.ts";

const name = process.env.BENCH_MACHINE_NAME!;
await runMachineDaemon({
  baseUrl: process.env.BENCH_EDGE_URL!,
  computer: false,
  credential: async () => process.env.BENCH_ACCOUNT_SECRET!,
  cwd: process.env.BENCH_MACHINE_CWD ?? "/tmp",
  log: (line: string) => console.log(line),
  sandbox: name,
  signal: new AbortController().signal,
});
