/**
 * Shared HTTP helper tests: outbound URL validation for user-configured
 * webhook targets.
 */

import { describe, expect, it } from "bun:test";
import { assertPublicHttpsUrl } from "../functions/_shared/http.ts";

describe("assertPublicHttpsUrl", () => {
  it("accepts public https URLs", () => {
    expect(assertPublicHttpsUrl("https://example.com/hook", "url").hostname).toBe("example.com");
    expect(assertPublicHttpsUrl("https://8.8.8.8/hook", "url").hostname).toBe("8.8.8.8");
  });

  it("rejects non-https and invalid URLs", () => {
    expect(() => assertPublicHttpsUrl("http://example.com/hook", "url")).toThrow("must use https");
    expect(() => assertPublicHttpsUrl("ftp://example.com", "url")).toThrow("must use https");
    expect(() => assertPublicHttpsUrl("not a url", "url")).toThrow("must be a valid URL");
  });

  it("rejects loopback, private, link-local, and internal hostnames", () => {
    const blocked = [
      "https://localhost/hook",
      "https://foo.localhost/hook",
      "https://metadata.google.internal/computeMetadata",
      "https://service.local/hook",
      "https://127.0.0.1/hook",
      "https://10.1.2.3/hook",
      "https://172.16.0.1/hook",
      "https://172.31.255.255/hook",
      "https://192.168.1.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/hook",
      "https://0.0.0.0/hook",
      "https://[::1]/hook",
      "https://[fc00::1]/hook",
      "https://[fe80::1]/hook",
      "https://[::ffff:10.0.0.1]/hook",
    ];
    for (const url of blocked) {
      expect(() => assertPublicHttpsUrl(url, "url")).toThrow("private or internal");
    }
  });

  it("does not block public addresses adjacent to private ranges", () => {
    expect(assertPublicHttpsUrl("https://172.32.0.1/hook", "url").hostname).toBe("172.32.0.1");
    expect(assertPublicHttpsUrl("https://9.9.9.9/hook", "url").hostname).toBe("9.9.9.9");
    expect(assertPublicHttpsUrl("https://192.169.0.1/hook", "url").hostname).toBe("192.169.0.1");
  });
});
