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

const DASHBOARD_LOGIN_TIMEOUT =
  "Timed out waiting for browser login to complete.\n" +
  "Check the browser tab and the dashboard logs for an error. If the browser shows\n" +
  "404 on /cli-auth/start, deploy the dashboard build that includes CLI auth or pass\n" +
  "--dashboard-url for the environment you deployed. Other common causes are missing\n" +
  "cliAuth Convex functions or no active API account (Organization settings -> API access).";

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

interface CallbackOptions<T> {
  port: number;
  fixedPort: boolean;
  path: string;
  read: (params: URLSearchParams) => T;
  done: string;
}

export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    // Not `cmd /c start`: its parser cuts the URL at the first `&`.
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }

  return { command: "xdg-open", args: [url] };
}

/** A boolean flag matches only bare, so `--yes=false` never skips a confirmation. */
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
  // Imported from node:crypto: the bin's `node` shebang may be Node 18, with no global.
  const state = randomUUID();
  // PKCE: only this process, holding the verifier, can exchange the callback's code.
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
    console.log(`Opening ${startUrl}`);
    openBrowser(startUrl);
    const login = await waitWithTimeout(code.promise);
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
 * A TTY gives one line, a pipe every line to its end (a PEM key). Iterated, not
 * `rl.question`: a question never settles when input ends first (Ctrl+D).
 */
export async function promptSecret(label: string): Promise<string> {
  output.write(`${label}: `);
  const muted = new Writable({
    write: (_chunk, _encoding, callback): void => callback(),
  });
  const terminal = input.isTTY === true;
  const rl = createInterface({
    input: input,
    output: muted,
    terminal: terminal,
    // A CRLF split across two pipe chunks is one line break, however late the LF.
    crlfDelay: Infinity,
  });
  try {
    const lines: string[] = [];
    for await (const line of rl) {
      lines.push(line);
      if (terminal) break;
    }
    const value = lines.join("\n");
    if (!value) throw new Error(`${label} is required`);

    return value;
  } finally {
    rl.close();
    output.write("\n");
  }
}

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

export function openBrowser(url: string): void {
  const { command, args } = browserCommand(url);
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", (error): void => {
    console.error(
      formatWarning(
        `Could not open a browser (${error.message}). Open the URL above to continue.`,
        { stream: "stderr" },
      ),
    );
  });
  child.unref();
}

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
        res.writeHead(400).end("Invalid callback.");

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

function readLoginCallback(params: URLSearchParams): LoginCallback {
  const failure = params.get("error");
  if (failure) throw new Error(`Login failed: ${failure}`);
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
