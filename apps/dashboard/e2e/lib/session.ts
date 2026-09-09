/**
 * Shared pieces of the signed-in browser suites (`app`, `perf`): the server
 * under test, the probe account from the environment, the hosted AuthKit
 * sign-in, and the project the suites drive. `auth.setup.ts` signs in once
 * and saves the browser state plus the project id; every spec starts from
 * those files.
 */
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Next reads .env.local for the app; Playwright does not, so the E2E_* values
// kept there (by scripts/setup-dashboard-e2e.sh) are loaded here, before
// anything below reads the environment. Absent in CI, where the workflow
// sets the environment.
try {
  process.loadEnvFile(join(__dirname, "..", "..", ".env.local"));
} catch {
  // No local env file: the suites read whatever the shell provides.
}

export const DEV_URL = "http://localhost:3000";
export const BASE_URL = process.env.E2E_BASE_URL ?? DEV_URL;
export const AUTH_DIR = join(__dirname, "..", ".auth");
export const STORAGE_STATE = join(AUTH_DIR, "session.json");
export const PROJECT_FILE = join(AUTH_DIR, "project.txt");
export const MISSING_PROBE =
  "E2E_EMAIL and E2E_PASSWORD pick the probe account; E2E_BASE_URL the server (default http://localhost:3000)";
/** ReactFlow's viewport: on the page once the canvas has mounted. */
export const CANVAS_READY = ".react-flow__viewport";
/** A fresh browser context that is already signed in. */
export const SIGNED_IN_CONTEXT = {
  baseURL: BASE_URL,
  storageState: STORAGE_STATE,
};
export const probeAccount = {
  email: process.env.E2E_EMAIL,
  password: process.env.E2E_PASSWORD,
  projectId: process.env.E2E_PROJECT_ID,
};

const AUTH_TIMEOUT_MS = 60_000;
// Convex document ids; `/projects` and the other static segments are shorter.
const PROJECT_PATH = /^\/([a-z0-9]{20,})$/;

export function hasProbe(): boolean {
  return Boolean(probeAccount.email && probeAccount.password);
}

/** The project id `auth.setup.ts` resolved for this run. */
export function readProjectId(): string {
  return readFileSync(PROJECT_FILE, "utf8").trim();
}

/**
 * The project the suites drive: `E2E_PROJECT_ID`, else the one the home
 * route opens. Sign-in usually lands there already. A brand-new probe
 * account gets provisioned on its first visit and lands on the empty
 * projects page; the next visit creates the default project, so two visits
 * cover a fresh account with no manual setup.
 */
export async function resolveProjectId(page: Page): Promise<string> {
  if (probeAccount.projectId) return probeAccount.projectId;

  for (let visit = 0; visit < 3; visit++) {
    const match = new URL(page.url()).pathname.match(PROJECT_PATH);
    if (match) return match[1];
    await page.goto("/");
    await page.waitForURL((url) => url.pathname !== "/", {
      timeout: AUTH_TIMEOUT_MS,
    });
  }

  throw new Error(
    "The probe account has no project and the home route did not create one",
  );
}

/** Drive the hosted AuthKit sign-in form until the app is back on its own origin. */
export async function signIn(page: Page): Promise<void> {
  const origin = new URL(BASE_URL).origin;
  await page.goto("/");
  await page.waitForURL((url) => url.origin !== origin, {
    timeout: AUTH_TIMEOUT_MS,
  });
  await page.getByLabel(/email/i).fill(probeAccount.email!);
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel(/password/i).fill(probeAccount.password!);
  await page.getByRole("button", { name: /continue|sign in/i }).click();
  await page.waitForURL((url) => url.origin === origin, {
    timeout: AUTH_TIMEOUT_MS,
  });
}
