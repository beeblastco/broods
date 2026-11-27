import { z } from "zod/mini";
import { openSignedTicket, sealSignedTicket } from "./stageSessionTicket";

// Its own key context, so neither a stage ticket nor a user token opens as one.
const KEY_CONTEXT = "apply-deploy-ticket:";

export const APPLY_TICKET_PREFIX = "bdap_";
/** Long enough for a cold install and a deploy, short enough to be useless once Apply ends. */
export const APPLY_TICKET_TTL_MS = 5 * 60 * 1000;

const applyTicketSchema = z.object({
  accountId: z.string(),
  projectId: z.string(),
  stageId: z.string(),
  authId: z.string(),
  expiresAt: z.number(),
});

/** What the compile sandbox deploys with: one stage's manifest routes, as one member. */
export type ApplyTicket = z.infer<typeof applyTicketSchema>;

export async function sealApplyTicket(
  ticket: Omit<ApplyTicket, "expiresAt">,
  secret: string,
  now = Date.now(),
): Promise<string> {
  return await sealSignedTicket(
    APPLY_TICKET_PREFIX,
    KEY_CONTEXT,
    { ...ticket, expiresAt: now + APPLY_TICKET_TTL_MS },
    secret,
  );
}

export async function openApplyTicket(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<ApplyTicket | null> {
  const parsed = applyTicketSchema.safeParse(
    await openSignedTicket(APPLY_TICKET_PREFIX, KEY_CONTEXT, token, secret),
  );

  return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
}
