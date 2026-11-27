export interface TwinFault {
  name: string;
  twin: string;
  file: string;
  find: string;
  replace: string;
  cwd: string;
  tests: readonly string[];
}

const CONTINUATION = "apps/core/src/harness/continuation.ts";
const PASSES = `${CONTINUATION}#runParentPasses`;
const PASS_TESTS = ["tests/continuation.test.ts", "tests/ingress.test.ts"];

function passFault(name: string, find: string, replace: string): TwinFault {
  return {
    name: name,
    twin: PASSES,
    file: CONTINUATION,
    find: find,
    replace: replace,
    cwd: "apps/core",
    tests: PASS_TESTS,
  };
}

// One plausible bug per entry, in a function a traced twin claims to represent.
export const FAULTS: readonly TwinFault[] = [
  passFault(
    "a failed pass counts as success",
    "if (stream.didFail()) {",
    "if (!stream.didFail()) {",
  ),
  passFault(
    "questions are ignored",
    "if (questions.length > 0) {",
    "if (questions.length < 0) {",
  ),
  passFault(
    "a yielded pass does not resume",
    "if (stream.yielded()) {",
    "if (false as boolean) {",
  ),
  passFault(
    "hooks are not attached",
    "options.subagentCoordinator.attachHooks(hooks);",
    "",
  ),
  passFault(
    "a stream is not consumed",
    "await options.consumeStream(stream);",
    "",
  ),
  {
    name: "a refreshed credential is never stored",
    twin: "apps/core/src/harness/sandbox/machine-executor.ts#refreshCredential",
    file: "apps/core/src/harness/sandbox/machine-executor.ts",
    find: "socket.data.authorization = authorization;",
    replace: "void authorization;",
    cwd: "apps/core",
    tests: ["tests/machine-expiry.test.ts"],
  },
  {
    name: "a released worker forgets its tenant",
    twin: "apps/core/src/harness/isolate/executor.ts#releaseWorker",
    file: "apps/core/src/harness/isolate/executor.ts",
    find: "if (worker.alive) worker.tenants.add(tenantId);",
    replace: "void tenantId;",
    cwd: "apps/core",
    tests: ["tests/isolate-executor.test.ts"],
  },
];
