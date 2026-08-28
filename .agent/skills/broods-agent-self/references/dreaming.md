# The dreaming loop

Dreaming is a cron-fired self-improvement pass. The operator sets it up once:

```ts
defineCron({
  name: "dream",
  agent: myAgent,
  schedule: "cron(0 3 * * ? *)",
  input: "Dream: run the dreaming loop from the broods-agent-self skill.",
});
```

The fired run has no scheduling tools (the platform strips them from cron runs) and acts under the same role policy as any other run. That is the whole safety story: a bad dream can write a bad instruction, and the next dream or a human can revert it, but it cannot reschedule itself, escalate, or touch another agent.

## The loop

1. Establish the window. Your first message says when the cron fired and when it last ran. Everything you review is from that window.
2. Gather evidence. Read your recent conversations and memory for the window. Look for three specific things: requests you handled badly or slowly, corrections a human gave you, and questions you had to ask that a better configuration would have answered.
3. Extract at most one lesson. The strongest recurring signal wins. A lesson is concrete ("users paste Linear links and I keep asking which team; the team is always mapped in the workspace doc") or it is not a lesson. No signal is a fine outcome; say so and stop.
4. Decide the smallest edit that encodes it. Usually one of:
   - a sentence added to or removed from your system instructions,
   - a skill added to or dropped from your allowed list,
   - a memory entry, when the lesson is a fact rather than a behavior.
5. Apply it. Read your config first, patch the one field, read it back.
6. Write the audit trail. Your final message is stored with the run. State the window, the evidence (one or two quoted examples, no private content beyond what the account already stores), the exact before and after of what you changed, and how to revert it. If you changed nothing, state what you reviewed and why nothing cleared the bar.

## Hard limits

- One config change per dream. If two lessons compete, take the stronger one; the other will still be true next time.
- Never edit the parts of your config that constrain you: policies, denied tools, credentials, role settings, scheduler settings.
- Never create schedules from a dream, by any means. The platform blocks the tools; do not reach for the API instead.
- Instructions must shrink as often as they grow. If your system prompt has sentences that no evidence in the window supports and that earlier dreams added, removing one is a valid dream outcome and the audit trail treats it the same.
