import { Buffer } from "node:buffer";
import type { SandboxJobCallback, SandboxJobStatus } from "./types.ts";
import { shellQuote } from "./utils.ts";

const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";

export interface LaunchOptions {
  maxConcurrentJobs: number;
  callback?: SandboxJobCallback;
}

// The token rides the launching exec's env, never the script text.
export function callbackEnv(
  callback: SandboxJobCallback | undefined,
): Record<string, string> {
  return callback ? { __CB_TOKEN: callback.token } : {};
}

// python3 ships in every sandbox image; a failed POST is swallowed and async_status still polls.
export function callbackSnippet(
  callback: SandboxJobCallback,
  logFile: string,
): string {
  const env = [
    `__CB_URL=${shellQuote(callback.url)}`,
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

export function generateJobId(): string {
  return `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// The boot id in `.running` lets a poll tell a live job from one lost to a sandbox recreate.
export function launchScript(
  jobsDir: string,
  jobId: string,
  workDir: string,
  code: string,
  options: LaunchOptions,
): string {
  assertSafeJobId(jobId);
  const q = shellQuote;
  const f = (ext: string): string => q(`${jobsDir}/${jobId}.${ext}`);
  const wrapper = [
    `echo $$ > ${f("pid")}`,
    `cd ${q(workDir)}`,
    `{\n${code}\n} > ${f("log")} 2>&1`,
    `__rc=$?`,
    `echo $__rc > ${f("exit")}`,
    ...(options.callback
      ? [callbackSnippet(options.callback, `${jobsDir}/${jobId}.log`)]
      : []),
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

export function lifecycleScript(
  workDir: string,
  onCreate?: string[],
  onResume?: string[],
): string | undefined {
  if (!onCreate?.length && !onResume?.length) return undefined;
  const marker = shellQuote(`${workDir}/.fp-setup-done`);
  // Runs sharing a machine run onCreate once; a lock held 10 minutes was left by a killed run.
  const lock = shellQuote(`${workDir}/.fp-setup-lock`);

  return [
    "set -e",
    `mkdir -p ${shellQuote(workDir)}`,
    `cd ${shellQuote(workDir)}`,
    ...(onCreate?.length
      ? [
          `if [ ! -f ${marker} ]; then`,
          "  __waited=0",
          `  until mkdir ${lock} 2>/dev/null; do`,
          '    if [ "$__waited" -ge 600 ]; then break; fi',
          "    sleep 1",
          "    __waited=$((__waited + 1))",
          "  done",
          `  trap 'rmdir ${lock} 2>/dev/null' EXIT`,
          `  if [ ! -f ${marker} ]; then`,
          ...onCreate,
          `    touch ${marker}`,
          "  fi",
          `  rmdir ${lock} 2>/dev/null || true`,
          "  trap - EXIT",
          "fi",
        ]
      : []),
    ...(onResume ?? []),
  ].join("\n");
}

export function logsScript(
  jobsDir: string,
  jobId: string,
  bytes: number,
): string {
  assertSafeJobId(jobId);

  return `tail -c ${bytes} ${shellQuote(`${jobsDir}/${jobId}.log`)} 2>/dev/null || true`;
}

export function parseJobStatus(
  jobId: string,
  stdout: string,
): SandboxJobStatus {
  const text = stdout.trim();
  if (text.startsWith("done")) {
    const code = Number(text.split(/\s+/)[1]);
    const exitCode = Number.isFinite(code) ? code : null;

    return {
      jobId: jobId,
      state: exitCode === 0 ? "completed" : "failed",
      exitCode: exitCode,
    };
  }

  return { jobId: jobId, state: text === "running" ? "running" : "unknown" };
}

export function statusScript(jobsDir: string, jobId: string): string {
  assertSafeJobId(jobId);
  const f = (ext: string): string => shellQuote(`${jobsDir}/${jobId}.${ext}`);

  // A boot-id mismatch (sandbox recreated) or a dead pid with no exit means the job was killed.
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

export function stopScript(jobsDir: string, jobId: string): string {
  assertSafeJobId(jobId);
  const f = (ext: string): string => shellQuote(`${jobsDir}/${jobId}.${ext}`);

  return [
    `if [ -f ${f("pid")} ]; then kill -TERM -"$(cat ${f("pid")})" 2>/dev/null || true; sleep 1; kill -KILL -"$(cat ${f("pid")})" 2>/dev/null || true; fi`,
    `[ -f ${f("exit")} ] || echo 143 > ${f("exit")}`,
    `rm -f ${f("running")}`,
  ].join("; ");
}

function assertSafeJobId(jobId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error(`Invalid job id: ${jobId}`);
  }
}
