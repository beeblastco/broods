import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Playwright does not read .env.local as Next does; without one (CI) the shell's env stands.
try {
  process.loadEnvFile(join(__dirname, "..", "..", ".env.local"));
} catch {}

// next dev reads PORT too, so a worktree's suite never tests the main checkout's server.
export const DEV_PORT = process.env.PORT ?? "3000";
export const DEV_URL = `http://localhost:${DEV_PORT}`;
export const BASE_URL = process.env.E2E_BASE_URL || DEV_URL;
export const AUTH_DIR = join(__dirname, "..", ".auth");
export const STORAGE_STATE = join(AUTH_DIR, "session.json");
export const PROJECT_FILE = join(AUTH_DIR, "project.txt");
export const MISSING_PROBE =
  "E2E_EMAIL and E2E_PASSWORD pick the probe account, or E2E_ADMIN_KEY a self-hosted stack's admin; E2E_BASE_URL the server (default http://localhost:3000)";
// CI runners sometimes catch a second canvas in the DOM: take the first visible one.
export const CANVAS_READY = ".react-flow__viewport >> visible=true >> nth=0";
export const SIGNED_IN_CONTEXT = {
  baseURL: BASE_URL,
  storageState: STORAGE_STATE,
};
export const probeAccount = {
  adminKey: process.env.E2E_ADMIN_KEY,
  email: process.env.E2E_EMAIL,
  password: process.env.E2E_PASSWORD,
  projectId: process.env.E2E_PROJECT_ID,
};

const AUTH_TIMEOUT_MS = 60_000;
// Convex ids are 20+ characters; `/projects` and the other static segments are shorter.
const PROJECT_PATH = /^\/([a-z0-9]{20,})$/;

export function hasProbe(): boolean {
  return Boolean(
    probeAccount.adminKey || (probeAccount.email && probeAccount.password),
  );
}

export function readProjectId(): string {
  return readFileSync(PROJECT_FILE, "utf8").trim();
}

// A fresh account is provisioned on one visit and gets its default project on the next.
export async function resolveProjectId(page: Page): Promise<string> {
  if (probeAccount.projectId) return probeAccount.projectId;

  for (let visit = 0; visit < 3; visit++) {
    const match = new URL(page.url()).pathname.match(PROJECT_PATH);
    if (match) return match[1];
    // /projects first: on a PR the dev backend may lack the functions the home route calls.
    await page.goto("/projects");
    const card = page
      .getByRole("button", { name: /^Open (?!Next\.js Dev Tools)/ })
      .first();
    const empty = page.getByText("No projects yet");
    await card.or(empty).first().waitFor({ timeout: AUTH_TIMEOUT_MS });
    if (await card.isVisible()) {
      // A click before hydration does nothing, so click until the project opens.
      await expect(async () => {
        await card.click();
        await page.waitForURL((url) => PROJECT_PATH.test(url.pathname), {
          timeout: 5_000,
        });
      }).toPass({ timeout: AUTH_TIMEOUT_MS });
      continue;
    }
    await page.goto("/");
    await page.waitForURL(
      (url) => PROJECT_PATH.test(url.pathname) || url.pathname === "/projects",
      { timeout: AUTH_TIMEOUT_MS },
    );
  }

  throw new Error(
    "The probe account has no project and the home route did not create one",
  );
}

export async function signIn(page: Page): Promise<void> {
  const origin = new URL(BASE_URL).origin;
  await page.goto("/");
  if (probeAccount.adminKey) {
    await page.getByLabel("Admin key").fill(probeAccount.adminKey);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/"), {
      timeout: AUTH_TIMEOUT_MS,
    });
    return;
  }
  await page.waitForURL((url) => url.origin !== origin, {
    timeout: AUTH_TIMEOUT_MS,
  });
  await page.getByLabel(/email/i).fill(probeAccount.email!);
  await page.getByRole("button", { name: /continue/i }).click();
  await page
    .getByRole("textbox", { name: /password/i })
    .fill(probeAccount.password!);
  // Exact name: production AuthKit also offers "Sign in with passkey".
  await page.getByRole("button", { name: /^(continue|sign in)$/i }).click();
  await page
    .waitForURL((url) => url.origin === origin, { timeout: AUTH_TIMEOUT_MS })
    .catch(async (error: unknown) => {
      // CI keeps no page snapshot (it would record the password), so name the bot check.
      if (await page.getByText(/sure you are human/i).isVisible()) {
        throw new Error(
          "AuthKit showed the probe its bot check: allow the probe email under Radar > Restrictions in this WorkOS environment",
          { cause: error },
        );
      }
      throw error;
    });
}
