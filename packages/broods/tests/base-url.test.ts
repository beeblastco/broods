import { afterEach, expect, test } from "bun:test";
import { readStoredAuth } from "../src/config.ts";

const savedEnv = {
  BROODS_TOKEN: process.env.BROODS_TOKEN,
  BROODS_DASHBOARD_URL: process.env.BROODS_DASHBOARD_URL,
  BROODS_BASE_URL: process.env.BROODS_BASE_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("BROODS_BASE_URL with BROODS_TOKEN yields env auth carrying the Convex URL", async () => {
  delete process.env.BROODS_DASHBOARD_URL;
  process.env.BROODS_TOKEN = "tok";
  process.env.BROODS_BASE_URL = "https://convex.example.com/";

  const auth = await readStoredAuth();

  expect(auth).toMatchObject({
    baseUrl: "https://convex.example.com",
    token: "tok",
  });
  expect(auth?.dashboardUrl).toBeUndefined();
});

test("BROODS_DASHBOARD_URL without BROODS_BASE_URL does not authenticate from env", async () => {
  delete process.env.BROODS_BASE_URL;
  process.env.BROODS_TOKEN = "tok";
  process.env.BROODS_DASHBOARD_URL = "https://dashboard.example.com";

  const auth = await readStoredAuth();

  expect(auth).toBeNull();
});
