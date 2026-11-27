import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
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
const LOGIN_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ";
const LOGIN_POLL_MS = 2000;

const DASHBOARD_LOGIN_TIMEOUT =
  "Timed out waiting for the login to be approved in the browser.\n" +
  "Run `broods login` again, open the link, and approve it while signed in as an\n" +
  "owner or admin of an organization with an active API account.";

const VALUE_OPTIONS = new Set([
  "--base-url",
  "--cwd",
  "--dashboard-url",
  "--development-branch",
  "--folder",
  "--production-branch",
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

interface LoginConfig {
  base_url: string;
}

interface LoginExchange {
  token: string;
  user?: StoredAuthConfig["user"];
  org?: StoredAuthConfig["org"];
  account?: StoredAuthConfig["account"];
}

interface CallbackOptions<T> {
  port: number;
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
    (arg): boolean =>
      arg === name || (inline !== null && arg.startsWith(inline)),
  );
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
  const dashboard = stripTrailingSlash(dashboardUrl);
  // PKCE: only this process, holding the verifier, can collect the approved login.
  // Imported from node:crypto: the bin's `node` shebang may be Node 18, with no global.
  const codeVerifier = randomBytes(32).toString("base64url");
  const code = loginCode();
  const baseUrl = await loginBaseUrl(dashboard);
  const startUrl =
    `${dashboard}/cli-auth/start?` +
    new URLSearchParams({
      code_challenge: createHash("sha256")
        .update(codeVerifier)
        .digest("base64url"),
      code: code,
      device: hostname().slice(0, 64),
    });
  console.log(`Open this link on any device to sign in:\n  ${startUrl}`);
  console.log(`Your code is ${code}`);
  openBrowser(startUrl);
  const payload = await pollLogin(baseUrl, codeVerifier);
  const auth = {
    baseUrl: baseUrl,
    dashboardUrl: dashboard,
    token: payload.token,
    createdAt: new Date().toISOString(),
    ...(payload.user ? { user: payload.user } : {}),
    ...(payload.org ? { org: payload.org } : {}),
    ...(payload.account ? { account: payload.account } : {}),
  };
  await writeStoredAuth(auth);

  return auth;
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
export async function promptSecret(
  label: string,
  options: { optional?: boolean } = {},
): Promise<string> {
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
    // An optional prompt takes an empty line as "skip"; input that ends
    // without one (Ctrl+D, Ctrl+C) still stops, so a user can always abort.
    if (!value && (!options.optional || lines.length === 0)) {
      throw new Error(`${label} is required`);
    }

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
  options.forEach((option, index): void => {
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
  options.forEach((option, index): void => {
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

// Enter keeps the `[default]`. No TTY returns the default, so CI fails on it instead of hanging.
export async function promptText(
  label: string,
  defaultValue?: string,
): Promise<string> {
  if (!input.isTTY) return defaultValue ?? "";
  const rl = createInterface({ input: input, output: output });
  try {
    const answer = (
      await rl.question(
        defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `,
      )
    ).trim();

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
  return new Promise((resolve, reject): void => {
    const server = createServer((req, res): void => {
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
    const promise = new Promise<T>((res, rej): void => {
      callbackResolve = res;
      callbackReject = rej;
    });

    server.on("error", (error: NodeJS.ErrnoException): void => {
      if (options.port !== 0 && error.code === "EADDRINUSE") {
        server.listen(0, "127.0.0.1");

        return;
      }
      reject(error);
    });
    server.listen(options.port, "127.0.0.1", (): void => {
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
        close: (): void => {
          server.close();
        },
      });
    });
  });
}

export async function waitWithTimeout<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject): void => {
    timer = setTimeout(
      (): void => reject(new Error(message)),
      LOGIN_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 8 consonants: no vowels to spell a word, none of the letters read as another.
function loginCode(): string {
  const letters = Array.from(
    randomBytes(8),
    (byte): string => LOGIN_CODE_ALPHABET[byte % LOGIN_CODE_ALPHABET.length]!,
  ).join("");

  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

// The dashboard names the API host the login is collected from and used against.
async function loginBaseUrl(dashboard: string): Promise<string> {
  const response = await cliFetch(`${dashboard}/cli-auth/config`, {
    method: "GET",
    redirect: "manual",
  });
  if (!response.ok) {
    throw new Error(
      response.status >= 500
        ? `The broods login page failed: ${response.status} ${await response.text()}`
        : `${dashboard} has no broods login page for this CLI. Check that --dashboard-url points at your broods dashboard, and that the dashboard is up to date.`,
    );
  }
  const { base_url: baseUrl } = (await response.json()) as LoginConfig;

  return stripTrailingSlash(baseUrl);
}

async function pollLogin(
  baseUrl: string,
  codeVerifier: string,
): Promise<LoginExchange> {
  const deadline = Date.now() + LOGIN_APPROVAL_TIMEOUT_MS;
  console.log("Waiting for approval in the browser...");
  while (Date.now() < deadline) {
    const response = await cliFetch(`${baseUrl}/v1/account/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code_verifier: codeVerifier }),
    });
    if (response.status === 200)
      return (await response.json()) as LoginExchange;
    if (response.status !== 202) {
      throw new Error(
        `Login failed: ${response.status} ${await response.text()}`,
      );
    }
    await new Promise(
      (resolve): void => void setTimeout(resolve, LOGIN_POLL_MS),
    );
  }
  throw new Error(DASHBOARD_LOGIN_TIMEOUT);
}
