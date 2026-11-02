import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CONNECTION_TYPES,
  type ConnectionType,
} from "../../../convex/model/connections.ts";
import type { BroodsAccountClient, Connection } from "../account.ts";
import { openBrowser, waitForCallback, waitWithTimeout } from "./utils.ts";

// Providers redirect only to loopback, so the browser half of a connection runs here.
// 1455 is OpenAI's documented port; any free port works with the same scheme, host and path.
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";

interface AuthorizationCallback {
  code: string;
  clientId: string | undefined;
}

export async function connectInBrowser(
  client: BroodsAccountClient,
  type: ConnectionType,
  open: (url: string) => void = openBrowser,
): Promise<Connection> {
  const label = CONNECTION_TYPES[type].label;
  const state = randomUUID();
  const nonce = randomUUID();
  const verifier = randomBytes(32).toString("base64url");
  const { code, close } = await waitForCallback(state, {
    port: CALLBACK_PORT,
    fixedPort: false,
    path: CALLBACK_PATH,
    read: readAuthorizationCallback,
    done: `${label} is connected to broods. You can close this tab.`,
  });

  try {
    const redirectUri = code.callbackUrl;
    const start = await client.startConnection(type, {
      redirectUri: redirectUri,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      state: state,
      nonce: nonce,
    });
    open(start.authorizeUrl);
    console.log(`Opening ${start.authorizeUrl}`);
    const callback = await waitWithTimeout(
      code.promise,
      `Timed out waiting for the ${label} sign-in to finish in the browser.`,
    );

    return await client.connect(type, {
      code: callback.code,
      codeVerifier: verifier,
      redirectUri: redirectUri,
      nonce: nonce,
      clientId: callback.clientId ?? start.clientId,
      hostId: start.hostId,
    });
  } finally {
    close();
  }
}

function readAuthorizationCallback(
  params: URLSearchParams,
): AuthorizationCallback {
  const error = params.get("error");
  if (error) {
    throw new Error(
      `Sign-in failed: ${params.get("error_description") ?? error}`,
    );
  }
  const code = params.get("code");
  if (!code) throw new Error("Sign-in callback carried no code.");

  return { code: code, clientId: params.get("client_id") ?? undefined };
}
