/**
 * Observability-scope isolation tests.
 * The self-hosted container serves many tenants concurrently in one process, so
 * the per-request observability context (log-redaction secrets + NATS routing
 * tags) must not leak across concurrent requests. Verifies runWithObservabilityScope
 * gives each async scope a private cell while preserving the module-global
 * fallback used by the Lambda runtime.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  getObservabilityContext,
  runWithObservabilityScope,
  setObservabilityContext,
  type ObservabilityContext,
} from "../functions/_shared/otel.ts";

function ctx(accountId: string): ObservabilityContext {
  return {
    accountId,
    project: "p",
    environment: "e",
    endpointId: "ep-" + accountId,
    agentId: "a",
    conversationKey: "c",
    traceId: "t",
    otelContext: {} as ObservabilityContext["otelContext"],
    secretValues: ["secret-" + accountId],
  };
}

afterEach(() => {
  setObservabilityContext(null);
});

describe("observability scope isolation", () => {
  it("keeps concurrent scopes from clobbering each other's context", async () => {
    const seen: Record<string, string | undefined> = {};

    const tenant = (id: string) =>
      runWithObservabilityScope(async () => {
        setObservabilityContext(ctx(id));
        // Yield repeatedly so the two tenants interleave on the event loop; a
        // module-global context would be overwritten by the other tenant here.
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        seen[id] = getObservabilityContext()?.accountId;
      });

    await Promise.all([tenant("A"), tenant("B")]);

    expect(seen.A).toBe("A");
    expect(seen.B).toBe("B");
  });

  it("isolates secretValues used for redaction across concurrent scopes", async () => {
    const captured: Record<string, readonly string[] | undefined> = {};
    const tenant = (id: string) =>
      runWithObservabilityScope(async () => {
        setObservabilityContext(ctx(id));
        await Promise.resolve();
        captured[id] = getObservabilityContext()?.secretValues;
      });
    await Promise.all([tenant("A"), tenant("B")]);
    expect(captured.A).toEqual(["secret-A"]);
    expect(captured.B).toEqual(["secret-B"]);
  });

  it("falls back to the module global when no scope is active (Lambda path)", () => {
    setObservabilityContext(ctx("lambda"));
    expect(getObservabilityContext()?.accountId).toBe("lambda");
  });

  it("does not leak a scoped context out to the global", async () => {
    setObservabilityContext(ctx("global"));
    await runWithObservabilityScope(async () => {
      setObservabilityContext(ctx("scoped"));
      expect(getObservabilityContext()?.accountId).toBe("scoped");
    });
    // Outside the scope, the global is untouched by the inner set.
    expect(getObservabilityContext()?.accountId).toBe("global");
  });
});
