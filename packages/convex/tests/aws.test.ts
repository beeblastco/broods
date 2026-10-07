import { afterEach, expect, test, vi } from "vitest";
import { s3Client } from "../model/aws";

afterEach(() => {
  vi.unstubAllEnvs();
});

// R2 brings its own keys and region.
test("a bucket with its own region needs no AWS configuration", async () => {
  vi.stubEnv("AWS_REGION", "");
  const client = await s3Client({
    region: "auto",
    credentials: {
      accessKeyId: "key",
      secretAccessKey: "secret",
      sessionToken: "session",
    },
  });

  expect(await client.config.region()).toBe("auto");
});
