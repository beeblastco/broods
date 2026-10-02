/**
 * Shared CLI helpers for argument parsing, local auth, and terminal IO.
 */

import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  gatewayUrlForDashboard,
  readStoredAuth,
  stripTrailingSlash,
  writeStoredAuth,
  type StoredAuthConfig,
} from "../config.ts";
import { loadBroodsRuntimeConfig } from "../runtime-config.ts";
import { formatChoiceRow } from "./output.ts";

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

/** Options whose value is a separate token, so both have to leave a prompt. */
const VALUE_OPTIONS = new Set([
  "--base-url",
  "--cwd",
  "--dashboard-url",
  "--stage",
  "--from",
  "--level",
  "--limit",
  "--mcp",
  "--project",
  "--region",
  "--sandbox",
  "-n",
]);

interface LoginCallback {
  code: string;
  baseUrl: string;
}

/**
 * The command that opens `url` in the default browser. Windows skips `cmd /c
 * start`, whose parser cuts the URL at the first `&`.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }

  return { command: "xdg-open", args: [url] };
}

/**
 * True when `name` is passed. A value option also counts as `name=value`, a
 * boolean flag only bare, so `--yes=false` never skips a confirmation.
 */
export function hasFlag(args: string[], name: string): boolean {
  const inline = VALUE_OPTIONS.has(name) ? `${name}=` : null;

  return args.some(
    (arg) => arg === name || (inline !== null && arg.startsWith(inline)),
  );
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The value of the first `name value` or `name=value`. An empty `name=` reads
 * as missing, so callers that reject a bare flag reject it too.
 */
export function optionValue(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg?.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1) || undefined;
    }
  }

  return undefined;
}

/**
 * Positional arguments only. `--project foo` puts `foo` in the list too, so
 * dropping just the flag would leave the value looking like a run prompt.
 */
export function positionalArgs(args: string[]): string[] {
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (VALUE_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }

  return positional;
}

export async function loginWithBrowser(
  dashboardUrl: string,
): Promise<StoredAuthConfig> {
  // The bin runs under a `node` shebang, and Node 18 has no global `crypto`.
  const state = randomUUID();
  // PKCE: the code that comes back through the localhost callback is only
  // exchangeable by this process, which holds the verifier.
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const { code, close } = await waitForCallback(state, {
    port: callbackPort(),
    fixedPort: Boolean(process.env.BROODS_LOGIN_PORT),
    path: "/callback",
    read: readLoginCallback,
    done: "broods CLI login complete. You can close this tab.",
  });

  try {
    const callbackUrl = code.callbackUrl;
    const startUrl =
      `${stripTrailingSlash(dashboardUrl)}/cli-auth/start?` +
      new URLSearchParams({
        callback: callbackUrl,
        state: state,
        code_challenge: codeChallenge,
      });
    await assertCliAuthRouteExists(startUrl);
    openBrowser(startUrl);
    console.log(`Opening ${startUrl}`);
    const login = await waitWithTimeout(code.promise);
    // The dashboard advertises the API base URL in the callback; the
    // exchange and all later sync/env calls go there directly.
    const response = await fetch(`${login.baseUrl}/v1/account/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: login.code, code_verifier: codeVerifier }),
    });
    if (!response.ok) {
      throw new Error(
        `Login exchange failed: ${response.status} ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as {
      token: string;
      user?: StoredAuthConfig["user"];
      org?: StoredAuthConfig["org"];
      account?: StoredAuthConfig["account"];
    };
    const auth = {
      baseUrl: login.baseUrl,
      dashboardUrl: stripTrailingSlash(dashboardUrl),
      token: payload.token,
      createdAt: new Date().toISOString(),
      ...(payload.user ? { user: payload.user } : {}),
      ...(payload.org ? { org: payload.org } : {}),
      ...(payload.account ? { account: payload.account } : {}),
    };
    await writeStoredAuth(auth);

    return auth;
  } finally {
    close();
  }
}

export async function requireAuth(baseUrl?: string): Promise<StoredAuthConfig> {
  loadBroodsRuntimeConfig();
  const auth = readStoredAuth(baseUrl);
  if (!auth) {
    const dashboardUrl = process.env.BROODS_DASHBOARD_URL;
    const server =
      baseUrl ??
      process.env.BROODS_BASE_URL ??
      (dashboardUrl ? gatewayUrlForDashboard(dashboardUrl) : undefined);
    throw new Error(
      server
        ? `Not logged in to ${stripTrailingSlash(server)}. Run \`broods login\`.`
        : "Run `broods login` first, or set BROODS_TOKEN and BROODS_BASE_URL.",
    );
  }

  return auth;
}

/**
 * Asks a yes/no question on the terminal, defaulting to no. Returns false when
 * stdin is not a TTY (e.g. CI) so non-interactive runs never block on a prompt.
 */
export async function promptConfirm(question: string): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = createInterface({ input: input, output: output });
  try {
    const answer = (await rl.question(`${question} [y/N] `))
      .trim()
      .toLowerCase();

    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function promptSecret(label: string): Promise<string> {
  const rl = createInterface({ input: input, output: output });
  try {
    const value = await rl.question(`${label}: `);
    if (!value) throw new Error(`${label} is required`);

    return value;
  } finally {
    rl.close();
  }
}

/**
 * Numbered picker. `defaultIndex` marks that option with `*` and makes an empty
 * answer pick it, so the usual case is one Enter.
 */
export async function promptSelect<T>(
  label: string,
  options: T[],
  render: (option: T) => string,
  defaultIndex?: number,
): Promise<T> {
  if (options.length === 0) throw new Error(`${label}: no options available`);
  if (options.length === 1) return options[0]!;
  const fallback =
    defaultIndex !== undefined &&
    defaultIndex >= 0 &&
    defaultIndex < options.length
      ? defaultIndex
      : undefined;

  console.log(label);
  options.forEach((option, index) => {
    console.log(
      formatChoiceRow(`${index + 1}. ${render(option)}`, index === fallback),
    );
  });

  const question =
    fallback === undefined
      ? `Choose 1-${options.length}: `
      : `Choose 1-${options.length} [${fallback + 1}]: `;
  const rl = createInterface({ input: input, output: output });
  try {
    for (;;) {
      const answer = (await rl.question(question)).trim();
      if (answer === "" && fallback !== undefined) return options[fallback]!;
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= options.length) {
        return options[index - 1]!;
      }
      console.log(`Enter a number from 1 to ${options.length}.`);
    }
  } finally {
    rl.close();
  }
}

/**
 * Numbered picker that doubles as a text field: a number picks that option,
 * empty takes `freeText.defaultValue`, anything else comes back as typed.
 */
export async function promptSelectOrText<T extends object>(
  label: string,
  options: T[],
  render: (option: T) => string,
  freeText: { hint: string; defaultValue: string },
): Promise<T | string> {
  console.log(label);
  options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${render(option)}`);
  });

  const range = options.length > 0 ? `Choose 1-${options.length}, or ` : "";
  const rl = createInterface({ input: input, output: output });
  try {
    const answer = (
      await rl.question(`${range}${freeText.hint} [${freeText.defaultValue}]: `)
    ).trim();
    if (answer === "") return freeText.defaultValue;
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return options[index - 1]!;
    }

    return answer;
  } finally {
    rl.close();
  }
}

/**
 * Free-text prompt with an editable default. Returns the default (or "") when
 * stdin is not a TTY, so a CI run errors on the missing value instead of
 * hanging on a question nobody can answer.
 */
export async function promptText(
  label: string,
  defaultValue?: string,
): Promise<string> {
  if (!input.isTTY) return defaultValue ?? "";
  const rl = createInterface({ input: input, output: output });
  try {
    const pending = rl.question(`${label}: `);
    if (defaultValue) {
      if (input.isTTY && output.isTTY) output.write("\x1b[90m");
      rl.write(defaultValue);
      if (input.isTTY && output.isTTY) output.write("\x1b[0m");
    }
    const answer = (await pending).trim();

    return answer || defaultValue || "";
  } finally {
    rl.close();
  }
}

async function assertCliAuthRouteExists(startUrl: string): Promise<void> {
  const response = await fetch(startUrl, {
    method: "GET",
    redirect: "manual",
  });
  if (response.status === 404) {
    const url = new URL(startUrl);
    throw new Error(
      `${url.origin} does not expose /cli-auth/start yet. Deploy the dashboard changes first, ` +
        `or use --dashboard-url http://localhost:3000 with a local dashboard dev server.`,
    );
  }
  if (response.status >= 500) {
    throw new Error(
      `Dashboard CLI auth route failed: ${response.status} ${await response.text()}`,
    );
  }
}

function readLoginCallback(params: URLSearchParams): LoginCallback {
  const code = params.get("code");
  if (!code) throw new Error("Login callback carried no code.");
  const baseUrl = params.get("base_url");
  if (!baseUrl) {
    throw new Error(
      "Login callback did not advertise the API base URL (base_url). " +
        "Deploy a dashboard build that includes the Convex-direct CLI auth flow.",
    );
  }

  return { code: code, baseUrl: stripTrailingSlash(baseUrl) };
}

function callbackPort(): number {
  const raw = process.env.BROODS_LOGIN_PORT;
  if (raw) {
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    throw new Error("BROODS_LOGIN_PORT must be a TCP port number");
  }

  return 18987;
}

export function openBrowser(url: string): void {
  const { command, args } = browserCommand(url);
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

interface CallbackOptions<T> {
  /** Preferred port; a busy one falls back to any free port unless `fixedPort`. */
  port: number;
  fixedPort: boolean;
  path: string;
  /** Turns the callback query into its result; a throw fails the login. */
  read: (params: URLSearchParams) => T;
  /** What the browser tab shows once `read` succeeds. */
  done: string;
}

/**
 * Listens on 127.0.0.1 for one OAuth-style browser redirect carrying
 * `expectedState`. A redirect with any other state is refused and ignored,
 * so a stray tab cannot end the login.
 */
export function waitForCallback<T>(
  expectedState: string,
  options: CallbackOptions<T>,
): Promise<{
  code: { callbackUrl: string; promise: Promise<T> };
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (
        url.pathname !== options.path ||
        url.searchParams.get("state") !== expectedState
      ) {
        res.writeHead(400).end("Invalid login callback.");

        return;
      }
      try {
        const result = options.read(url.searchParams);
        res.writeHead(200, { "Content-Type": "text/plain" }).end(options.done);
        callbackResolve(result);
      } catch (error) {
        res
          .writeHead(400, { "Content-Type": "text/plain" })
          .end(error instanceof Error ? error.message : String(error));
        callbackReject(error);
      }
    });

    let callbackResolve!: (callback: T) => void;
    let callbackReject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      callbackResolve = res;
      callbackReject = rej;
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (
        !options.fixedPort &&
        options.port !== 0 &&
        error.code === "EADDRINUSE"
      ) {
        server.listen(0, "127.0.0.1");

        return;
      }
      reject(error);
    });
    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate callback port"));

        return;
      }
      resolve({
        code: {
          callbackUrl: `http://127.0.0.1:${address.port}${options.path}`,
          promise: promise,
        },
        close: () => server.close(),
      });
    });
  });
}

const DASHBOARD_LOGIN_TIMEOUT =
  "Timed out waiting for browser login to complete.\n" +
  "Check the browser tab and the dashboard logs for an error. If the browser shows\n" +
  "404 on /cli-auth/start, deploy the dashboard build that includes CLI auth or pass\n" +
  "--dashboard-url for the environment you deployed. Other common causes are missing\n" +
  "cliAuth Convex functions or no active API account (Settings -> API Access).";

/**
 * Race a promise against a timeout so a stalled browser login surfaces an
 * actionable error instead of hanging the CLI forever. For `broods login` the
 * most common cause is the dashboard's cliAuth Convex functions not being
 * deployed in the target stage, which makes /cli-auth/start return a 500 in
 * the browser and never redirect back to the local callback.
 */
export async function waitWithTimeout<T>(
  promise: Promise<T>,
  message: string = DASHBOARD_LOGIN_TIMEOUT,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), LOGIN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
