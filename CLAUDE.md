# Agent

This repository is an agentic AI chatbot on AWS — Lambda + Google AI (Gemini) + Telegram, deployed with SST. It uses the Vercel AI SDK (`ai` + `@ai-sdk/google`) with SSE streaming via Lambda Function URLs.

Key rules:

- Keep the constants, naming pattern, and tag conventions in `sst.config.ts` aligned with the infra repo.
- Each Lambda function lives in its own folder under `functions/` with a `bootstrap.ts` entry point for the Bun custom runtime.
- Default runtime is Bun on Lambda `provided.al2023` with ARM64 binaries built by `scripts/build.ts`.
- Two core Lambdas:
  - `telegram-integration` — receives Telegram webhooks via Function URL, handles bot commands, calls harness-processing's streaming Function URL and drains the SSE stream.
  - `harness-processing` — streaming Function URL (`RESPONSE_STREAM` invoke mode). Runs the full agentic loop using Vercel AI SDK `streamText` with Google AI provider: dedup, load DynamoDB context, streaming generation with tool calling + Google Search grounding, persist conversation, send Telegram reply. Emits SSE events (`text-delta`, `done`) back to the caller.
- The custom Bun runtime (`functions/_shared/runtime.ts`) supports two modes: `startRuntime` for standard request-response (telegram-integration) and `startStreamingRuntime` for Lambda response streaming (harness-processing).
- To add a new tool: create `functions/tool-<name>/`, add the Lambda to `sst.config.ts`, register it in `toolArnMapping` and `toolLambdaArns`, and define its spec in `functions/_shared/tools.ts`.
- Tool Lambdas receive `{ toolUseId, input, context }` and must return `{ toolUseId, content, status }`.
- Google Search is enabled as a built-in tool via `google.tools.googleSearch({})`.
- Shared code goes in `functions/_shared/`. Do not duplicate utilities across function folders.
- Use `bun run build` to compile all functions, then `bun run deploy` to deploy.
- CI/CD runs automatically on push/PR via GitHub Actions. Use `gh run list` and `gh run view` to monitor pipeline status.
- To add a new communication channel (e.g. Slack, WhatsApp): create `functions/_shared/<channel>-channel.ts` implementing the `ChannelAdapter` interface from `functions/_shared/channels.ts` (authenticate, parse, actions), then register it in the `channels` array in `functions/telegram-integration/handler.ts`. Add a reply branch in `harness-processing/handler.ts` `sendReply()`. Do not put channel-specific logic in the integration handler itself.
- To add a new bot command: add an entry to the `commands` array in `functions/_shared/commands.ts` with aliases, description, and an execute function. Commands receive a `CommandContext` with a channel-agnostic `ChannelActions` interface — do not import channel-specific modules from commands.
- Reply formatting uses `markdownToHtml()` from `functions/_shared/telegram.ts` for Telegram. New channels should implement their own formatting in their channel module if needed.
- Secrets are managed via SST: `TelegramBotToken`, `TelegramWebhookSecret`, `AllowedChatIds`, `GoogleApiKey`.
