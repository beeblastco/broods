"use client";

/**
 * Live PTY terminal for a workdir- or MicroVM-backed sandbox instance. Mints a
 * sealed terminal ticket through Convex, then bridges an xterm.js terminal to the
 * public gateway's terminal WebSocket (raw bytes both ways, no resize protocol).
 */

import { Button } from "@/app/components/ui/button";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { Plug, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

type TerminalStatus = "idle" | "connecting" | "live" | "ended" | "error";

interface Props {
    /** Sandbox config the instance belongs to. */
    sandboxId: Id<"sandboxConfigs">;
    /** Reservation key identifying the running instance. */
    reservationKey: string;
    /** Disable connecting (e.g. instance terminating). */
    disabled: boolean;
}

const STATUS_LABEL: Record<TerminalStatus, string> = {
    idle: "Not connected",
    connecting: "Connecting…",
    live: "Live",
    ended: "Session ended",
    error: "Connection error",
};

export function LiveSandboxTerminal({ sandboxId, reservationKey, disabled }: Props) {
    const openTerminal = useAction(api.sandboxPublic.openTerminal);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const termRef = useRef<{ dispose: () => void } | null>(null);
    const [status, setStatus] = useState<TerminalStatus>("idle");
    const [error, setError] = useState<string | null>(null);

    // Tear down the socket + terminal when the sheet unmounts.
    useEffect(() => {
        return () => {
            socketRef.current?.close(1000, "cleanup");
            socketRef.current = null;
            termRef.current?.dispose();
            termRef.current = null;
        };
    }, []);

    async function handleConnect() {
        const container = containerRef.current;
        if (!container || disabled) return;
        setStatus("connecting");
        setError(null);
        try {
            const endpoint = resolveCoreEndpoint();
            if (!endpoint.ok) throw new Error(endpoint.message);
            const ticket = await openTerminal({ sandboxId: sandboxId, reservationKey: reservationKey });
            // xterm touches the DOM at import time, so load it only in the browser.
            const [{ Terminal }, { FitAddon }] = await Promise.all([
                import("@xterm/xterm"),
                import("@xterm/addon-fit"),
            ]);

            socketRef.current?.close(1000, "reconnect");
            termRef.current?.dispose();
            container.innerHTML = "";

            const term = new Terminal({
                cursorBlink: true,
                fontSize: 12,
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                theme: { background: "#000000" },
            });
            const fit = new FitAddon();
            term.loadAddon(fit);
            term.open(container);
            fit.fit();
            termRef.current = term;

            const socket = new WebSocket(
                `${endpoint.websocketBaseUrl}${ticket.websocketPath}?token=${encodeURIComponent(ticket.token)}`,
            );
            socket.binaryType = "arraybuffer";
            socketRef.current = socket;

            socket.onopen = () => {
                if (socketRef.current !== socket) return;
                setStatus("live");
                term.focus();
            };
            socket.onmessage = (event) => {
                if (socketRef.current !== socket) return;
                term.write(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
            };
            socket.onclose = (event) => {
                if (socketRef.current !== socket) return;
                socketRef.current = null;
                setStatus(event.code === 1000 ? "ended" : "error");
                if (event.code !== 1000) setError(event.reason || `Connection closed (${event.code}).`);
                term.write("\r\n\x1b[2m[terminal session ended]\x1b[0m\r\n");
            };
            socket.onerror = () => {
                if (socketRef.current !== socket) return;
                setStatus("error");
                setError("WebSocket transport error.");
            };
            term.onData((data) => {
                if (socket.readyState === WebSocket.OPEN) socket.send(data);
            });
        } catch (err) {
            setStatus("error");
            setError(err instanceof Error ? err.message : "Failed to open the terminal");
        }
    }

    const connected = status === "live" || status === "connecting";

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                    Interactive shell inside the sandbox (a real in-guest TTY). Connecting resumes a
                    suspended instance.
                </p>
                <Button
                    type="button"
                    size="sm"
                    disabled={disabled || status === "connecting"}
                    onClick={handleConnect}
                    className="shrink-0 cursor-pointer disabled:cursor-not-allowed"
                >
                    {connected ? <RefreshCw className="mr-1 size-3.5" /> : <Plug className="mr-1 size-3.5" />}
                    {status === "idle" ? "Connect" : "Reconnect"}
                </Button>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-black p-2">
                <div ref={containerRef} className="h-80 w-full" />
            </div>
            <p className="text-xs text-muted-foreground">
                {STATUS_LABEL[status]}
                {error ? ` — ${error}` : ""}
            </p>
        </div>
    );
}
