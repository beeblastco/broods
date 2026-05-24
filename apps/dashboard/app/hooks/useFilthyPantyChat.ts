"use client";

/**
 * Minimal streaming chat hook against filthy-panty's harness via the
 * /api/agent/stream proxy route. Consumes the Vercel AI SDK fullStream
 * SSE format (text-delta / tool-call / finish chunks) and exposes a
 * simple {role, text} message list.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
    id: string;
    role: ChatRole;
    text: string;
}

export type ChatStatus = "ready" | "streaming" | "error";

interface UseFilthyPantyChatArgs {
    /** filthy-panty agent id (the `agents._id` from cherry-coke's Convex submodule). */
    agentId: string | null;
    /** Optional stable conversation key — same key continues the same thread. */
    conversationKey?: string;
}

/** Generate a short random id for events / messages. */
function shortId(prefix: string): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

interface FullStreamChunk {
    type: string;
    text?: string;
    delta?: string;
    error?: string;
    [key: string]: unknown;
}

/** Pulls text out of a Vercel AI SDK fullStream chunk. Returns "" for non-text chunks. */
function extractDeltaText(chunk: FullStreamChunk): string {
    if (chunk.type === "text-delta") {
        // AI SDK v5: { type: "text-delta", text: "..." } or { delta: "..." }
        return (chunk.text as string | undefined) ?? (chunk.delta as string | undefined) ?? "";
    }
    return "";
}

/** Streaming chat hook backed by filthy-panty. */
export function useFilthyPantyChat({ agentId, conversationKey }: UseFilthyPantyChatArgs) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [status, setStatus] = useState<ChatStatus>("ready");
    const [error, setError] = useState<Error | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const conversationKeyRef = useRef<string>(conversationKey ?? shortId("conv"));

    useEffect(() => {
        if (conversationKey) {
            conversationKeyRef.current = conversationKey;
        }
    }, [conversationKey]);

    useEffect(() => {
        return () => {
            abortRef.current?.abort();
        };
    }, []);

    const reset = useCallback(() => {
        abortRef.current?.abort();
        setMessages([]);
        setStatus("ready");
        setError(null);
        conversationKeyRef.current = shortId("conv");
    }, []);

    const sendMessage = useCallback(
        async (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return;
            if (!agentId) {
                setError(new Error("No agent selected"));
                setStatus("error");
                return;
            }

            const userMessage: ChatMessage = {
                id: shortId("msg"),
                role: "user",
                text: trimmed,
            };
            const assistantMessage: ChatMessage = {
                id: shortId("msg"),
                role: "assistant",
                text: "",
            };
            setMessages((prev) => [...prev, userMessage, assistantMessage]);
            setStatus("streaming");
            setError(null);

            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;

            try {
                const response = await fetch("/api/agent/stream", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        eventId: shortId("evt"),
                        conversationKey: conversationKeyRef.current,
                        agentId: agentId,
                        events: [{ role: "user", content: trimmed }],
                    }),
                    signal: controller.signal,
                });

                if (!response.ok || !response.body) {
                    const errText = await response.text().catch(() => response.statusText);
                    throw new Error(`Stream failed (${response.status}): ${errText}`);
                }

                const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
                let buffer = "";
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += value;
                    // Split on SSE record terminator
                    const records = buffer.split(/\n\n/);
                    buffer = records.pop() ?? "";
                    for (const record of records) {
                        const dataLines = record
                            .split(/\n/)
                            .filter((line) => line.startsWith("data:"))
                            .map((line) => line.slice("data:".length).trim());
                        for (const dataLine of dataLines) {
                            if (!dataLine) continue;
                            let chunk: FullStreamChunk;
                            try {
                                chunk = JSON.parse(dataLine);
                            } catch {
                                continue;
                            }
                            if (chunk.type === "error" && typeof chunk.error === "string") {
                                throw new Error(chunk.error);
                            }
                            const delta = extractDeltaText(chunk);
                            if (delta) {
                                setMessages((prev) =>
                                    prev.map((m) =>
                                        m.id === assistantMessage.id
                                            ? { ...m, text: m.text + delta }
                                            : m,
                                    ),
                                );
                            }
                        }
                    }
                }
                setStatus("ready");
            } catch (err) {
                if ((err as Error).name === "AbortError") return;
                const e = err instanceof Error ? err : new Error(String(err));
                setError(e);
                setStatus("error");
            }
        },
        [agentId],
    );

    return {
        messages: messages,
        status: status,
        error: error,
        sendMessage: sendMessage,
        reset: reset,
        conversationKey: conversationKeyRef.current,
    };
}
