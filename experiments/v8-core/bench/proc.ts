/** CPU and memory of a process from /proc, children that exited included. */

import { readFileSync } from "node:fs";

const TICK_MS = 1000 / 100;

export interface ProcSample {
  cpuMs: number;
  rssMb: number;
}

export function sample(pid: number): ProcSample {
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
