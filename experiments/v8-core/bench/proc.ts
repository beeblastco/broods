/**
 * CPU and memory of a process: from /proc on Linux, children that exited included; from ps on
 * macOS, the process alone (the bench's processes start no children worth counting).
 */

import { readFileSync } from "node:fs";

const TICK_MS = 1000 / 100;

export interface ProcSample {
  cpuMs: number;
  rssMb: number;
}

/** ps's cumulative CPU time, [[dd-]hh:]mm:ss.cc, in ms. */
function psTimeMs(text: string): number {
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = clock!.split(":").map(Number);

  return (
    (Number(days) * 86_400 +
      parts.reduce((total, part) => total * 60 + part, 0)) *
    1000
  );
}

function samplePs(pid: number): ProcSample {
  const result = Bun.spawnSync({
    cmd: ["ps", "-o", "rss=,time=", "-p", String(pid)],
  });
  const [rssKb, time] = result.stdout.toString().trim().split(/\s+/);
  if (result.exitCode !== 0 || !time) throw new Error(`no process ${pid}`);

  return { cpuMs: psTimeMs(time), rssMb: Number(rssKb) / 1024 };
}

export function sample(pid: number): ProcSample {
  if (process.platform === "darwin") return samplePs(pid);
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // utime, stime, cutime, cstime are fields 14-17 (1-based); after the comm they start at index 11.
  const ticks = [11, 12, 13, 14].reduce((sum, i) => sum + Number(fields[i]), 0);
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);

  return { cpuMs: ticks * TICK_MS, rssMb: rssKb / 1024 };
}

/** Samples RSS every interval until stopped; returns the peak. */
export function watchPeak(pids: number[], intervalMs = 100): () => number {
  let peak = 0;
  const timer = setInterval(() => {
    let total = 0;
    for (const pid of pids) {
      try {
        total += sample(pid).rssMb;
      } catch {
        // process gone
      }
    }
    peak = Math.max(peak, total);
  }, intervalMs);

  return () => {
    clearInterval(timer);

    return peak;
  };
}

/** Like sample, but a process that is gone (crashed or restarted) reads as NaN. */
export function sampleOrNaN(pid: number): ProcSample {
  try {
    return sample(pid);
  } catch {
    return { cpuMs: Number.NaN, rssMb: Number.NaN };
  }
}

/** sample() summed over several processes (the engines of one runtime). */
export function sampleSum(pids: number[]): ProcSample {
  return pids.map(sample).reduce(
    (total, one) => ({
      cpuMs: total.cpuMs + one.cpuMs,
      rssMb: total.rssMb + one.rssMb,
    }),
    { cpuMs: 0, rssMb: 0 },
  );
}
