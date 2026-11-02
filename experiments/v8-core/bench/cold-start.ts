/**
 * Start-up cost of one request on each runtime: sequential GET /healthz,
 * timed from the client, with the server process's CPU and memory read from
 * /proc around the whole series. On the per-task router every request loads
 * core into a brand-new isolate, so its numbers are the cold start of the
 * "one isolate per task" model; on Bun and on long-lived workerd they are a
 * warm request.
 *
 * bun cold-start.ts --url http://127.0.0.1:4321 --pid N --count 30 --label isolate
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { sample } from "./proc.ts";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    pid: { type: "string" },
    count: { type: "string", default: "30" },
    label: { type: "string" },
    out: { type: "string" },
  },
});
const pid = Number(args.pid);
const count = Number(args.count);
const times: number[] = [];
const isolates = new Set<string>();
const before = sample(pid);
for (let i = 0; i < count; i++) {
  const started = performance.now();
  const response = await fetch(`${args.url}/healthz`);
  const body = await response.text();
  times.push(performance.now() - started);
  if (response.status !== 200 || !body.includes("ok"))
    throw new Error(`healthz ${response.status}: ${body}`);
  const isolate = response.headers.get("x-isolate");
  if (isolate) isolates.add(isolate);
}
// Let the runtime finish any work the last request left behind before reading CPU.
await Bun.sleep(1000);
const after = sample(pid);
const sorted = [...times].sort((a, b) => a - b);
const row = {
  label: args.label,
  count: count,
  distinctIsolates: isolates.size,
  p50Ms: sorted[Math.floor(count / 2)],
  p95Ms: sorted[Math.min(count - 1, Math.floor(count * 0.95))],
  minMs: sorted[0],
  maxMs: sorted.at(-1),
  cpuMsPerRequest: (after.cpuMs - before.cpuMs) / count,
  rssBeforeMb: before.rssMb,
  rssAfterMb: after.rssMb,
  rssPerRequestMb: (after.rssMb - before.rssMb) / count,
};
console.log(JSON.stringify(row));
if (args.out) appendFileSync(args.out, `${JSON.stringify(row)}\n`);
