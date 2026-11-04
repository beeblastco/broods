// The dashboard's Apply: `broods deploy` on approved files, in a compile sandbox, never in core.
// Convex calls it in-cluster; the gateway marks proxied calls, which never pass.

import { normalizeSandboxConfig } from "@broods/convex/model/sandboxRules";
import { z } from "zod";
import { extractBearerToken, isServiceToken } from "../shared/auth.ts";
import { getHarnessPublicUrl, optionalEnv } from "../shared/env.ts";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  type CoreRequest,
} from "../shared/http.ts";
import { normalizeFilesystemNamespace } from "../shared/runtime-keys.ts";
import { resolveSandboxSpecs } from "../shared/sandbox-sizes.ts";
import { shellQuote } from "./sandbox/utils.ts";
import {
  runSandbox,
  toBase64,
  toWorkspaceRelative,
} from "./tools/filesystem-utils.ts";

export const APPLY_RUN_PATH = "/v1/apply-runs";

const OUTPUT_TAIL = 4000;
const PHASE_LINE = /^::phase (\w+) (\d+)$/;

const applyRunSchema = z.object({
  accountId: z.string(),
  projectId: z.string(),
  stageId: z.string(),
  project: z.string(),
  stage: z.string(),
  ticket: z.string().startsWith("bdap_"),
  lockHash: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});

type ApplyRun = z.infer<typeof applyRunSchema>;

/** `POST /v1/apply-runs`: the deploy's exit, its output tail and each phase's time. */
export async function handleApplyRunRequest(
  request: CoreRequest,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const token = extractBearerToken(request.headers.authorization);
  if (!token || !isServiceToken(request.headers, token))
    return errorResponse(401, "Unauthorized");
  const sandboxJson = optionalEnv("APPLY_SANDBOX");
  const baseUrl = getHarnessPublicUrl();
  if (!sandboxJson || !baseUrl)
    return errorResponse(
      503,
      "Apply needs APPLY_SANDBOX and PUBLIC_BASE_URL on core",
    );
  const parsed = applyRunSchema.safeParse(JSON.parse(request.body));
  if (!parsed.success) return errorResponse(400, "Invalid apply run");
  const run = parsed.data;
  const sandbox = normalizeSandboxConfig(JSON.parse(sandboxJson));
  const startedAt = Date.now();
  const result = await runSandbox(
    {
      ...sandbox,
      // One warm sandbox per stage and lockfile: its node_modules are the install cache.
      options: {
        ...sandbox.options,
        reservationKey: normalizeFilesystemNamespace(
          `apply:${run.accountId}:${run.stageId}:${run.lockHash}`,
        ),
      },
      envVars: {
        ...sandbox.envVars,
        BROODS_TOKEN: run.ticket,
        // BROODS_BASE_URL is a reserved sandbox name, dropped from env; the script sets it.
        APPLY_BASE_URL: baseUrl,
        BROODS_PROJECT: run.project,
        BROODS_STAGE: run.stage,
        CI: "true",
      },
      controlPlane: {
        accountId: run.accountId,
        projectId: run.projectId,
        stageId: run.stageId,
        name: "apply",
        specs: resolveSandboxSpecs({
          provider: sandbox.provider,
          size: sandbox.size,
        }),
      },
    },
    undefined,
    applyScript(run),
  );
  const lines = `${result.stdout}\n${result.stderr}`.split("\n");
  const phases = Object.fromEntries(
    lines.flatMap((line): [string, number][] => {
      const match = PHASE_LINE.exec(line.trim());

      return match?.[1] && match[2] ? [[match[1], Number(match[2])]] : [];
    }),
  );

  return jsonResponse(200, {
    ok: result.ok,
    exitCode: result.exitCode ?? null,
    durationMs: Date.now() - startedAt,
    phases: phases,
    output: lines
      .filter((line) => !PHASE_LINE.test(line.trim()))
      .join("\n")
      .trim()
      .slice(-OUTPUT_TAIL),
  });
}

// Only what the files replace is removed, so node_modules survives as the next install's cache.
function applyScript(run: ApplyRun): string {
  const writes = run.files.map((file) => {
    const q = shellQuote(`./${toWorkspaceRelative(file.path)}`);

    return `mkdir -p "$(dirname ${q})" && printf '%s' ${shellQuote(toBase64(file.content))} | base64 -d > ${q}`;
  });
  const phase = (name: string): string =>
    `echo "::phase ${name} $(( $(date +%s%3N) - T0 ))"`;

  return [
    "set -e",
    "T0=$(date +%s%3N)",
    'mkdir -p "$HOME/broods-apply" && cd "$HOME/broods-apply"',
    "rm -rf broods package.json bun.lock",
    ...writes,
    'export PATH="$HOME/.bun/bin:$PATH" BROODS_BASE_URL="$APPLY_BASE_URL"',
    "command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1",
    phase("files"),
    "if [ -f bun.lock ]; then bun install --frozen-lockfile >/dev/null; else bun install >/dev/null; fi",
    phase("install"),
    'bunx broods deploy --base-url "$BROODS_BASE_URL" --project "$BROODS_PROJECT" --stage "$BROODS_STAGE" --prune',
    phase("deploy"),
  ].join("\n");
}
