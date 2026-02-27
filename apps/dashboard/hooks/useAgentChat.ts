"use client";

/**
 * Streaming chat hook for testing a deployed agent via the gateway API.
 * Uses AI SDK utilities to parse the UIMessage SSE stream.
 */
import { useCallback, useRef, useState } from "react";
import { readUIMessageStream, uiMessageChunkSchema } from "ai";
import { parseJsonEventStream } from "@ai-sdk/provider-utils";
import type { UIMessage } from "ai";

type ChatStatus = "ready" | "streaming" | "error";

/**
 * Streams chat messages from the agent gateway and maintains conversation state.
 * @param endpointId Deployment endpoint ID
 * @param apiKey API key for bearer authentication
 */
export function useAgentChat({
    endpointId,
    apiKey,
}: {
    endpointId: string;
    apiKey: string;
}) {
    const [messages, setMessages] = useState<UIMessage[]>([]);
    const [status, setStatus] = useState<ChatStatus>("ready");
    const [error, setError] = useState<Error | null>(null);
    const sessionIdRef = useRef<string | undefined>(undefined);
    const abortRef = useRef<AbortController | null>(null);
    const gatewayUrl = process.env.NEXT_PUBLIC_AGENT_GATEWAY_URL ?? "http://localhost:8080";

    /** Send a message and stream the assistant response. */
    const sendMessage = useCallback(
        async (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return;

            // Append user message
            const userMessage: UIMessage = {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text: trimmed }],
            };
            setMessages((prev) => [...prev, userMessage]);
            setStatus("streaming");
            setError(null);

            // Abort any in-flight request
            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;

            try {
                const response = await fetch(
                    `${gatewayUrl}/v1/agents/${endpointId}`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${apiKey}`,
                        },
                        body: JSON.stringify({
                            message: trimmed,
                            sessionId: sessionIdRef.current,
                            stream: true,
                        }),
                        signal: controller.signal,
                    },
                );

                if (!response.ok) {
                    const body = await response.json().catch(() => ({}));
                    throw new Error(
                        (body as Record<string, string>).error ??
                            `Gateway returned ${response.status}`,
                    );
                }

                // Capture session ID for multi-turn conversation
                const sid = response.headers.get("X-Session-Id");
                if (sid) {
                    sessionIdRef.current = sid;
                }

                if (!response.body) {
                    throw new Error("Response body is empty");
                }

                // Parse SSE → UIMessageChunk → UIMessage
                const chunkStream = parseJsonEventStream({
                    stream: response.body,
                    schema: uiMessageChunkSchema,
                }).pipeThrough(
                    new TransformStream({
                        transform(result, controller) {
                            if (result.success) {
                                controller.enqueue(result.value);
                            }
                        },
                    }),
                );

                const messageStream = readUIMessageStream({
                    stream: chunkStream,
                });

                for await (const assistantMessage of messageStream) {
                    setMessages((prev) => {
                        const last = prev[prev.length - 1];
                        if (last && last.role === "assistant") {
                            // Replace the in-progress assistant message
                            return [...prev.slice(0, -1), assistantMessage];
                        }

                        // First chunk — append new assistant message
                        return [...prev, assistantMessage];
                    });
                }

                setStatus("ready");
            } catch (err) {
                if ((err as Error).name === "AbortError") return;
                const message =
                    err instanceof TypeError && err.message === "Failed to fetch"
                        ? `Cannot reach gateway at ${gatewayUrl}. Is the service running?`
                        : err instanceof Error
                            ? err.message
                            : String(err);
                setError(new Error(message));
                setStatus("error");
            }
        },
        [endpointId, apiKey, gatewayUrl],
    );

    /** Reset chat history and server session for a new conversation. */
    const resetChat = useCallback(() => {
        abortRef.current?.abort();
        setMessages([]);
        setStatus("ready");
        setError(null);
        sessionIdRef.current = undefined;
    }, []);

    return {
        messages: messages,
        status: status,
        error: error,
        sendMessage: sendMessage,
        resetChat: resetChat,
    };
}
