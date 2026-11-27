import { z } from "zod/mini";
import { openSignedTicket, sealSignedTicket } from "./stageSessionTicket";

// Its own key context, so no other ticket opens as one, and it opens as nothing else.
const KEY_CONTEXT = "observability-read-ticket:";

export const OBSERVABILITY_TICKET_PREFIX = "bdob_";
export const OBSERVABILITY_TICKET_TTL_MS = 5 * 60 * 1000;

const observabilityTicketSchema = z.object({
  accountId: z.string(),
  endpointId: z.string(),
  projectSlug: z.string(),
  stageSlug: z.string(),
  expiresAt: z.number(),
});

/** Reads one stage's logs and traces, and nothing else: no run, no sandbox, no account route. */
export type ObservabilityTicket = z.infer<typeof observabilityTicketSchema>;

/** A ticket dies with the login that asked for it, or sooner. */
export function observabilityTicketExpiry(
  now: number,
  loginExpiresAt: number | undefined,
): number {
  const expiry = now + OBSERVABILITY_TICKET_TTL_MS;

  return loginExpiresAt === undefined
    ? expiry
    : Math.min(expiry, loginExpiresAt);
}

export async function sealObservabilityTicket(
  ticket: ObservabilityTicket,
  secret: string,
): Promise<string> {
  return await sealSignedTicket(
    OBSERVABILITY_TICKET_PREFIX,
    KEY_CONTEXT,
    ticket,
    secret,
  );
}

export async function openObservabilityTicket(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<ObservabilityTicket | null> {
  const parsed = observabilityTicketSchema.safeParse(
    await openSignedTicket(
      OBSERVABILITY_TICKET_PREFIX,
      KEY_CONTEXT,
      token,
      secret,
    ),
  );

  return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
}
