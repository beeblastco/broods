import { VIA_GATEWAY_HEADER } from "../../../packages/convex/model/serviceBridge.ts";
import type { ObservabilityScope } from "./observability.ts";

/**
 * A socket credential checked against core. `invalid` means core refused the
 * token; `unavailable` means core could not answer, which is an outage and not
 * the caller's fault.
 */
export type SocketScope =
  | { kind: "resolved"; scope: ObservabilityScope }
  | { kind: "invalid" }
  | { kind: "unavailable" };

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Resolves the scope a socket token grants, before the upgrade opens. */
export async function resolveSocketScope(
  token: string,
  coreBaseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<SocketScope> {
  try {
    const response = await fetchImpl(
      `${coreBaseUrl}/v1/internal/observability-scope`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          [VIA_GATEWAY_HEADER]: "1",
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.ok) {
      const scope = (await response.json()) as ObservabilityScope;

      // The socket closes at this instant; a core that names none is not
      // trusted with an open-ended one.
      return Number.isFinite(scope.expiresAt)
        ? { kind: "resolved", scope: scope }
        : { kind: "unavailable" };
    }

    return response.status === 401 || response.status === 403
      ? { kind: "invalid" }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
