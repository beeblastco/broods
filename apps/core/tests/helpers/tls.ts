/** Ephemeral TLS credentials shared by loopback HTTP integration tests. */

import { generate } from "selfsigned";

// Keep validity independent of tests that replace the clock. Nothing is saved to disk.
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
