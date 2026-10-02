/**
 * Shared CLI helpers for argument parsing, local auth, and terminal IO.
 */

import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";
import {
  gatewayUrlForDashboard,
  readStoredAuth,
  stripTrailingSlash,
  writeStoredAuth,
  type StoredAuthConfig,
} from "../config.ts";
import { loadBroodsRuntimeConfig } from "../runtime-config.ts";
import { cliFetch } from "../sync.ts";
import { formatChoiceRow, formatWarning } from "./output.ts";

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
  const { code, close } = await waitForCallback(state);

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
    // Printed first, so a machine with no browser still has the link.
    console.log(`Opening ${startUrl}`);
    openBrowser(startUrl);
    const login = await waitWithTimeout(code.promise, LOGIN_TIMEOUT_MS);
    // The dashboard advertises the API base URL in the callback; the
    // exchange and all later sync/env calls go there directly.
    const response = await cliFetch(
      `${login.baseUrl}/v1/account/auth/exchange`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: login.code, code_verifier: codeVerifier }),
      },
    );
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

/**
 * Reads a secret without echoing it: readline still edits the line, but writes
 * every keystroke to a stream that drops it.
 */
export async function promptSecret(label: string): Promise<string> {
  output.write(`${label}: `);
  const muted = new Writable({
    write: (_chunk, _encoding, callback): void => callback(),
  });
  const rl = createInterface({
    input: input,
    output: muted,
    terminal: input.isTTY === true,
  });
  try {
    const value = await rl.question("");
    if (!value) throw new Error(`${label} is required`);

    return value;
  } finally {
    rl.close();
    output.write("\n");
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
  const response = await cliFetch(startUrl, {
    method: "GET",
    redirect: "manual",
  });
  if (response.status === 404) {
    const url = new URL(startUrl);
    throw new Error(
      `${url.origin} has no broods login page. Check that --dashboard-url points at your broods dashboard.`,
    );
  }
  if (response.status >= 500) {
    throw new Error(
      `The broods login page failed: ${response.status} ${await response.text()}`,
    );
  }
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

/** Best effort: with no browser launcher (SSH, containers) the printed URL is the way in. */
function openBrowser(url: string): void {
  const { command, args } = browserCommand(url);
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", (error) => {
    console.error(
      formatWarning(
        `Could not open a browser (${error.message}). Open the URL above to log in.`,
        { stream: "stderr" },
      ),
    );
  });
  child.unref();
}

function waitForCallback(expectedState: string): Promise<{
  code: { callbackUrl: string; promise: Promise<LoginCallback> };
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const baseUrl = url.searchParams.get("base_url");
        // The dashboard sends `error` instead of a code when it cannot log in.
        const failure = url.searchParams.get("error");
        if (state === expectedState && failure) {
          res
            .writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
            .end(`broods CLI login failed: ${failure}`);
          callbackReject(new Error(`Login failed: ${failure}`));

          return;
        }
        if (state !== expectedState || !code) {
          res.writeHead(400).end("Invalid broods login callback.");

          return;
        }
        if (!baseUrl) {
          res
            .writeHead(400)
            .end(
              "Login failed: the dashboard did not say which broods server to use.",
            );
          callbackReject(
            new Error(
              "Login failed: the dashboard did not say which broods server to use (base_url). " +
                "It is likely older than this CLI.",
            ),
          );

          return;
        }
        res
          .writeHead(200, { "Content-Type": "text/plain" })
          .end("broods CLI login complete. You can close this tab.");
        callbackResolve({
          code: code,
          baseUrl: stripTrailingSlash(baseUrl),
        });
      } catch (error) {
        callbackReject(error);
      }
    });

    let callbackResolve!: (callback: LoginCallback) => void;
    let callbackReject!: (error: unknown) => void;
    const promise = new Promise<LoginCallback>((res, rej) => {
      callbackResolve = res;
      callbackReject = rej;
    });

    const requestedPort = callbackPort();
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (
        !process.env.BROODS_LOGIN_PORT &&
        requestedPort !== 0 &&
        error.code === "EADDRINUSE"
      ) {
        server.listen(0, "127.0.0.1");

        return;
      }
      reject(error);
    });
    server.listen(requestedPort, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate callback port"));

        return;
      }
      resolve({
        code: {
          callbackUrl: `http://127.0.0.1:${address.port}/callback`,
          promise: promise,
        },
        close: () => server.close(),
      });
    });
  });
}

/**
 * Race a promise against a timeout so a browser login that never comes back
 * (tab closed, dashboard error page) surfaces an error instead of hanging the
 * CLI forever.
 */
async function waitWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            "Timed out waiting for the browser login to finish.\n" +
              "Check the browser tab for an error, then run `broods login` again.",
          ),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
