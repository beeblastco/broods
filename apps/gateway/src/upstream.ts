import { VIA_GATEWAY_HEADER } from "../../../packages/convex/model/serviceBridge.ts";
import { USER_TOKEN_HEADER } from "./utils.ts";

/** What core binds a socket credential to. */
export type CredentialScope = {
  accountId: string;
  projectSlug: string;
  stageSlug: string;
  endpointIds: string[];
  /** Unix ms a stage ticket dies at, as core verified it. A runtime key has none. */
  expiresAt?: number;
  /** Where core keys the signed user's conversations, when a user token rode along. */
  conversationPrefix?: string;
};

/**
 * A socket credential checked against core. `invalid` means core refused the
 * token; `unavailable` means core could not answer, which is an outage and not
 * the caller's fault.
 */
export type SocketScope =
  | { kind: "resolved"; scope: CredentialScope }
  | { kind: "invalid" }
  | { kind: "unavailable" };

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Core's scope lookup per socket. Each socket asks its own, because core
 * takes different credentials on each: the observability socket only a
 * member's stage ticket, the agent socket the stage's runtime key too.
 */
const SCOPE_PATHS = {
  agent: "/v1/internal/agent-socket-scope",
  observability: "/v1/internal/observability-scope",
} as const;

/**
 * Resolves the scope a socket token grants, before the upgrade opens. A user
 * token goes along, so a forged or expired one fails the upgrade as a bad
 * login, counted by the auth-failure limiter.
 */
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
