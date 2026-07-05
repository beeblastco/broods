import { afterEach, expect, test } from "bun:test";
import { controlUrlFromAuth, readStoredAuth } from "../src/config.ts";

const savedEnv = {
  BROODS_TOKEN: process.env.BROODS_TOKEN,
  BROODS_DASHBOARD_URL: process.env.BROODS_DASHBOARD_URL,
  BROODS_CONTROL_URL: process.env.BROODS_CONTROL_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("controlUrlFromAuth prefers the stored control URL", () => {
  const url = controlUrlFromAuth({
    dashboardUrl: "https://dashboard.example.com",
    controlUrl: "https://control.example.com/",
  });

  expect(url).toBe("https://control.example.com");
});

test("controlUrlFromAuth falls back to the dashboard for legacy auth without controlUrl", () => {
  const url = controlUrlFromAuth({ dashboardUrl: "https://dashboard.example.com/" });

  expect(url).toBe("https://dashboard.example.com");
});

test("BROODS_CONTROL_URL with BROODS_TOKEN yields env auth carrying the control URL", async () => {
  delete process.env.BROODS_DASHBOARD_URL;
  process.env.BROODS_TOKEN = "tok";
  process.env.BROODS_CONTROL_URL = "https://control.example.com";

  const auth = await readStoredAuth();

  expect(auth?.token).toBe("tok");
  expect(auth?.controlUrl).toBe("https://control.example.com");
  expect(controlUrlFromAuth(auth!)).toBe("https://control.example.com");
});

test("BROODS_DASHBOARD_URL env auth still works without a control URL", async () => {
  delete process.env.BROODS_CONTROL_URL;
  process.env.BROODS_TOKEN = "tok";
  process.env.BROODS_DASHBOARD_URL = "https://dashboard.example.com";

  const auth = await readStoredAuth();

  expect(auth?.controlUrl).toBeUndefined();
  expect(controlUrlFromAuth(auth!)).toBe("https://dashboard.example.com");
});
