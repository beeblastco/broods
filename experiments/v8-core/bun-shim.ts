/**
 * The few Bun APIs core touches, for running core inside workerd. `dns` has no
 * workerd resolver, so it asks DNS-over-HTTPS.
 */

import picomatch from "picomatch";

interface DohAnswer {
  Answer?: { type: number; data: string }[];
}

/** Bun's `dns.lookup`, answered over DNS-over-HTTPS: workerd has no resolver API. */
export const dns = {
  lookup: async function (
    hostname: string,
  ): Promise<{ address: string; family: 4 | 6 }[]> {
    const answers = await Promise.all(
      (["A", "AAAA"] as const).map(async (type) => {
        const response = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
          { headers: { accept: "application/dns-json" } },
        );
        const body = (await response.json()) as DohAnswer;

        return (body.Answer ?? [])
          .filter((answer) => answer.type === (type === "A" ? 1 : 28))
          .map((answer) => ({
            address: answer.data,
            family: (type === "A" ? 4 : 6) as 4 | 6,
          }));
      }),
    );

    return answers.flat();
  },
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class Glob {
  readonly #match: (path: string) => boolean;
  constructor(pattern: string) {
    this.#match = picomatch(pattern, { dot: true });
  }
  match(path: string): boolean {
    return this.#match(path);
  }
}

const bunGlobal = {
  sleep: sleep,
  Glob: Glob,
  markdown: {
    html: function (): string {
      throw new Error("Bun.markdown is not available in workerd");
    },
  },
  escapeHTML: function (text: string): string {
    return text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#x27;");
  },
};

(globalThis as { Bun?: unknown }).Bun = bunGlobal;

export default bunGlobal;
