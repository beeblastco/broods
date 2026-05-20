# cherry-coke

BeeBlast dashboard frontend.

The local backend runtime that used to live in this repo has been removed. `pnzu`
now provides the agent gateway and custom-tool execution backend services.
`pnzu/convex` is also the only backend source of truth; this repo only keeps a
client-side Convex contract shim under `convex/_generated` so the frontend can
talk to the deployed `pnzu` backend.

The GitHub repository for this frontend is `beeblastco/cherry-coke`.

Configure the frontend against deployed services with:

- `NEXT_PUBLIC_CONVEX_URL` for the Convex deployment used by the app UI.
- `NEXT_PUBLIC_AGENT_GATEWAY_URL` for the `pnzu` harness / gateway base URL.
- `CUSTOM_TOOL_EXECUTOR_URL`, `CUSTOM_TOOL_EXECUTOR_SECRET`, and optionally
  `CUSTOM_TOOL_EXECUTOR_SECRET_HEADER` on the Next.js server if you want the
  Tool Test tab to proxy source-code test runs through an external executor.

Useful commands:

- `bun --bun next dev`
- `bun --bun next build`
- `bun --bun next start`
