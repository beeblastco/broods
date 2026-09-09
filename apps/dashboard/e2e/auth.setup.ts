/**
 * Signs in the probe account once and saves the browser state and the
 * project id for the `app` and `perf` suites. Skips without the account.
 */
import { test as setup } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  AUTH_DIR,
  hasProbe,
  MISSING_PROBE,
  PROJECT_FILE,
  resolveProjectId,
  signIn,
  STORAGE_STATE,
} from "./lib/session";

setup.skip(!hasProbe(), MISSING_PROBE);

setup("sign in as the probe account", async ({ page }) => {
  await signIn(page);
  const projectId = await resolveProjectId(page);
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(PROJECT_FILE, projectId);
  await page.context().storageState({ path: STORAGE_STATE });
});
