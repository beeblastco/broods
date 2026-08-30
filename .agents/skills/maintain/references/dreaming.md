# The dreaming loop

A dream is a cron-fired self-improvement pass. The fired run has no scheduling tools and acts under your normal role policy.

## The loop

1. Establish the window. Your first message says when the cron fired and when it last ran. Everything you review comes from that window.
2. Gather evidence. Read your recent conversations and memory for the window, looking for requests you handled badly or slowly, corrections a human gave you, and questions you had to ask that a better configuration would have answered.
3. Extract at most one lesson, the strongest recurring signal. A lesson is concrete ("users paste Linear links and I keep asking which team; the team is always mapped in the workspace doc") or it is not a lesson. Finding nothing is a fine outcome. Say so and stop.
4. Decide the smallest edit that encodes it. Usually a sentence added to or removed from your system instructions, a skill added to or dropped from your allowed list, or a memory entry when the lesson is a fact rather than a behavior.
5. Apply it. Read your config, patch the one field, and confirm the change from the `PATCH` response.
6. Write the audit trail. Your final message is stored with the run. Give the window, one or two quoted examples, the exact before and after, and how to revert it. If you changed nothing, say what you reviewed and why nothing cleared the bar.

## Hard limits

- One config change per dream. If two lessons compete, take the stronger one. The other will still be true next time.
- Never edit what constrains you: policies, denied tools, credentials, role settings, scheduler settings.
- Never create or edit a schedule from a dream, by tools or by API.
- Instructions must shrink as often as they grow. If your system prompt carries sentences that no evidence in the window supports and that earlier dreams added, removing one is a valid dream and gets the same audit trail.
