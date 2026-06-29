/**
 * Shell script builders shared by the persistent executors that use POSIX shell
 * state for detached background jobs and onCreate/onResume lifecycle hooks.
 * Job state lives in marker files under `jobsDir`:
 * `<id>.running` (live; holds the launching boot id), `.log` (output), `.exit`
 * (code), `.pid` (session leader, for stop).
 */

import { Buffer } from "node:buffer";
import type { SandboxJobCallback, SandboxJobStatus } from "./types.ts";
import { shellQuote } from "./utils.ts";

const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";

export interface LaunchOptions {
  // Reject the launch once this many jobs are already running in the sandbox.
  maxConcurrentJobs: number;
  // Optional completion callback the job POSTs when it exits.
  callback?: SandboxJobCallback;
}

export function generateJobId(): string {
  return `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Job ids land inside shell-quoted file paths; reject anything that could
// traverse out of jobsDir.
function assertSafeJobId(jobId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error(`Invalid job id: ${jobId}`);
  }
}

/**
 * onCreate/onResume hook script for providers without native lifecycle
 * callbacks (daytona/sandbox; vercel uses the SDK's own hooks).
 * onCreate runs once, guarded by a marker file in the workDir; onResume runs on
 * every acquisition. Returns undefined when no hooks are configured.
 */
export function lifecycleScript(workDir: string, onCreate?: string[], onResume?: string[]): string | undefined {
  if (!onCreate?.length && !onResume?.length) return undefined;
  const marker = `${workDir}/.fp-setup-done`;
  return [
    "set -e",
    `mkdir -p ${shellQuote(workDir)}`,
    `cd ${shellQuote(workDir)}`,
    ...(onCreate?.length
      ? [
          `if [ ! -f ${shellQuote(marker)} ]; then`,
          ...onCreate,
          `  touch ${shellQuote(marker)}`,
          "fi",
        ]
      : []),
    ...(onResume ?? []),
  ].join("\n");
}

/**
 * Launch `code` as a detached session. The wrapper is base64-encoded so the
 * user's code passes through the shell untouched. Stamps the marker with the
 * current boot id so a later poll can tell "still running" from "killed when the
 * sandbox was recreated". Exits non-zero (caller throws) if the job cap is hit.
 */
export function launchScript(jobsDir: string, jobId: string, workDir: string, code: string, options: LaunchOptions): string {
  assertSafeJobId(jobId);
  const q = shellQuote;
  const f = (ext: string) => q(`${jobsDir}/${jobId}.${ext}`);
  const wrapper = [
    `echo $$ > ${f("pid")}`,
    `cd ${q(workDir)}`,
    `{\n${code}\n} > ${f("log")} 2>&1`,
    `__rc=$?`,
    `echo $__rc > ${f("exit")}`,
    ...(options.callback ? [callbackSnippet(options.callback, `${jobsDir}/${jobId}.log`)] : []),
    `rm -f ${f("running")}`,
  ].join("\n");
  const wrapperB64 = Buffer.from(wrapper, "utf8").toString("base64");
  return [
    `mkdir -p ${q(jobsDir)}`,
    `__running=$(ls ${q(jobsDir)}/*.running 2>/dev/null | wc -l)`,
    `if [ "$__running" -ge ${options.maxConcurrentJobs} ]; then echo "background job limit reached (${options.maxConcurrentJobs} concurrent)" >&2; exit 1; fi`,
    `cat ${q(BOOT_ID_FILE)} > ${f("running")} 2>/dev/null || : > ${f("running")}`,
    `setsid bash -c "$(printf %s ${q(wrapperB64)} | base64 -d)" < /dev/null > /dev/null 2>&1 &`,
  ].join("\n");
}

export function statusScript(jobsDir: string, jobId: string): string {
  assertSafeJobId(jobId);
  const f = (ext: string) => shellQuote(`${jobsDir}/${jobId}.${ext}`);
  // Exit recorded => terminal. Otherwise the job is "running" only if it was
  // launched in this boot AND its session leader is still alive; a boot-id
  // mismatch (sandbox recreated) or a dead pid with no exit means it was killed.
  return [
    `if [ -f ${f("exit")} ]; then echo "done $(cat ${f("exit")})";`,
    `elif [ -f ${f("running")} ]; then`,
    `  stored=$(cat ${f("running")} 2>/dev/null);`,
    `  current=$(cat ${shellQuote(BOOT_ID_FILE)} 2>/dev/null);`,
    `  if [ -n "$current" ] && [ -n "$stored" ] && [ "$stored" != "$current" ]; then echo "done 137";`,
    `  elif [ -f ${f("pid")} ] && kill -0 "$(cat ${f("pid")})" 2>/dev/null; then echo running;`,
    `  elif [ -f ${f("pid")} ]; then echo "done 137";`,
    `  else echo running; fi;`,
    `else echo unknown; fi`,
  ].join("\n");
}

export function logsScript(jobsDir: string, jobId: string, bytes: number): string {
  assertSafeJobId(jobId);
  return `tail -c ${bytes} ${shellQuote(`${jobsDir}/${jobId}.log`)} 2>/dev/null || true`;
}

export function stopScript(jobsDir: string, jobId: string): string {
  assertSafeJobId(jobId);
  const f = (ext: string) => shellQuote(`${jobsDir}/${jobId}.${ext}`);
  return [
    `if [ -f ${f("pid")} ]; then kill -TERM -"$(cat ${f("pid")})" 2>/dev/null || true; sleep 1; kill -KILL -"$(cat ${f("pid")})" 2>/dev/null || true; fi`,
    `[ -f ${f("exit")} ] || echo 143 > ${f("exit")}`,
    `rm -f ${f("running")}`,
  ].join("; ");
}

export function parseJobStatus(jobId: string, stdout: string): SandboxJobStatus {
  const text = stdout.trim();
  if (text.startsWith("done")) {
    const code = Number(text.split(/\s+/)[1]);
    const exitCode = Number.isFinite(code) ? code : null;
    return { jobId, state: exitCode === 0 ? "completed" : "failed", exitCode };
  }
  return { jobId, state: text === "running" ? "running" : "unknown" };
}

// POSTs the job's outcome back to the harness so the conversation resumes without
// the model having to poll. python3 is on PATH in every sandbox image; failures
// (no egress, no python) are swallowed and the model can still poll async_status.
export function callbackSnippet(callback: SandboxJobCallback, logFile: string): string {
  const env = [
    `__CB_URL=${shellQuote(callback.url)}`,
    `__CB_TOKEN=${shellQuote(callback.token)}`,
    `__CB_LOG=${shellQuote(logFile)}`,
    `__CB_CODE="$__rc"`,
  ].join(" ");
  const py = [
    `import json,os,urllib.request`,
    `code=os.environ.get("__CB_CODE","")`,
    `try:`,
    `    with open(os.environ["__CB_LOG"],"rb") as fh: logs=fh.read()[-32768:].decode("utf-8","replace")`,
    `except Exception: logs=""`,
    `try: ec=int(code)`,
    `except Exception: ec=None`,
    `ok = code=="0"`,
    `body={"status":"completed" if ok else "failed","response":{"exitCode":ec,"logs":logs}}`,
    `if not ok: body["error"]="Background job exited with code %s\\n%s"%(code,logs)`,
    `req=urllib.request.Request(os.environ["__CB_URL"],data=json.dumps(body).encode("utf-8"),method="POST",headers={"Content-Type":"application/json","x-job-token":os.environ["__CB_TOKEN"]})`,
    `try: urllib.request.urlopen(req,timeout=15)`,
    `except Exception: pass`,
  ].join("\n");
  return `${env} python3 - <<'__FPCB__' >/dev/null 2>&1 || true\n${py}\n__FPCB__`;
}
