// The dashboard's Apply: `broods deploy` on approved files, in a compile sandbox, never in core.
// Convex calls it in-cluster; the gateway marks proxied calls, which never pass.

import { SHELL_ONLY_SANDBOX_PROVIDERS } from "@broods/convex/model/sandboxProviders";
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
// Under Linux's 128 KiB cap on one argv string: providers pass the script as `bash -c`.
const SCRIPT_BYTES = 96_000;
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
  if (SHELL_ONLY_SANDBOX_PROVIDERS.has(sandbox.provider))
    return errorResponse(
      503,
      "APPLY_SANDBOX needs a sandbox that runs bun, not a shell-only one",
    );
  const startedAt = Date.now();
  const config = {
    ...sandbox,
    // One warm sandbox per stage and lockfile: its node_modules are the install cache, and
    // writes split across scripts land on one disk.
    persistent: true,
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
  };
  const result = await runScripts(config, applyScripts(run));
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

async function runScripts(
  config: Parameters<typeof runSandbox>[0],
  scripts: readonly string[],
): ReturnType<typeof runSandbox> {
  for (const script of scripts.slice(0, -1)) {
    const written = await runSandbox(config, undefined, script);
    if (!written.ok) return written;
  }

  return await runSandbox(config, undefined, scripts.at(-1) ?? "");
}

// Only what the files replace is removed, so node_modules survives as the next install's cache.
// The sandbox is reserved, so writes split across scripts land on one disk; the last deploys.
function applyScripts(run: ApplyRun): string[] {
  const head = [
    "set -e",
    "T0=$(date +%s%3N)",
    'mkdir -p "$HOME/broods-apply" && cd "$HOME/broods-apply"',
  ];
  const batches: string[][] = [
    [...head, "rm -rf broods package.json bun.lock"],
  ];
  for (const write of run.files.flatMap(fileWrites)) {
    const batch = batches.at(-1) ?? [];
    if (batch.join("\n").length + write.length > SCRIPT_BYTES)
      batches.push([...head, write]);
    else batch.push(write);
  }
  const phase = (name: string): string =>
    `echo "::phase ${name} $(( $(date +%s%3N) - T0 ))"`;
  const deploy = [
    'export PATH="$HOME/.bun/bin:$PATH" BROODS_BASE_URL="$APPLY_BASE_URL"',
    "command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1",
    phase("files"),
    "if [ -f bun.lock ]; then bun install --frozen-lockfile >/dev/null; else bun install >/dev/null; fi",
    phase("install"),
    'bunx broods deploy --base-url "$BROODS_BASE_URL" --project "$BROODS_PROJECT" --stage "$BROODS_STAGE" --prune',
    phase("deploy"),
  ];

  return batches.map((batch, index) =>
    [...batch, ...(index === batches.length - 1 ? deploy : [])].join("\n"),
  );
}

// A file too big for one script is appended in base64 chunks, each decoding on its own.
function fileWrites(file: { path: string; content: string }): string[] {
  const q = shellQuote(`./${toWorkspaceRelative(file.path)}`);
  const encoded = toBase64(file.content);
  const size = SCRIPT_BYTES - 1000 - (SCRIPT_BYTES % 4);
  const chunks: string[] = [];
  for (let at = 0; at < encoded.length || at === 0; at += size)
    chunks.push(encoded.slice(at, at + size));

  return chunks.map(
    (chunk, index) =>
      `${index === 0 ? `mkdir -p "$(dirname ${q})" && ` : ""}printf '%s' ${shellQuote(chunk)} | base64 -d ${index === 0 ? ">" : ">>"} ${q}`,
  );
}
