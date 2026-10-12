import { VIA_GATEWAY_HEADER } from "../../../packages/convex/model/serviceBridge.ts";

/** What core binds a socket credential to. */
export type CredentialScope = {
  accountId: string;
  projectSlug: string;
  stageSlug: string;
  endpointIds: string[];
  /** Unix ms a stage ticket dies at, as core verified it. A runtime key has none. */
  expiresAt?: number;
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

/** Resolves the scope a socket token grants, before the upgrade opens. */
export async function resolveSocketScope(
  socket: keyof typeof SCOPE_PATHS,
  token: string,
  coreBaseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<SocketScope> {
  try {
    const response = await fetchImpl(`${coreBaseUrl}${SCOPE_PATHS[socket]}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        [VIA_GATEWAY_HEADER]: "1",
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
