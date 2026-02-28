"use client";

/** Tool configuration tab for editing source code only. */
import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toErrorMessage } from "@/lib/errors";
import { useMutation, useQuery } from "convex/react";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";

const DEFAULT_SOURCE = [
    "export async function handler(input) {",
    "  // Sandbox entrypoint: this function is called as handler(input).",
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
    '      message: "Tool executed inside sandbox process.",',
    "    },",
    "  };",
    "}",
    "",
    "export default handler;",
    "",
].join("\n");

export function ToolConfigTab({
    projectId,
    environmentId,
    nodeId,
    nodeLabel,
}: {
    projectId: Id<"projects"> | undefined;
    environmentId: Id<"environments"> | null;
    nodeId: string;
    nodeLabel: string;
}) {
    const canQueryTool = !!projectId && !!environmentId;
    const toolService = useQuery(
        api.toolService.getByNode,
        canQueryTool
            ? {
                projectId: projectId,
                environmentId: environmentId,
                nodeId: nodeId,
            }
            : "skip",
    );
    const upsertToolService = useMutation(api.toolService.upsertForNode);

    const [sourceCode, setSourceCode] = useState(DEFAULT_SOURCE);
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [savedToastVisible, setSavedToastVisible] = useState(false);

    const currentSource = toolService?.sourceCode ?? DEFAULT_SOURCE;

    useEffect(() => {
        if (toolService === undefined) return;
        setSourceCode(currentSource);
    }, [toolService, currentSource]);

    const hasUnsavedChanges = sourceCode !== currentSource;

    async function handleSave() {
        if (!projectId || !environmentId) {
            setSaveError("Select an environment before editing this tool.");

            return;
        }
        if (!nodeLabel.trim()) {
            setSaveError("Tool name cannot be empty.");

            return;
        }

        setIsSaving(true);
        setSaveError(null);
        try {
            await upsertToolService({
                projectId: projectId,
                environmentId: environmentId,
                nodeId: nodeId,
                nodeLabel: nodeLabel,
                sourceCode: sourceCode.trim().length > 0 ? sourceCode : DEFAULT_SOURCE,
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

    if (!environmentId) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Select an environment before editing this tool.
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
        <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
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

            <Textarea
                value={sourceCode}
                onChange={(e) => setSourceCode(e.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none bg-muted/50 font-mono text-xs"
            />

            {saveError && (
                <p className="text-xs text-destructive">{saveError}</p>
            )}

            <div className="flex items-center gap-2">
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
        </div>
    );
}
