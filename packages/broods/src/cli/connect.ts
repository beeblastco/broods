/**
 * `broods connect <type>`: the browser half of a connection. Providers only
 * redirect to a loopback address, so the sign-in runs here, on the machine
 * with the browser: the deployment answers its consent screen, the browser
 * signs in, and the code goes back to the deployment, which trades it and
 * keeps the tokens. Nothing to pass, nothing to store here.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CONNECTION_TYPES,
  type ConnectionType,
} from "../../../convex/model/connections.ts";
import type { BroodsAccountClient, Connection } from "../account.ts";
import { openBrowser, waitForCallback, waitWithTimeout } from "./utils.ts";

// OpenAI's documented example port; any port works as long as the scheme,
// host and path stay the same, so a busy one falls back to a free port.
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";

interface AuthorizationCallback {
  code: string;
  /** The client OpenAI registered for this sign-in. */
  clientId: string;
}

/**
 * Signs `type` in through the browser and answers the stored connection. The
 * PKCE verifier, state and nonce stay on this machine; the deployment builds
 * the consent screen and trades the code.
 */
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
      clientId: callback.clientId,
      hostId: start.hostId,
    });
  } finally {
    close();
  }
}

/** The loopback redirect: the code, and the client OpenAI issued. */
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
  const clientId = params.get("client_id");
  if (!code || !clientId)
    throw new Error("Sign-in callback carried no code or client id.");

  return { code: code, clientId: clientId };
}
