import { VIA_GATEWAY_HEADER } from "../../../packages/convex/model/serviceBridge.ts";
import { USER_TOKEN_HEADER } from "./utils.ts";

export type CredentialScope = {
  accountId: string;
  projectSlug: string;
  stageSlug: string;
  endpointIds: string[];
  // Unix ms; a runtime key has none.
  expiresAt?: number;
  conversationPrefix?: string;
  userTokenExpiresAt?: number;
};

// `unavailable` is core not answering: an outage, not a bad login.
export type SocketScope =
  | { kind: "resolved"; scope: CredentialScope }
  | { kind: "invalid" }
  | { kind: "unavailable" };

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

// Observability takes only a member's stage ticket; the agent socket a runtime key too.
const SCOPE_PATHS = {
  agent: "/v1/internal/agent-socket-scope",
  observability: "/v1/internal/observability-scope",
} as const;

// The user token goes along so a forged or expired one fails the upgrade as a bad login.
export async function resolveSocketScope(
  socket: keyof typeof SCOPE_PATHS,
  token: string,
  coreBaseUrl: string,
  fetchImpl: FetchLike = fetch,
  userToken?: string,
): Promise<SocketScope> {
  try {
    const response = await fetchImpl(`${coreBaseUrl}${SCOPE_PATHS[socket]}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        [VIA_GATEWAY_HEADER]: "1",
        ...(userToken ? { [USER_TOKEN_HEADER]: userToken } : {}),
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const scope = (await response.json()) as CredentialScope;

      return { kind: "resolved", scope: scope };
    }

    return response.status === 401 || response.status === 403
      ? { kind: "invalid" }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
