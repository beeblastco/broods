import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { ModelMessage } from "ai";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import type { ToolOutput } from "../_shared/tools.ts";
import { buildToolConfig } from "../_shared/tools.ts";

const google = createGoogleGenerativeAI({
  apiKey: requireEnv("GOOGLE_API_KEY"),
});

const dynamo = new DynamoDBClient({});
const lambda = new LambdaClient({});

const GOOGLE_MODEL_ID = requireEnv("GOOGLE_MODEL_ID");
const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");
const PROCESSED_EVENTS_TABLE_NAME = requireEnv("PROCESSED_EVENTS_TABLE_NAME");
const DEFAULT_SYSTEM_PROMPT = requireEnv("DEFAULT_SYSTEM_PROMPT");
const SLIDING_CONTEXT_WINDOW = Number(requireEnv("SLIDING_CONTEXT_WINDOW"));
const MAX_AGENT_ITERATIONS = Number(requireEnv("MAX_AGENT_ITERATIONS"));
const TOOL_ARN_MAPPING: Record<string, string> = JSON.parse(requireEnv("TOOL_ARN_MAPPING"));

interface InboundEvent {
  eventId: string;
  conversationKey: string;
  content: string;
}

interface ConversationTurn {
  role: string;
  content: string;
  createdAt: string;
}

const enc = new TextEncoder();

function sseEvent(event: Record<string, unknown>): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function handler(event: InboundEvent): Promise<ReadableStream<Uint8Array>> {
  const { eventId, conversationKey, content } = event;
  const now = new Date().toISOString();

  if (!(await claimEvent(eventId, now))) {
    logInfo("Duplicate event skipped", { eventId });
    return new ReadableStream({ start(controller) { controller.close(); } });
  }

  let history: ConversationTurn[];
  try {
    history = await loadConversation(conversationKey);
    await persistUserMessage(conversationKey, content, now);
  } catch (err) {
    logError("Pre-processing failed", {
      eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    await releaseEvent(eventId).catch(() => { });
    throw err;
  }

  const fullStream = await runAgentLoop(conversationKey, content, history, eventId);

  const transformStream = new TransformStream<any, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(sseEvent(chunk));
    },
  });

  return fullStream.pipeThrough(transformStream);
}

async function claimEvent(eventId: string, now: string): Promise<boolean> {
  const ttl = Math.floor(Date.now() / 1000) + 86400;
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: PROCESSED_EVENTS_TABLE_NAME,
        Item: {
          eventId: { S: eventId },
          createdAt: { S: now },
          expiresAt: { N: String(ttl) },
        },
        ConditionExpression: "attribute_not_exists(eventId)",
      }),
    );
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

async function releaseEvent(eventId: string): Promise<void> {
  await dynamo.send(
    new DeleteItemCommand({
      TableName: PROCESSED_EVENTS_TABLE_NAME,
      Key: { eventId: { S: eventId } },
    }),
  );
}

async function loadConversation(conversationKey: string): Promise<ConversationTurn[]> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: CONVERSATIONS_TABLE_NAME,
      Key: { conversationKey: { S: conversationKey } },
      ConsistentRead: true,
    }),
  );

  const raw = result.Item?.conversation?.L;
  if (!raw) return [];

  return raw.map((item) => ({
    role: item.M!.role!.S!,
    content: item.M!.content!.S!,
    createdAt: item.M!.createdAt!.S!,
  }));
}

async function persistUserMessage(conversationKey: string, content: string, createdAt: string): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: CONVERSATIONS_TABLE_NAME,
      Key: { conversationKey: { S: conversationKey } },
      UpdateExpression: "SET conversation = list_append(if_not_exists(conversation, :empty), :turns), updatedAt = :ts",
      ExpressionAttributeValues: {
        ":empty": { L: [] },
        ":turns": {
          L: [{ M: { role: { S: "user" }, content: { S: content }, createdAt: { S: createdAt } } }],
        },
        ":ts": { S: createdAt },
      },
    }),
  );
}

async function persistAssistantMessage(conversationKey: string, content: string): Promise<void> {
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateItemCommand({
      TableName: CONVERSATIONS_TABLE_NAME,
      Key: { conversationKey: { S: conversationKey } },
      UpdateExpression: "SET conversation = list_append(if_not_exists(conversation, :empty), :turns), updatedAt = :ts",
      ExpressionAttributeValues: {
        ":empty": { L: [] },
        ":turns": {
          L: [{ M: { role: { S: "assistant" }, content: { S: content }, createdAt: { S: now } } }],
        },
        ":ts": { S: now },
      },
    }),
  );
}

async function runAgentLoop(
  conversationKey: string,
  userContent: string,
  history: ConversationTurn[],
  eventId: string,
): Promise<ReadableStream> {
  const windowStart = Math.max(0, history.length - SLIDING_CONTEXT_WINDOW);
  let recentHistory = history.slice(windowStart);
  while (recentHistory.length > 0 && recentHistory[0]!.role !== "user") {
    recentHistory = recentHistory.slice(1);
  }

  const messages: ModelMessage[] = [
    ...recentHistory.map((turn) => ({
      role: turn.role as "user" | "assistant",
      content: turn.content,
    })),
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
          conversationKey,
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
        logError("Model returned empty response", { conversationKey, eventId });
        return;
      }
      try {
        await persistAssistantMessage(conversationKey, finalText);
        logInfo("Processing complete", { conversationKey });
      } catch (err) {
        logError("Post-generation steps failed", {
          conversationKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  return result.fullStream;
}

async function executeToolCall(
  toolUse: { name: string; input: Record<string, unknown>; toolCallId: string },
  conversationKey: string,
  latestUserMessage: string,
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
          context: { conversationKey, latestUserMessage },
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

