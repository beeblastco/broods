import type { RequestListener } from "node:http";
import { createServer, type Server } from "node:https";
import { generate } from "selfsigned";
import type { PinnedFetchTransport } from "../../src/shared/http.ts";

// Fixed dates keep validity independent of tests that replace the clock.
const credentials = await generate(
  [{ name: "commonName", value: "public.test" }],
  {
    algorithm: "sha256",
    keySize: 2048,
    extensions: [
      { name: "basicConstraints", cA: true },
      {
        name: "keyUsage",
        keyCertSign: true,
        digitalSignature: true,
        keyEncipherment: true,
      },
      { name: "subjectAltName", altNames: [{ type: 2, value: "public.test" }] },
    ],
    notBeforeDate: new Date("2020-01-01T00:00:00.000Z"),
    notAfterDate: new Date("2120-01-01T00:00:00.000Z"),
  },
);

export const TLS_CERT = credentials.cert;
export const TLS_KEY = credentials.private;

// Only 127.0.0.1 is exempt, so every other address still meets the production denylist.
export function loopbackTransport(): PinnedFetchTransport {
  return {
    allowAddresses: ["127.0.0.1"],
    ca: TLS_CERT,
    lookup: async (
      hostname: string,
    ): Promise<{ address: string; family: number }[]> => {
      if (hostname !== "public.test") {
        throw new Error(`no test DNS entry for ${hostname}`);
      }

      return [{ address: "127.0.0.1", family: 4 }];
    },
  };
}

export async function withLoopbackTlsServer(
  listener: RequestListener,
  run: (origin: string) => Promise<void>,
  port: number = 0,
): Promise<void> {
  const server: Server = createServer(
    { cert: TLS_CERT, key: TLS_KEY },
    listener,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", (): void => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("test server has no port");
  }
  try {
    await run(`https://public.test:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close((): void => resolve()));
  }
}
