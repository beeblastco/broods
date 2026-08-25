"use client";

/**
 * Tool configuration tab: edits how a tool executes AND the
 * `tools.<nodeLabel>` slice of the connected agent (enabled, needsApproval,
 * async, execution, env, tool-specific options) per broods AgentToolConfig.
 * Execution is either inline source (bundled to S3 on save) or — for
 * docker-sourced nodes — an https endpoint the tool POSTs its input to.
 */
import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import {
  readAgentBranch,
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { toErrorMessage } from "@/app/lib/errors";
import { formatSource } from "@/app/lib/formatSource";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { Check } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useRef, useState } from "react";

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

const TOOL_OPTIONS_PLACEHOLDER = JSON.stringify(
  {
    enabled: true,
    needsApproval: false,
    async: false,
    execution: "same-invocation",
    env: {},
  },
  null,
  2,
);

const INPUT_SCHEMA_PLACEHOLDER = JSON.stringify(
  {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look up." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  null,
  2,
);

const DEFAULT_SOURCE = [
  "export async function handler(input) {",
  "  // Executor entrypoint: this function is called as handler(input).",
  "  // The return structure is aligned with the vercel AI SDK tool output formats",
  "  //",
  "  // You can return either:",
  "  // 1) Plain values (string/object/array/number/boolean/null).",
  '  //    - string -> { type: "text", value: "..." }',
  '  //    - everything else -> { type: "json", value: ... }',
  "  // 2) Full ToolResultOutput object (recommended when you need control), e.g.",
  '  //    { type: "text", value: "done" }',
  '  //    { type: "json", value: { ok: true } }',
  "  //    {",
  '  //      type: "content",',
  "  //      value: [",
  '  //        { type: "image-data", data: "<base64>", mediaType: "image/png" },',
  "  //      ],",
  "  //    }",
  "  //",
  "  // Throw an Error to return a tool error.",
  "  return {",
  '    type: "json",',
  "    value: {",
  '      tool: "custom_tool",',
  "      received: input,",
  '      message: "Tool executed by the configured executor.",',
  "    },",
  "  };",
  "}",
  "",
  "export default handler;",
  "",
].join("\n");

const ENDPOINT_HEADERS_PLACEHOLDER = JSON.stringify(
  {
    Authorization: "Bearer ${API_TOKEN}",
    "X-Tool-Source": "broods",
  },
  null,
  2,
);

/**
 * Parses the headers textarea into the record `saveForNode` expects. Values
 * may carry `${NAME}` references — they resolve against Tool Options env when
 * the agent calls the tool, never inside the dashboard.
 */
function parseEndpointHeaders(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim() || "{}");
  } catch {
    throw new Error("Headers must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Headers must be a JSON object.");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`Header "${key}" must be a string.`);
    }
  }

  return parsed as Record<string, string>;
}

export function ToolConfigTab({
  projectId,
  stageId,
  nodeId,
  nodeLabel,
  nodeConfig,
}: {
  projectId: Id<"projects"> | undefined;
  stageId: Id<"stages"> | null;
  nodeId: string;
  nodeLabel: string;
  nodeConfig?: Record<string, unknown>;
}): React.JSX.Element {
  const canQueryTool = !!projectId && !!stageId;
  const toolService = useQuery(
    api.toolService.getByNode,
    canQueryTool
      ? {
          projectId: projectId,
          stageId: stageId,
          nodeId: nodeId,
        }
      : "skip",
  );
  // An action, not a mutation: saving bundles the source to S3 so the agent can
  // actually call the tool. That rules out an optimistic update.
  const upsertToolService = useAction(api.toolService.saveForNode);
  const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId);
  const toolKey = nodeLabel.trim() || nodeId;
  const toolOptions = useMemo(() => {
    if (!agentConfig) return undefined;
    const tools = readAgentBranch<Record<string, unknown>>(
      agentConfig as FlatAgentConfig,
      "tools",
    );

    return tools[toolKey] ?? {};
  }, [agentConfig, toolKey]);

  const bundleUrlForNode = useAction(api.toolService.bundleUrlForNode);

  const [sourceCode, setSourceCode] = useState(DEFAULT_SOURCE);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedToastVisible, setSavedToastVisible] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isFormatting, setIsFormatting] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const currentEndpointUrl = toolService?.endpointUrl ?? "";
  const currentEndpointHeadersText = JSON.stringify(
    toolService?.endpointHeaders ?? {},
    null,
    2,
  );
  const [endpointUrl, setEndpointUrl] = useState(currentEndpointUrl);
  const [endpointHeadersText, setEndpointHeadersText] = useState(
    currentEndpointHeadersText,
  );
  // Same load-from-row pattern as the source: reactive row updates overwrite
  // the form once they resolve or change.
  const [syncedEndpointUrl, setSyncedEndpointUrl] =
    useState(currentEndpointUrl);
  const [syncedEndpointHeaders, setSyncedEndpointHeaders] = useState(
    currentEndpointHeadersText,
  );

  if (toolService !== undefined && currentEndpointUrl !== syncedEndpointUrl) {
    setSyncedEndpointUrl(currentEndpointUrl);
    setEndpointUrl(currentEndpointUrl);
  }
  if (
    toolService !== undefined &&
    currentEndpointHeadersText !== syncedEndpointHeaders
  ) {
    setSyncedEndpointHeaders(currentEndpointHeadersText);
    setEndpointHeadersText(currentEndpointHeadersText);
  }

  // The upload source flow only fronts the editor until the first save lands;
  // afterwards the tool is an ordinary source-managed one and the section goes.
  const showUpload =
    toolService === null && nodeConfig?.toolSource === "upload";

  async function handleUploadFile(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!/\.(js|mjs)$/.test(file.name)) {
      setSaveError(
        "Upload a .js or .mjs file — other languages are not supported yet.",
      );

      return;
    }

    try {
      setSourceCode(await file.text());
      setSaveError(null);
    } catch (error) {
      setSaveError(toErrorMessage(error));
    }
  }

  // The CLI bundles a tool locally and uploads the artifact, so an uploaded row
  // carries no source. Editing here would bundle this tab's placeholder over
  // the real tool, so the editor gives way to the bundle it actually runs.
  // An http tool also carries no source — it POSTs to its own endpoint instead.
  const isHttpTool = toolService?.runtime === "http";
  const isEndpointTool =
    isHttpTool || (toolService === null && nodeConfig?.toolSource === "docker");
  const isBundleManaged =
    toolService !== null &&
    toolService !== undefined &&
    toolService.sourceCode === undefined &&
    !isHttpTool;

  const currentSource = toolService?.sourceCode ?? DEFAULT_SOURCE;
  const [syncedSource, setSyncedSource] = useState(currentSource);

  // Load the editor with the saved source once it resolves or changes (set
  // during render instead of in an effect to avoid a cascading re-render).
  if (toolService !== undefined && currentSource !== syncedSource) {
    setSyncedSource(currentSource);
    setSourceCode(currentSource);
  }

  const hasUnsavedChanges = isEndpointTool
    ? endpointUrl !== currentEndpointUrl ||
      endpointHeadersText !== currentEndpointHeadersText
    : sourceCode !== currentSource;

  async function handleDownload() {
    if (!projectId || !stageId) {
      setDownloadError("Select a stage before downloading this bundle.");

      return;
    }

    setIsDownloading(true);
    setDownloadError(null);
    try {
      const url = await bundleUrlForNode({
        projectId: projectId,
        stageId: stageId,
        nodeId: nodeId,
      });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setDownloadError(toErrorMessage(error));
    } finally {
      setIsDownloading(false);
    }
  }

  async function handleFormat() {
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

  async function handleSave() {
    if (!projectId || !stageId) {
      setSaveError("Select a stage before editing this tool.");

      return;
    }
    if (!nodeLabel.trim()) {
      setSaveError("Tool name cannot be empty.");

      return;
    }

    setIsSaving(true);
    setSaveError(null);
    try {
      if (isEndpointTool) {
        const headers = parseEndpointHeaders(endpointHeadersText);
        // A blank URL on an unsaved row has nothing to send; on a saved row it
        // means "keep the stored endpoint".
        if (!endpointUrl.trim() && !toolService) {
          throw new Error("Endpoint URL is required.");
        }
        await upsertToolService({
          projectId: projectId,
          stageId: stageId,
          nodeId: nodeId,
          nodeLabel: nodeLabel,
          ...(endpointUrl.trim() ? { endpointUrl: endpointUrl.trim() } : {}),
          endpointHeaders: headers,
        });
        setSavedToastVisible(true);
        setTimeout(() => setSavedToastVisible(false), 2000);

        return;
      }

      const draft = sourceCode.trim().length > 0 ? sourceCode : DEFAULT_SOURCE;
      // Formatting on the way out keeps what is stored canonical, and a syntax
      // error surfaces here rather than as a tool failure mid-run.
      const formatted = await formatSource(draft);
      setSourceCode(formatted);
      await upsertToolService({
        projectId: projectId,
        stageId: stageId,
        nodeId: nodeId,
        nodeLabel: nodeLabel,
        sourceCode: formatted,
      });
      setSavedToastVisible(true);
      setTimeout(() => setSavedToastVisible(false), 2000);
    } catch (error) {
      setSaveError(toErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  if (!projectId) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          Cannot resolve project context for this tool.
        </p>
      </div>
    );
  }

  if (!stageId) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          Select a stage before editing this tool.
        </p>
      </div>
    );
  }

  if (toolService === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          Loading tool configuration…
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
      {agentConfig ? (
        <BranchEditor
          title="Tool Options"
          value={toolOptions}
          placeholder={TOOL_OPTIONS_PLACEHOLDER}
          onSave={async (value) => {
            const nested = toNestedAgentConfig(
              agentConfig as FlatAgentConfig,
            ) as Record<string, unknown>;
            const tools: Record<string, unknown> = {
              ...(nested.tools as Record<string, unknown> | undefined),
            };
            if (value === undefined) {
              delete tools[toolKey];
            } else {
              tools[toolKey] = value;
            }
            await updateBranch(
              ["tools"],
              Object.keys(tools).length > 0 ? tools : undefined,
            );
          }}
        />
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Wire this tool to an agent to edit its options.
        </p>
      )}

      {/* An uploaded tool carries the schema its project declared. Everything
          else needs one here, or the model is offered a tool with no arguments.
          Only once the source exists: saving a schema alone has nothing to
          bundle, so the tool has to be created below first. */}
      {toolService && !isBundleManaged && (
        <BranchEditor
          title="Input Schema"
          value={toolService.inputSchema}
          placeholder={INPUT_SCHEMA_PLACEHOLDER}
          onSave={async (value) => {
            await upsertToolService({
              projectId: projectId,
              stageId: stageId,
              nodeId: nodeId,
              nodeLabel: nodeLabel,
              inputSchema: value ?? {},
            });
          }}
        />
      )}

      {isBundleManaged ? (
        <>
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Bundle
          </span>
          <p className="text-xs text-muted-foreground">
            This tool was uploaded by the CLI or SDK, which bundles it from your
            project. The source stays with your code, so there is nothing to
            edit here — run <code>broods dev</code> or{" "}
            <code>broods deploy</code> to change it.
          </p>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Checksum
            </span>
            <code className="break-all text-xs text-foreground">
              {toolService.sha256}
            </code>
          </div>

          {downloadError && (
            <p className="text-xs text-destructive">{downloadError}</p>
          )}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={isDownloading}
              onClick={handleDownload}
            >
              {isDownloading ? "Preparing…" : "Download Bundle"}
            </Button>
          </div>
        </>
      ) : isEndpointTool ? (
        <>
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Endpoint
          </span>
          <p className="text-xs text-muted-foreground">
            Every call POSTs the tool input as JSON to your service over HTTPS.
            Header values may reference <code>{"${NAME}"}</code> variables from
            Tool Options env — secrets resolve at run time and are never stored
            on this node.
          </p>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Endpoint URL
            </span>
            <Input
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              placeholder="https://api.example.com/tools/lookup"
              className="h-8 text-xs"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Headers
            </span>
            <Textarea
              value={endpointHeadersText}
              onChange={(e) => setEndpointHeadersText(e.target.value)}
              placeholder={ENDPOINT_HEADERS_PLACEHOLDER}
              className="min-h-[120px] font-mono text-xs"
            />
          </div>

          {saveError && <p className="text-xs text-destructive">{saveError}</p>}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={isSaving || !hasUnsavedChanges}
              onClick={handleSave}
            >
              {isSaving ? "Saving…" : "Save Endpoint"}
            </Button>
            {savedToastVisible && (
              <span className="flex items-center gap-1 text-xs text-emerald-500">
                <Check className="size-3" /> Saved
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          {showUpload && (
            <div className="flex flex-col gap-2">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Upload source
              </span>
              <button
                type="button"
                className="cursor-pointer rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-center hover:bg-muted/40"
                onClick={() => uploadInputRef.current?.click()}
              >
                <p className="text-xs font-medium text-foreground/80">
                  Choose a .js or .mjs file
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Loaded into the editor below — review it, then Save Source
                  Code.
                </p>
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                accept=".js,.mjs"
                className="hidden"
                onChange={handleUploadFile}
              />
            </div>
          )}

          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Source Code
          </span>
          <p className="text-xs text-muted-foreground">
            Return format is aligned with Vercel AI SDK tool outputs (
            <a
              href="https://ai-sdk.dev/docs/foundations/tools"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              tools
            </a>
            {" / "}
            <a
              href="https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              tool calling
            </a>
            ).
          </p>

          <CodeEditor value={sourceCode} onChange={setSourceCode} />

          {saveError && <p className="text-xs text-destructive">{saveError}</p>}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={isFormatting || isSaving}
              onClick={handleFormat}
            >
              {isFormatting ? "Formatting…" : "Format"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={isSaving || !hasUnsavedChanges}
              onClick={handleSave}
            >
              {isSaving ? "Saving…" : "Save Source Code"}
            </Button>
            {savedToastVisible && (
              <span className="flex items-center gap-1 text-xs text-emerald-500">
                <Check className="size-3" /> Saved
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
