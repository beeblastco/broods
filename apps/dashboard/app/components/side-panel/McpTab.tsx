"use client";

/**
 * Server tab for MCP nodes. Hosted mode edits Node source the dashboard
 * bundles and core probes in the sandboxed Lambda before the row is written;
 * external mode registers a pre-existing server by url + headers.
 */
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { toErrorMessage } from "@/app/lib/errors";
import { formatSource } from "@/app/lib/formatSource";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { Check } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";

// CodeMirror measures the DOM as it mounts, so it cannot be prerendered.
const CodeEditor = dynamic(
  () =>
    import("@/app/components/side-panel/CodeEditor").then((m) => m.CodeEditor),
  {
    ssr: false,
    loading: () => (
      <div className="h-[360px] rounded-md border border-input bg-muted/50" />
    ),
  },
);

const DEFAULT_SOURCE = [
  'import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";',
  'import { z } from "zod";',
  "",
  "// The factory runs once per request (stateless hosting). Register as many",
  "// tools as you want; agents see each as <node-name>__<tool-name>.",
  "export default createMcpHandler(() => {",
  '  const server = new McpServer({ name: "my-server", version: "1.0.0" });',
  "",
  "  server.registerTool(",
  '    "hello",',
  "    {",
  '      description: "Say hello",',
  "      inputSchema: { name: z.string() },",
  "    },",
  "    async ({ name }) => ({",
  '      content: [{ type: "text", text: `Hello, ${name}!` }],',
  "    }),",
  "  );",
  "",
  "  return server;",
  "});",
  "",
].join("\n");

type SaveState =
  | { kind: "idle" }
  | { kind: "saved"; toolCount: number; verified: boolean };

export function McpTab({
  projectId,
  stageId,
  nodeId,
  nodeLabel,
}: {
  projectId: Id<"projects"> | undefined;
  stageId: Id<"stages"> | null;
  nodeId: string;
  nodeLabel: string;
}): React.JSX.Element {
  const canQuery = !!projectId && !!stageId;
  const server = useQuery(
    api.mcp.getByNode,
    canQuery
      ? { projectId: projectId, stageId: stageId, nodeId: nodeId }
      : "skip",
  );
  const saveForNode = useAction(api.mcp.saveForNode);

  const form = useServerForm(server);
  const {
    activeTransport,
    headersJson,
    setHeadersJson,
    setSourceCode,
    setTransport,
    setUrl,
    sourceCode,
    url,
  } = form;
  const [isSaving, setIsSaving] = useState(false);
  const [isFormatting, setIsFormatting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });

  async function handleFormat(): Promise<void> {
    setIsFormatting(true);
    setSaveError(null);
    try {
      setSourceCode(await formatSource(sourceCode));
    } catch (error) {
      setSaveError(toErrorMessage(error));
    } finally {
      setIsFormatting(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (!projectId || !stageId) {
      setSaveError("Select a stage before saving this server.");

      return;
    }

    setIsSaving(true);
    setSaveError(null);
    setSaveState({ kind: "idle" });
    try {
      const headers = parseHeaders(headersJson);
      const shared = {
        projectId: projectId,
        stageId: stageId,
        nodeId: nodeId,
        nodeLabel: nodeLabel,
        ...(headers !== undefined ? { headers: headers } : {}),
      };
      let result: { verified: boolean; tools: unknown[] };
      if (activeTransport === "hosted") {
        result = await saveForNode({
          ...shared,
          bundle: await bundleSource(sourceCode),
          sourceCode: sourceCode,
        });
      } else {
        result = await saveForNode({ ...shared, url: url.trim() });
      }
      setSaveState({
        kind: "saved",
        toolCount: result.tools.length,
        verified: result.verified,
      });
    } catch (error) {
      setSaveError(toErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  if (!canQuery) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          Select a stage before editing this server.
        </p>
      </div>
    );
  }
  if (server === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          Loading server configuration…
        </p>
      </div>
    );
  }
  if (
    server &&
    server.transport === "hosted" &&
    server.sourceCode === undefined
  ) {
    // A CLI-uploaded hosted row carries no source: editing this tab's
    // template over the real bundle would overwrite it, so the editor gives way.
    return <BundleManagedNotice server={server} />;
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Transport
        </span>
        <TransportToggle active={activeTransport} onChange={setTransport} />
      </div>

      {activeTransport === "hosted" ? (
        <>
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Server Code (Node · @modelcontextprotocol/server + zod)
          </span>
          <p className="text-xs text-muted-foreground">
            Save bundles the code, runs it in the sandbox, and lists its tools;
            a server that fails to build or answer never uploads.
          </p>
          <CodeEditor value={sourceCode} onChange={setSourceCode} />
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Server URL
            </span>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/mcp"
              className="h-8 font-mono text-xs"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            The server must speak MCP spec 2026-07-28; older protocol revisions
            are refused at save with a negotiation error.
          </p>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Headers (JSON, optional)
        </span>
        <Textarea
          value={headersJson}
          onChange={(e) => setHeadersJson(e.target.value)}
          spellCheck={false}
          placeholder={'{\n  "Authorization": "Bearer ${MY_TOKEN}"\n}'}
          className="min-h-16 resize-y bg-muted/50 font-mono text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          Credential headers must reference an account env var like{" "}
          <code>{"${NAME}"}</code>; it resolves at agent sync, never stored
          here.
        </p>
      </div>

      {saveError && <p className="text-xs text-destructive">{saveError}</p>}

      <div className="flex items-center gap-2">
        {activeTransport === "hosted" && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={isFormatting || isSaving}
            onClick={handleFormat}
          >
            {isFormatting ? "Formatting…" : "Format"}
          </Button>
        )}
        <Button
          size="sm"
          className="h-8 text-xs"
          disabled={isSaving}
          onClick={handleSave}
        >
          {isSaving ? "Verifying…" : "Save Server"}
        </Button>
        <SavedBadge state={saveState} />
      </div>
    </div>
  );
}

function TransportToggle({
  active,
  onChange,
}: {
  active: "hosted" | "http";
  onChange: (transport: "hosted" | "http") => void;
}): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant={active === "hosted" ? "default" : "outline"}
        className="h-8 text-xs"
        onClick={() => onChange("hosted")}
      >
        Hosted (write Node code)
      </Button>
      <Button
        size="sm"
        variant={active === "http" ? "default" : "outline"}
        className="h-8 text-xs"
        onClick={() => onChange("http")}
      >
        External URL
      </Button>
    </div>
  );
}

function SavedBadge({ state }: { state: SaveState }): React.JSX.Element | null {
  if (state.kind !== "saved") return null;

  return (
    <span className="flex items-center gap-1 text-xs text-emerald-500">
      <Check className="size-3" />
      {state.verified
        ? `Verified · ${state.toolCount} tool${state.toolCount === 1 ? "" : "s"}`
        : "Saved (probe skipped: env-ref headers)"}
    </span>
  );
}

/** Form state seeded from the saved row; synced during render, not an effect. */
function useServerForm(server: Doc<"mcp"> | null | undefined): {
  activeTransport: "hosted" | "http";
  headersJson: string;
  setHeadersJson: (value: string) => void;
  setSourceCode: (value: string) => void;
  setTransport: (value: "hosted" | "http") => void;
  setUrl: (value: string) => void;
  sourceCode: string;
  url: string;
} {
  const [transport, setTransport] = useState<"hosted" | "http" | null>(null);
  const [sourceCode, setSourceCode] = useState(DEFAULT_SOURCE);
  const [url, setUrl] = useState("");
  const [headersJson, setHeadersJson] = useState("");
  const [syncedServer, setSyncedServer] = useState<unknown>(undefined);
  if (server !== undefined && server !== syncedServer) {
    setSyncedServer(server);
    if (server) {
      setTransport(server.transport);
      setSourceCode(server.sourceCode ?? DEFAULT_SOURCE);
      setUrl(server.url ?? "");
      setHeadersJson(
        server.headers ? JSON.stringify(server.headers, null, 2) : "",
      );
    }
  }

  return {
    activeTransport: transport ?? server?.transport ?? "hosted",
    headersJson: headersJson,
    setHeadersJson: setHeadersJson,
    setSourceCode: setSourceCode,
    setTransport: setTransport,
    setUrl: setUrl,
    sourceCode: sourceCode,
    url: url,
  };
}

/** CLI-owned hosted rows: the source lives in the user's project, not here. */
function BundleManagedNotice({
  server,
}: {
  server: Doc<"mcp">;
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-3 p-4">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
        Bundle
      </span>
      <p className="text-xs text-muted-foreground">
        This server was uploaded by the CLI or SDK, which bundles it from your
        project. The source stays with your code — run <code>broods dev</code>{" "}
        or <code>broods deploy</code> to change it.
      </p>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Checksum
        </span>
        <code className="break-all text-xs text-foreground">
          {server.sha256}
        </code>
      </div>
    </div>
  );
}

async function bundleSource(sourceCode: string): Promise<string> {
  const response = await fetch("/api/mcp/bundle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceCode: sourceCode }),
  });
  const body = (await response.json()) as { bundle?: string; error?: string };
  if (!response.ok || typeof body.bundle !== "string") {
    throw new Error(body.error ?? "MCP server failed to build");
  }

  return body.bundle;
}

function parseHeaders(headersJson: string): Record<string, string> | undefined {
  if (!headersJson.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(headersJson);
  } catch {
    throw new Error("Headers must be valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== "string")
  ) {
    throw new Error("Headers must be an object of string values.");
  }

  return parsed as Record<string, string>;
}
