/**
 * Shared HTTP helper tests: outbound URL validation for user-configured
 * webhook targets.
 */

import { dns } from "bun";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { assertPublicHttpsUrl, publicHostFetch } from "../src/shared/http.ts";

describe("assertPublicHttpsUrl", () => {
  it("accepts public https URLs", () => {
    expect(
      assertPublicHttpsUrl("https://example.com/hook", "url").hostname,
    ).toBe("example.com");
    expect(assertPublicHttpsUrl("https://8.8.8.8/hook", "url").hostname).toBe(
      "8.8.8.8",
    );
  });

  it("rejects non-https and invalid URLs", () => {
    expect(() =>
      assertPublicHttpsUrl("http://example.com/hook", "url"),
    ).toThrow("must use https");
    expect(() => assertPublicHttpsUrl("ftp://example.com", "url")).toThrow(
      "must use https",
    );
    expect(() => assertPublicHttpsUrl("not a url", "url")).toThrow(
      "must be a valid URL",
    );
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
      expect(() => assertPublicHttpsUrl(url, "url")).toThrow(
        "private or internal",
      );
    }
  });

  it("does not block public addresses adjacent to private ranges", () => {
    expect(
      assertPublicHttpsUrl("https://172.32.0.1/hook", "url").hostname,
    ).toBe("172.32.0.1");
    expect(assertPublicHttpsUrl("https://9.9.9.9/hook", "url").hostname).toBe(
      "9.9.9.9",
    );
    expect(
      assertPublicHttpsUrl("https://192.169.0.1/hook", "url").hostname,
    ).toBe("192.169.0.1");
  });
});

describe("publicHostFetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("refuses private hostnames and literal private addresses before connecting", async () => {
    await expect(publicHostFetch("https://localhost/v1")).rejects.toThrow(
      /private address/,
    );
    await expect(publicHostFetch("https://10.0.0.8/v1")).rejects.toThrow(
      /private address/,
    );
    await expect(
      publicHostFetch(new Request("https://169.254.169.254/latest")),
    ).rejects.toThrow(/private address/);
  });

  it("refuses a public name that resolves to a private address", async () => {
    const lookup = spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4, ttl: 30 },
      { address: "10.0.0.8", family: 4, ttl: 30 },
    ]);
    try {
      await expect(
        publicHostFetch("https://api.example.com/v1/chat"),
      ).rejects.toThrow(/resolves to a private address/);
    } finally {
      lookup.mockRestore();
    }
  });

  it("connects to the validated address with the name pinned into SNI and Host", async () => {
    const lookup = spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4, ttl: 30 },
    ]);
    const calls: Array<{ url: string; init: BunFetchRequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });

      return new Response("ok");
    }) as typeof fetch;
    try {
      await publicHostFetch("https://api.example.com/v1/chat", {
        method: "POST",
        headers: { authorization: "Bearer k" },
        redirect: "follow",
      });
    } finally {
      lookup.mockRestore();
    }

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://93.184.216.34/v1/chat");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.tls?.serverName).toBe("api.example.com");
    expect(new Headers(init.headers).get("host")).toBe("api.example.com");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer k");
  });

  it("keeps a Request's method, body, headers and explicit port", async () => {
    const lookup = spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4, ttl: 30 },
    ]);
    const calls: Array<{ url: string; init: BunFetchRequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });

      return new Response("ok");
    }) as typeof fetch;
    try {
      await publicHostFetch(
        new Request("https://api.example.com:8443/v1/chat", {
          method: "POST",
          headers: { authorization: "Bearer k" },
          body: "hi",
        }),
      );
    } finally {
      lookup.mockRestore();
    }

    const { url, init } = calls[0]!;
    expect(url).toBe("https://93.184.216.34:8443/v1/chat");
    expect(init.method).toBe("POST");
    expect(await new Response(init.body).text()).toBe("hi");
    expect(new Headers(init.headers).get("host")).toBe("api.example.com:8443");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer k");
    expect(init.tls?.serverName).toBe("api.example.com");
  });
});
