/**
 * The sandbox on its own, without core or a model: the same two commands the
 * complex task runs, on the V8 sandbox Worker (just-bash in a Dynamic Worker)
 * and on this machine's real bash. Each V8 call uses a new sandbox id, the way
 * core calls it when no workspace is attached, so every call loads a fresh
 * isolate; the "reused" series sends a trivial command to one id over and over.
 * CPU is read from /proc for the sandbox's processes around each series.
 *
 * bun sandbox-probe.ts --url http://127.0.0.1:8790 --key-file F --pids a,b --count 20
 */

import { readFileSync, appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { sample } from "./proc.ts";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    "key-file": { type: "string" },
    pids: { type: "string" },
    count: { type: "string", default: "20" },
    out: { type: "string" },
  },
});
const key = readFileSync(args["key-file"]!, "utf8").trim();
const pids = args.pids!.split(",").map(Number);
const count = Number(args.count);
const dir = "/tmp/probe";
const PRIMES = [
  `mkdir -p ${dir} && cat > ${dir}/primes.sh <<'SH'`,
  "awk 'BEGIN{n=30000; for(i=2;i<n;i++)s[i]=1; for(i=2;i*i<n;i++) if(s[i]) for(j=i*i;j<n;j+=i) s[j]=0; for(i=2;i<n;i++) if(s[i]) print i}'",
  "SH",
  `bash ${dir}/primes.sh > ${dir}/primes.txt; wc -l < ${dir}/primes.txt; tail -1 ${dir}/primes.txt`,
].join("\n");
const NOTES = `mkdir -p ${dir}/notes && printf 'Workers Paid CPU limit: 300000 ms\\n' > ${dir}/notes/limits.md && sha256sum ${dir}/notes/limits.md`;

const cpu = (list: number[]): number =>
  list.reduce((s, pid) => s + sample(pid).cpuMs, 0);
const rss = (list: number[]): number =>
  list.reduce((s, pid) => s + sample(pid).rssMb, 0);

async function v8(id: string, script: string): Promise<string> {
  const response = await fetch(`${args.url}/v1/sandboxes/${id}/exec`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      script: script,
      args: [],
      cwd: "/workspace",
      env: {},
      timeoutMs: 60_000,
      outputLimitBytes: 65_536,
      enableInternet: false,
      persist: false,
    }),
  });
  const body = (await response.json()) as {
    stdout?: string;
    exit_code?: number;
  };
  if (response.status !== 200 || body.exit_code !== 0)
    throw new Error(
      `v8 exec ${response.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );

  return body.stdout ?? "";
}

function native(script: string): string {
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", script],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`native: ${result.stderr.toString()}`);

  return result.stdout.toString();
}

async function series(
  label: string,
  run: (i: number) => Promise<string> | string,
  cpuPids: number[],
  check: RegExp,
) {
  if (only && !label.startsWith(only)) return;
  const times: number[] = [];
  const cpuBefore = cpuPids.length ? cpu(cpuPids) : 0;
  const rssBefore = cpuPids.length ? rss(cpuPids) : 0;
  // Native bash runs as a child of this process: /proc counts reaped children in cutime/cstime.
  const selfBefore = sample(process.pid).cpuMs;
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    const out = await run(i);
    times.push(performance.now() - started);
    if (!check.test(out)) throw new Error(`${label}: unexpected output ${out}`);
  }
  await Bun.sleep(500);
  const self = sample(process.pid).cpuMs - selfBefore;
  const sorted = [...times].sort((a, b) => a - b);
  const row = {
    label: label,
    count: count,
    p50Ms: sorted[Math.floor(count / 2)],
    p95Ms: sorted[Math.min(count - 1, Math.floor(count * 0.95))],
    cpuMsPerCall: cpuPids.length
      ? (cpu(cpuPids) - cpuBefore) / count
      : self / count,
    rssGrowthMb: cpuPids.length ? rss(cpuPids) - rssBefore : 0,
  };
  console.log(JSON.stringify(row));
  if (args.out) appendFileSync(args.out, `${JSON.stringify(row)}\n`);
}

const run = Date.now().toString(36);
const only = process.env.PROBE_ONLY;
const primesOk = /^3245\n29989\n$/;
const shaOk = /^[0-9a-f]{64} /;
await series("native bash: primes", () => native(PRIMES), [], primesOk);
await series("native bash: notes + sha256", () => native(NOTES), [], shaOk);
await series(
  "v8 sandbox: primes, fresh isolate",
  (i) => v8(`probe-${run}-p-${i}`, PRIMES),
  pids,
  primesOk,
);
await series(
  "v8 sandbox: notes + sha256, fresh isolate",
  (i) => v8(`probe-${run}-n-${i}`, NOTES),
  pids,
  shaOk,
);
await series(
  "v8 sandbox: echo, fresh isolate",
  (i) => v8(`probe-${run}-e-${i}`, "echo ok"),
  pids,
  /^ok\n$/,
);
await series(
  "v8 sandbox: echo, same isolate",
  () => v8(`probe-${run}-same`, "echo ok"),
  pids,
  /^ok\n$/,
);
await series(
  "v8 sandbox: primes, same isolate",
  () => v8(`probe-${run}-same`, PRIMES),
  pids,
  primesOk,
);
