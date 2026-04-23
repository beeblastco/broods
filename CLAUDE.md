# Agent

This repository is an agentic AI chatbot on AWS — Lambda + Google AI (Gemini) + Telegram, deployed with SST. It uses the Vercel AI SDK (`ai` + `@ai-sdk/google`) with SSE streaming via Lambda Function URLs.

Key rules:

- Keep the constants, naming pattern, and tag conventions in `sst.config.ts` aligned with the infra repo.
- Each Lambda function lives in its own folder under `functions/` with a `bootstrap.ts` entry point for the Bun custom runtime.
- Default runtime is Bun on Lambda `provided.al2023` with ARM64 binaries built by `scripts/build.ts`.
- The deployed architecture uses a single public Lambda:
  - `harness-processing` — streaming Function URL (`RESPONSE_STREAM` invoke mode). It accepts both direct API requests and Telegram webhook requests, normalizes them through `functions/harness-processing/integrations.ts`, runs the agent loop in `functions/harness-processing/harness-processing.ts`, persists conversation state in `functions/harness-processing/session.ts`, and emits SSE only for direct API callers.
- The custom Bun runtime used by the deployed path is `startStreamingRuntime` from `functions/_shared/runtime.ts`. It passes the full Lambda Function URL event envelope into the handler so request routing can distinguish Telegram webhook traffic from direct API traffic.
- To add a new tool: create `functions/harness-processing/tools/<name>.tool.ts`, export a default tool factory, put the tool logic directly inside each tool's `execute`, and import that factory in `functions/harness-processing/tools/index.ts`.
- `functions/harness-processing/tools/index.ts` is the static registry used to ensure tool files are bundled into the compiled Lambda binary.
- Custom tools run inline inside `harness-processing` during the streaming request. Do not add queue-based tool execution or external tool-Lambda wiring unless the architecture intentionally changes.
- Google Search is enabled as a built-in tool via `google.tools.googleSearch({})`.
- Shared code goes in `functions/_shared/` only when it is actually shared by multiple Lambdas. Keep harness-only code in `functions/harness-processing/`.
- File header comments must use a block-docstring style:

  ```ts
  /**
   * ...
   */

  import ...
  ```

- Leave one blank line between the file header docstring and the first import or code line.
- Keep file header docstrings short. They should describe the file boundary, what belongs there, and where adjacent logic should go. Do not turn them into a function inventory.
- Use `bun run build` to compile all functions, then `bun run deploy` to deploy.
- CI/CD runs automatically on push/PR via GitHub Actions. Use `gh run list` and `gh run view` to monitor pipeline status.
- To add a new communication channel (e.g. Slack, WhatsApp): create `functions/_shared/<channel>-channel.ts` implementing the `ChannelAdapter` interface from `functions/_shared/channels.ts`, then wire the normalization path into `functions/harness-processing/integrations.ts`. Reply sending should stay inside that channel's `ChannelActions`; do not hardcode channel-specific logic into shared handlers or the core agent loop.
- To add a new bot command: add an entry to the `commands` array in `functions/_shared/commands.ts` with aliases, description, and an execute function. Commands receive a `CommandContext` with a channel-agnostic `ChannelActions` interface — do not import channel-specific modules from commands.
- Reply formatting uses `markdownToHtml()` from `functions/_shared/telegram.ts` for Telegram. New channels should implement their own formatting in their channel module if needed.
- Secrets are managed via SST: `TelegramBotToken`, `TelegramWebhookSecret`, `AllowedChatIds`, `GoogleApiKey`.

Remember:

- The main flow is `incoming request -> integrations.ts -> handler.ts -> harness-processing.ts -> optional channel reply`.
- Keep the Function URL SSE path intact when simplifying code. Do not replace it with synthesized events unless that change is intentional.
- The active persistence layer for harness-processing lives in `functions/harness-processing/session.ts`.
- `functions/harness-processing/handler.ts` should stay thin and orchestration-focused.
- `functions/harness-processing/integrations.ts` owns request normalization and channel/webhook routing.
- `functions/harness-processing/harness-processing.ts` owns the model/tool execution loop.
- The example custom tool lives in `functions/harness-processing/tools/weather.tool.ts`.
