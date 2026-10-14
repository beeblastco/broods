"use client";

/**
 * Mints a sealed terminal ticket through Convex, then bridges xterm.js to the
 * gateway's terminal WebSocket. Raw bytes both ways, no resize protocol. The
 * shell fills the dock edge to edge and outlives reconnects; its state and
 * Reconnect sit in the dock's header, through `controls`.
 */

import { CONNECTION_TONE, StatusDot } from "@/app/components/StatusDot";
import { Button } from "@/app/components/ui/button";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useAction } from "convex/react";
import { Plug, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toErrorMessage } from "@/app/lib/errors";

type TerminalStatus = keyof typeof CONNECTION_TONE;

// Before the first connect the header shows only the Connect button.
const STATUS_LABEL: Record<Exclude<TerminalStatus, "idle">, string> = {
  connecting: "Connecting",
  live: "Connected",
  ended: "Session ended",
  error: "Disconnected",
};

// Dim, then reset: notes the dashboard writes between shell output.
const note = (text: string): string => `\r\n\x1b[2m${text}\x1b[0m\r\n`;

interface Props {
  sandboxId: Id<"sandboxConfigs">;
  reservationKey: string;
  /** Blocks connecting, e.g. while the instance is terminating. */
  disabled: boolean;
  /** The dock header slot the connection state and Reconnect render into. */
  controls: HTMLElement | null;
}

export function LiveSandboxTerminal({
  sandboxId,
  reservationKey,
  disabled,
  controls,
}: Props): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const openTerminal = useAction(api.sandbox.public.openTerminal);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [term, setTerm] = useState<Terminal | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  // The shell is drawn as soon as the dock opens. The disposed flag stops a
  // handleConnect still awaiting its ticket from opening a live PTY socket
  // (which resumes a suspended instance) that nothing would close.
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    const container = containerRef.current;
    // Per run, not the ref: a remount clears the ref before the first run's
    // import settles, and both would draw a terminal.
    let cancelled = false;
    let dispose = (): void => {};
    // xterm touches the DOM at import time, so load it only in the browser.
    void (async (): Promise<void> => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled || !container) return;
      // xterm measures its cell on a canvas, where a CSS variable does not
      // resolve: it would size cells for a fallback font and space the real
      // glyphs apart. Hand it the concrete stack and colors the classes set.
      const style = getComputedStyle(container);
      const color = (token: string): string =>
        style.getPropertyValue(`--color-terminal-${token}`).trim();
      const next = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        lineHeight: 1.2,
        fontFamily: style.fontFamily,
        theme: {
          background: color("background"),
          foreground: color("foreground"),
          cursor: color("foreground"),
          selectionBackground: color("subtle"),
        },
      });
      const fit = new FitAddon();
      next.loadAddon(fit);
      next.open(container);
      fit.fit();
      // The dock is user-resizable, so the grid has to follow it.
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(container);
      const input = next.onData((data) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.send(data);
      });
      dispose = (): void => {
        input.dispose();
        observer.disconnect();
        next.dispose();
      };
      setTerm(next);
    })();

    return () => {
      cancelled = true;
      disposedRef.current = true;
      socketRef.current?.close(1000, "cleanup");
      socketRef.current = null;
      dispose();
    };
  }, []);

  async function handleConnect(): Promise<void> {
    if (!term || disabled) return;
    setStatus("connecting");
    setError(null);
    socketRef.current?.close(1000, "reconnect");
    socketRef.current = null;
    try {
      const endpoint = resolveCoreEndpoint();
      if (!endpoint.ok) throw new Error(endpoint.message);
      const ticket = await openTerminal({
        sandboxId: sandboxId,
        reservationKey: reservationKey,
      });
      if (disposedRef.current) return;

      // The ticket rides the subprotocol, not the query string, which lands
      // in access logs.
      const socket = new WebSocket(
        `${endpoint.websocketBaseUrl}${ticket.websocketPath}`,
        ["broods.v1", `broods.token.${ticket.token}`],
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
        term.write(
          typeof event.data === "string"
            ? event.data
            : new Uint8Array(event.data as ArrayBuffer),
        );
      };
      socket.onclose = (event) => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        setStatus(event.code === 1000 ? "ended" : "error");
        if (event.code !== 1000)
          setError(event.reason || `Connection closed (${event.code}).`);
        term.write(note("[terminal session ended]"));
      };
      socket.onerror = () => {
        if (socketRef.current !== socket) return;
        setStatus("error");
        setError("WebSocket transport error.");
      };
    } catch (err) {
      setStatus("error");
      setError(toErrorMessage(err));
      term.write(note(`[could not connect: ${toErrorMessage(err)}]`));
    }
  }

  // Opening the terminal is the ask to connect, once the shell is drawn and
  // the sandbox can take it. Reconnect is for after.
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (autoConnectedRef.current || !term || !canWrite || disabled) return;
    autoConnectedRef.current = true;
    void handleConnect();
  });

  return (
    <>
      {controls &&
        createPortal(
          <>
            {(disabled || status !== "idle") && (
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <StatusDot tone={CONNECTION_TONE[status]} label={status} />
                <span className="shrink-0">
                  {disabled || status === "idle"
                    ? "Waiting for the sandbox"
                    : STATUS_LABEL[status]}
                </span>
                {error && (
                  <span className="truncate text-destructive" title={error}>
                    {error}
                  </span>
                )}
              </span>
            )}
            {canWrite && status !== "connecting" && (
              <Button
                type="button"
                variant={status === "idle" ? "default" : "ghost"}
                size="xs"
                tone={status === "idle" ? "default" : "muted"}
                disabled={disabled || !term}
                onClick={handleConnect}
                className="cursor-pointer"
              >
                {status === "idle" ? <Plug /> : <RefreshCw />}
                {status === "idle" ? "Connect" : "Reconnect"}
              </Button>
            )}
          </>,
          controls,
        )}
      <div className="flex min-h-0 flex-1 bg-terminal-background py-2 pl-3">
        <div ref={containerRef} className="h-full min-h-40 w-full font-mono" />
      </div>
    </>
  );
}
