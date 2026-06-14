/**
 * Shared CLI helpers for argument parsing, local auth, and terminal IO.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readStoredAuth, stripTrailingSlash, writeStoredAuth, type StoredAuthConfig } from "../config.ts";
import { loadFilthyPantyRuntimeConfig } from "../runtime-config.ts";

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

export function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export async function requireAuth(dashboardUrl?: string): Promise<StoredAuthConfig> {
  loadFilthyPantyRuntimeConfig();
  const auth = await readStoredAuth();
  if (!auth) {
    throw new Error("Run `filthy-panty login` first, or set FILTHY_PANTY_TOKEN and FILTHY_PANTY_DASHBOARD_URL.");
  }
  return dashboardUrl ? { ...auth, dashboardUrl: dashboardUrl } : auth;
}

export async function promptSecret(label: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question(`${label}: `);
    if (!value) throw new Error(`${label} is required`);
    return value;
  } finally {
    rl.close();
  }
}

/**
 * Asks a yes/no question on the terminal, defaulting to no. Returns false when
 * stdin is not a TTY (e.g. CI) so non-interactive runs never block on a prompt.
 */
export async function promptConfirm(question: string): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function loginWithBrowser(dashboardUrl: string): Promise<StoredAuthConfig> {
  const state = crypto.randomUUID();
  const { code, close } = await waitForCallback(state);

  try {
    const callbackUrl = code.callbackUrl;
    const startUrl = `${stripTrailingSlash(dashboardUrl)}/cli-auth/start?` +
      new URLSearchParams({ callback: callbackUrl, state: state });
    await assertCliAuthRouteExists(startUrl);
    openBrowser(startUrl);
    console.log(`Opening ${startUrl}`);
    const loginCode = await waitWithTimeout(code.promise, LOGIN_TIMEOUT_MS);
    const response = await fetch(`${stripTrailingSlash(dashboardUrl)}/api/cli/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: loginCode }),
    });
    if (!response.ok) {
      throw new Error(`Login exchange failed: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json() as {
      token: string;
      user?: StoredAuthConfig["user"];
      org?: StoredAuthConfig["org"];
      account?: StoredAuthConfig["account"];
    };
    const auth = {
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
    throw new Error(`Dashboard CLI auth route failed: ${response.status} ${await response.text()}`);
  }
}

function waitForCallback(expectedState: string): Promise<{
  code: { callbackUrl: string; promise: Promise<string> };
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (state !== expectedState || !code) {
          res.writeHead(400).end("Invalid filthy-panty login callback.");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" }).end("filthy-panty CLI login complete. You can close this tab.");
        callbackResolve(code);
      } catch (error) {
        callbackReject(error);
      }
    });

    let callbackResolve!: (code: string) => void;
    let callbackReject!: (error: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
      callbackResolve = res;
      callbackReject = rej;
    });

    const requestedPort = callbackPort();
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (!process.env.FILTHY_PANTY_LOGIN_PORT && requestedPort !== 0 && error.code === "EADDRINUSE") {
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
 * Race a promise against a timeout so a stalled browser login surfaces an
 * actionable error instead of hanging the CLI forever. The most common cause is
 * the dashboard's cliAuth Convex functions not being deployed in the target
 * environment, which makes /cli-auth/start return a 500 in the browser and never
 * redirect back to the local callback.
 */
async function waitWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(
        "Timed out waiting for browser login to complete.\n" +
        "Check the browser tab and the dashboard logs for an error. If the browser shows\n" +
        "404 on /cli-auth/start, deploy the dashboard build that includes CLI auth or pass\n" +
        "--dashboard-url for the environment you deployed. Other common causes are missing\n" +
        "cliAuth Convex functions or no active API account (Settings -> API Access).",
      )),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function callbackPort(): number {
  const raw = process.env.FILTHY_PANTY_LOGIN_PORT;
  if (raw) {
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    throw new Error("FILTHY_PANTY_LOGIN_PORT must be a TCP port number");
  }

  return 18987;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}
