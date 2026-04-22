// Streaming harness: dedupe the event, load conversation history, run Gemini + tools inline, and emit SSE.
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
  type UserContent,
} from "ai";
import { extractText } from "../_shared/channels.ts";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import { createSession } from "./session.ts";
import { createTools } from "./tools/index.ts";

const google = createGoogleGenerativeAI({
  apiKey: requireEnv("GOOGLE_API_KEY"),
});

const GOOGLE_MODEL_ID = requireEnv("GOOGLE_MODEL_ID");
const DEFAULT_SYSTEM_PROMPT = requireEnv("DEFAULT_SYSTEM_PROMPT");
const SLIDING_CONTEXT_WINDOW = Number(requireEnv("SLIDING_CONTEXT_WINDOW"));
const MAX_AGENT_ITERATIONS = Number(requireEnv("MAX_AGENT_ITERATIONS"));
const enc = new TextEncoder();

interface InboundEvent {
  eventId: string;
  conversationKey: string;
  content: UserContent;
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
  return fullStream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(sseEvent(chunk as Record<string, unknown>));
    },
  }));
}

async function runAgentLoop(
  session: ReturnType<typeof createSession>,
  userContent: UserContent,
  history: ModelMessage[],
): Promise<ReadableStream> {
  const windowStart = Math.max(0, history.length - SLIDING_CONTEXT_WINDOW);
  let recentHistory = history.slice(windowStart);

  while (recentHistory.length > 0 && recentHistory[0]?.role !== "user") {
    recentHistory = recentHistory.slice(1);
  }

  const messages: ModelMessage[] = [
    ...recentHistory,
    { role: "user", content: userContent },
  ];

  const tools = {
    ...createTools({
      conversationKey: session.conversationKey,
      latestUserMessage: extractText(userContent),
    }),
  } satisfies ToolSet;

  const providerOptions = {
    google: {
      thinkingConfig: {
        thinkingLevel: "high",
      },
    },
  };

  const result = streamText({
    model: google(GOOGLE_MODEL_ID),
    system: DEFAULT_SYSTEM_PROMPT,
    messages: messages,
    tools: tools,
    maxOutputTokens: 16000,
    providerOptions: providerOptions,
    stopWhen: stepCountIs(MAX_AGENT_ITERATIONS),
    onFinish: async ({ response, text }) => {
      const finalText = text.trim();

      try {
        await session.persistModelMessages(response.messages);

        if (!finalText) {
          logError("Model returned empty response", {
            conversationKey: session.conversationKey,
            eventId: session.eventId,
          });
          return;
        }

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

function sseEvent(event: Record<string, unknown>): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(event)}\n\n`);
}
