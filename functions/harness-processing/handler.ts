import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { ModelMessage, UserContent } from "ai";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { createSession } from "./session.ts";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import type { ToolOutput } from "../_shared/tools.ts";
import { buildToolConfig } from "../_shared/tools.ts";

const google = createGoogleGenerativeAI({
  apiKey: requireEnv("GOOGLE_API_KEY"),
});

const fetchHandler = new FetchHttpHandler();
const lambda = new LambdaClient({ requestHandler: fetchHandler });

const GOOGLE_MODEL_ID = requireEnv("GOOGLE_MODEL_ID");
const DEFAULT_SYSTEM_PROMPT = requireEnv("DEFAULT_SYSTEM_PROMPT");
const SLIDING_CONTEXT_WINDOW = Number(requireEnv("SLIDING_CONTEXT_WINDOW"));
const MAX_AGENT_ITERATIONS = Number(requireEnv("MAX_AGENT_ITERATIONS"));
const TOOL_ARN_MAPPING: Record<string, string> = JSON.parse(requireEnv("TOOL_ARN_MAPPING"));

interface InboundEvent {
  eventId: string;
  conversationKey: string;
  content: UserContent;
}

const enc = new TextEncoder();

function sseEvent(event: Record<string, unknown>): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function handler(event: InboundEvent): Promise<ReadableStream<Uint8Array>> {
  const { eventId, conversationKey, content } = event;
  const session = createSession(eventId, conversationKey);

  if (!(await session.claim())) {
    logInfo("Duplicate event skipped", { eventId });
    return new ReadableStream({ start(controller) { controller.close(); } });
  }

  let history: ModelMessage[];
  try {
    history = await session.loadHistory();
    await session.persistUserMessage(content);
  } catch (err) {
    logError("Pre-processing failed", {
      eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    await session.release().catch(() => { });
    throw err;
  }

  const fullStream = await runAgentLoop(session, content, history);

  const transformStream = new TransformStream<any, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(sseEvent(chunk));
    },
  });

  return fullStream.pipeThrough(transformStream);
}

async function runAgentLoop(
  session: ReturnType<typeof createSession>,
  userContent: UserContent,
  history: ModelMessage[],
): Promise<ReadableStream> {
  const windowStart = Math.max(0, history.length - SLIDING_CONTEXT_WINDOW);
  let recentHistory = history.slice(windowStart);
  while (recentHistory.length > 0 && recentHistory[0]!.role !== "user") {
    recentHistory = recentHistory.slice(1);
  }

  const messages: ModelMessage[] = [
    ...recentHistory,
    { role: "user" as const, content: userContent },
  ];

  const toolConfig = buildToolConfig();
  const tools: Record<string, any> = {
    google_search: google.tools.googleSearch({}),
  };

  for (const spec of toolConfig.tools) {
    tools[spec.toolSpec.name] = tool({
      description: spec.toolSpec.description,
      inputSchema: jsonSchema(spec.toolSpec.inputSchema.json as any),
      execute: async (input, { toolCallId }) => {
        const result = await executeToolCall(
          { name: spec.toolSpec.name, input: input as Record<string, unknown>, toolCallId },
          session,
          userContent,
        );
        if (result.action === "immediate_reply") {
          return result.replyText ?? result.content;
        }
        return result.content;
      },
    });
  }

  const result = streamText({
    model: google(GOOGLE_MODEL_ID),
    system: DEFAULT_SYSTEM_PROMPT,
    messages,
    tools,
    stopWhen: stepCountIs(MAX_AGENT_ITERATIONS),
    maxOutputTokens: 16000,
    providerOptions: {
      google: {
        thinkingConfig: {
          thinkingLevel: "high",
        },
      },
    },
    onFinish: async ({ text }) => {
      const finalText = text.trim();
      if (!finalText) {
        logError("Model returned empty response", {
          conversationKey: session.conversationKey,
          eventId: session.eventId,
        });
        return;
      }
      try {
        await session.persistAssistantMessage(finalText);
        logInfo("Processing complete", { conversationKey: session.conversationKey });
      } catch (err) {
        logError("Post-generation steps failed", {
          conversationKey: session.conversationKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  return result.fullStream;
}

async function executeToolCall(
  toolUse: { name: string; input: Record<string, unknown>; toolCallId: string },
  session: ReturnType<typeof createSession>,
  latestUserMessage: UserContent,
): Promise<ToolOutput> {
  const functionArn = TOOL_ARN_MAPPING[toolUse.name];
  if (!functionArn) {
    return {
      toolUseId: toolUse.toolCallId,
      content: `Unknown tool: ${toolUse.name}`,
      status: "error",
    };
  }

  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionArn,
      Payload: Buffer.from(
        JSON.stringify({
          toolUseId: toolUse.toolCallId,
          input: toolUse.input,
          context: {
            conversationKey: session.conversationKey,
            latestUserMessage,
          },
        }),
      ),
    }),
  );

  if (result.FunctionError) {
    const errPayload = result.Payload
      ? JSON.parse(Buffer.from(result.Payload).toString())
      : {};
    return {
      toolUseId: toolUse.toolCallId,
      content: `Tool invocation error: ${errPayload.errorMessage ?? result.FunctionError}`,
      status: "error",
    };
  }

  return JSON.parse(Buffer.from(result.Payload!).toString());
}