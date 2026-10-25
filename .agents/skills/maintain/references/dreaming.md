# The dreaming loop

A dream is a cron-fired self-improvement pass. The fired run has no scheduling tools and acts under your normal role policy.

## The loop

1. Establish the window. Your first message gives the fire time, the cron's name and schedule, and when it was created, not when it last ran. The last run is in this conversation's own history, or in `GET /v1/crons/{id}/runs` if you know the cron id. Everything you review comes from that window.
2. Gather evidence. No API reads your other conversations. You can read this dream conversation's own history, `memory/` with `read` and `grep`, and cron run results by id. Memory entries carry no timestamp, so you cannot filter memory by the window. Look for requests you handled badly or slowly, corrections a human gave you, and questions you had to ask that a better configuration would have answered.
3. Extract at most one lesson, the strongest recurring signal. A lesson is concrete ("users paste Linear links and I keep asking which team; the team is always mapped in the workspace doc") or it is not a lesson. Finding nothing is a fine outcome. Say so and stop.
4. Decide the smallest edit that encodes it. Usually a sentence added to or removed from your system instructions, a skill added to or dropped from your allowed list, or a `memory_save` entry when the lesson is a fact rather than a behavior. `memory_save` needs a workspace on a sandbox, and every agent on that workspace shares its memory.
5. Apply it. Read your config, patch the one field, and confirm the change from the `PATCH` response.
6. Write the audit trail. Your final message is stored with the run. Give the window, one or two quoted examples, the exact before and after, and how to revert it. If you changed nothing, say what you reviewed and why nothing cleared the bar.

## Hard limits

- One config change per dream. If two lessons compete, take the stronger one. The other will still be true next time.
- Never edit what constrains you: policies, denied tools, credentials, role settings, scheduler settings.
- Never create or edit a schedule from a dream, by tools or by API.
- Instructions must shrink as often as they grow. If your system prompt carries sentences that no evidence in the window supports and that earlier dreams added, removing one is a valid dream and gets the same audit trail.
