"use client";

/**
 * One shell in the sandbox dock: mints a sealed terminal ticket through Convex,
 * then bridges xterm.js to the gateway's terminal WebSocket. Raw bytes both
 * ways, no resize protocol. The shell is drawn when it mounts and keeps its
 * scrollback across reconnects; it connects only on the Connect button, which
 * stands over the empty shell and under the output once a session ends.
 */

import { Button } from "@/app/components/ui/button";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useAction } from "convex/react";
import { Plug } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type TerminalStatus = "idle" | "connecting" | "live" | "ended" | "error";

interface Props {
  sandboxId: Id<"sandboxConfigs">;
  reservationKey: string;
  /** Blocks connecting, e.g. while the instance is terminating. */
  disabled: boolean;
  /** Names the shell under its first Connect button, e.g. "cfbox · Shell 2". */
  label: string;
}

export function LiveSandboxTerminal({
  sandboxId,
  reservationKey,
  disabled,
  label,
}: Props): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const openTerminal = useAction(api.sandbox.public.openTerminal);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [term, setTerm] = useState<Terminal | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("idle");

  // The disposed flag stops a handleConnect still awaiting its ticket from
  // opening a live PTY socket (which resumes a suspended instance) that
  // nothing would close.
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
        term.write(
          note(
            event.code === 1000
              ? "[session ended]"
              : `[disconnected: ${event.reason || `code ${event.code}`}]`,
          ),
        );
      };
      socket.onerror = () => {
        if (socketRef.current !== socket) return;
        setStatus("error");
      };
    } catch (err) {
      if (disposedRef.current) return;
      setStatus("error");
      term.write(note(`[could not connect: ${toErrorMessage(err)}]`));
    }
  }

  const blocked = disabled || !term || status === "connecting";
  const connect = canWrite ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={blocked}
      onClick={handleConnect}
      className={blocked ? "cursor-not-allowed" : "cursor-pointer"}
    >
      <Plug />
      {status === "connecting" ? "Connecting" : "Connect"}
    </Button>
  ) : (
    <p className="text-xs text-terminal-muted">
      Your role cannot open a shell.
    </p>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-terminal-background">
      <div className="flex min-h-0 flex-1 py-2 pl-3">
        <div ref={containerRef} className="h-full min-h-40 w-full font-mono" />
      </div>
      {status === "idle" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-terminal-background">
          {connect}
          <p className="text-2xs text-terminal-muted">{label}</p>
        </div>
      )}
      {(status === "ended" || status === "error") && (
        <div className="px-3 pb-3">{connect}</div>
      )}
    </div>
  );
}

// Dim, then reset: a note the dashboard writes between shell output.
function note(text: string): string {
  return `\r\n\x1b[2m${text}\x1b[0m\r\n`;
}
