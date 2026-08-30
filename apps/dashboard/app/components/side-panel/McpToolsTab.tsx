"use client";

/**
 * Tool explorer for MCP nodes: lists the server's live tools, expands each to
 * its schema, and runs one with JSON arguments.
 */
import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { ChevronRight, Loader2, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

interface RunResult {
  isError: boolean;
  text: string;
  durationMs: number;
}

export function McpToolsTab({
  projectId,
  stageId,
  nodeId,
}: {
  projectId: Id<"projects"> | undefined;
  stageId: Id<"stages"> | null;
  nodeId: string;
}): React.JSX.Element {
  const listTools = useAction(api.mcpService.listTools);

  const [tools, setTools] = useState<RemoteTool[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  // Loading is derived: a refresh clears both states in its event handler.
  const isListing = tools === null && listError === null;

  useEffect(() => {
    if (!projectId || !stageId) return;

    let cancelled = false;
    listTools({ projectId: projectId, stageId: stageId, nodeId: nodeId })
      .then((listing) => {
        if (!cancelled) setTools(listing as RemoteTool[]);
      })
      .catch((error: unknown) => {
        if (!cancelled) setListError(toErrorMessage(error));
      });

    return (): void => {
      cancelled = true;
    };
  }, [projectId, stageId, nodeId, refreshToken, listTools]);

  if (!projectId || !stageId) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          Select a stage before exploring this server.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {tools ? `Tools (${tools.length})` : "Tools"}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={isListing}
          onClick={() => {
            setTools(null);
            setListError(null);
            setRefreshToken((token) => token + 1);
          }}
        >
          {isListing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          Refresh
        </Button>
      </div>

      {listError && <p className="text-xs text-destructive">{listError}</p>}

      {tools?.length === 0 && !isListing && (
        <p className="text-xs text-muted-foreground">
          The server lists no tools. Save it from the Server tab first.
        </p>
      )}

      {tools?.map((tool) => (
        <ToolRow
          key={tool.name}
          projectId={projectId}
          stageId={stageId}
          nodeId={nodeId}
          tool={tool}
        />
      ))}
    </div>
  );
}

function ToolRow({
  projectId,
  stageId,
  nodeId,
  tool,
}: {
  projectId: Id<"projects">;
  stageId: Id<"stages">;
  nodeId: string;
  tool: RemoteTool;
}): React.JSX.Element {
  const callTool = useAction(api.mcpService.callTool);

  const [isOpen, setIsOpen] = useState(false);
  const [inputJson, setInputJson] = useState("{}");
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  async function handleRun(): Promise<void> {
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(inputJson);
    } catch {
      setRunError("Input must be valid JSON.");

      return;
    }

    setIsRunning(true);
    setRunError(null);
    setResult(null);
    try {
      const response = await callTool({
        projectId: projectId,
        stageId: stageId,
        nodeId: nodeId,
        toolName: tool.name,
        input: parsedInput,
      });
      setResult(toRunResult(response));
    } catch (error) {
      setRunError(toErrorMessage(error));
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-muted/20">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left"
        onClick={() => setIsOpen((open) => !open)}
      >
        <ChevronRight
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
        />
        <code className="text-xs font-medium text-foreground">{tool.name}</code>
        <span className="truncate text-xs text-muted-foreground">
          {tool.description ?? ""}
        </span>
      </button>

      {isOpen && (
        <div className="flex flex-col gap-2 border-t border-border/70 p-3">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Input Schema
          </span>
          <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] text-foreground">
            {JSON.stringify(tool.inputSchema ?? {}, null, 2)}
          </pre>

          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Try It (JSON arguments)
          </span>
          <Textarea
            value={inputJson}
            onChange={(e) => setInputJson(e.target.value)}
            spellCheck={false}
            className="min-h-16 resize-y bg-muted/50 font-mono text-xs"
          />

          {runError && <p className="text-xs text-destructive">{runError}</p>}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={isRunning}
              onClick={handleRun}
            >
              {isRunning ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Play className="size-3" />
              )}
              {isRunning ? "Running…" : "Run"}
            </Button>
            {result && (
              <span className="text-[11px] text-muted-foreground">
                {Math.round(result.durationMs)} ms
              </span>
            )}
          </div>

          {result && (
            <pre
              className={`max-h-56 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap wrap-break-word ${
                result.isError
                  ? "border-destructive/50 bg-destructive/10 text-destructive"
                  : "border-border bg-muted/40 text-foreground"
              }`}
            >
              {result.text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function toRunResult(response: {
  result: unknown;
  durationMs: number;
}): RunResult {
  const raw = response.result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  };
  const text =
    raw.structuredContent !== undefined
      ? JSON.stringify(raw.structuredContent, null, 2)
      : (raw.content ?? [])
          .map((block) =>
            typeof block.text === "string" ? block.text : `[${block.type}]`,
          )
          .join("\n");

  return {
    isError: raw.isError === true,
    text: text || "(empty result)",
    durationMs: response.durationMs,
  };
}
