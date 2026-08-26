"use client";

/**
 * Admin-side agent settings: guardrail policies, provider tools, structured
 * output, and the collapsed Advanced raw-config editor. These sections moved
 * out of Details (ticket 16 — Details is the identity card now); the Advanced
 * editor replaces the retired Config tab and saves through the branch-merge
 * path so unrendered config branches survive (00 §2a defect fix).
 */

import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import {
  ExpandBlock,
  ToggleRow,
} from "@/app/components/side-panel/ConfigControls";
import { Button } from "@/app/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/app/components/ui/collapsible";
import { Separator } from "@/app/components/ui/separator";
import { Switch } from "@/app/components/ui/switch";
import { Textarea } from "@/app/components/ui/textarea";
import {
  readAgentBranch,
  readAgentPolicies,
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { isPlainObject } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { ChevronRight } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { AccountModelProviderName } from "@broods/convex/model/modelProviders";

type OutputFormatConfig = {
  type?: string;
  name?: string;
  description?: string;
  schema?: Record<string, unknown>;
};

const DEFAULT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    answer: { type: "string" },
  },
  required: ["answer"],
};

export function AgentAdvancedSettings({
  agentConfig,
  projectId,
  stageId,
  selectedProvider,
  onUpdateToolConfig,
  onUpdateOutputFormat,
  onUpdatePolicyConfig,
  onSaveConfig,
}: {
  agentConfig: Doc<"agentConfigs"> | null | undefined;
  projectId: Id<"projects"> | undefined;
  stageId: Id<"stages"> | null | undefined;
  selectedProvider: AccountModelProviderName;
  onUpdateToolConfig?: (
    toolName: string,
    config: Record<string, unknown> | null,
  ) => Promise<void>;
  onUpdateOutputFormat?: (outputFormat: Record<string, unknown> | null) => void;
  onUpdatePolicyConfig?: (policies: string[] | null) => Promise<void>;
  /** Merge-safe raw-config save (see lib/agentConfigMerge.ts). */
  onSaveConfig: (value: unknown) => Promise<void>;
}): React.JSX.Element {
  const [outputSchemaText, setOutputSchemaText] = useState("");
  const [hasEditedOutputSchema, setHasEditedOutputSchema] = useState(false);
  const [outputSchemaError, setOutputSchemaError] = useState<string | null>(
    null,
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const schemaFileInputRef = useRef<HTMLInputElement | null>(null);

  const policyOptions = useQuery(
    api.agentPolicies.listForStage,
    projectId && stageId ? { projectId: projectId, stageId: stageId } : "skip",
  ) as Doc<"agentPolicies">[] | undefined;

  const assignedPolicyIds = readAgentPolicies(
    agentConfig as unknown as FlatAgentConfig,
  );

  const allTools = agentConfig
    ? (readAgentBranch(
        agentConfig as unknown as FlatAgentConfig,
        "tools",
      ) as Record<string, unknown>)
    : {};
  const googleSearchCfg = isPlainObject(allTools.googleSearch)
    ? (allTools.googleSearch as Record<string, unknown>)
    : { enabled: agentConfig?.searchToolEnabled };
  const googleSearchEnabled = googleSearchCfg.enabled === true;

  const outputFormat =
    agentConfig?.outputFormat && isPlainObject(agentConfig.outputFormat)
      ? (agentConfig.outputFormat as OutputFormatConfig)
      : undefined;
  const outputFormatEnabled = outputFormat !== undefined;
  const schemaFromConfigText = isPlainObject(outputFormat?.schema)
    ? JSON.stringify(outputFormat.schema, null, 2)
    : "";
  const displayOutputSchemaText = hasEditedOutputSchema
    ? outputSchemaText
    : schemaFromConfigText;

  // The Advanced editor loads the FULL nested config — every branch — so a
  // save can never drop something the editor didn't show (00 §2a).
  const fullNestedConfig = useMemo(
    () =>
      agentConfig
        ? (toNestedAgentConfig(
            agentConfig as unknown as FlatAgentConfig,
          ) as Record<string, unknown>)
        : {},
    [agentConfig],
  );

  function buildOutputFormatPayload(
    schema: Record<string, unknown>,
  ): Record<string, unknown> {
    const next: Record<string, unknown> = {
      type: "object",
      schema: schema,
    };
    if (
      typeof outputFormat?.name === "string" &&
      outputFormat.name.trim().length > 0
    ) {
      next.name = outputFormat.name.trim();
    }
    if (
      typeof outputFormat?.description === "string" &&
      outputFormat.description.trim().length > 0
    ) {
      next.description = outputFormat.description.trim();
    }

    return next;
  }

  function parseSchemaText(input: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(input);
      if (!isPlainObject(parsed)) {
        setOutputSchemaError("Schema must be a JSON object.");

        return null;
      }
      setOutputSchemaError(null);

      return parsed;
    } catch {
      setOutputSchemaError("Invalid schema JSON.");

      return null;
    }
  }

  function handleToggleOutputFormat(enabled: boolean) {
    if (!enabled) {
      setOutputSchemaError(null);
      setHasEditedOutputSchema(false);
      setOutputSchemaText("");
      onUpdateOutputFormat?.(null);

      return;
    }

    const existingSchema = isPlainObject(outputFormat?.schema)
      ? (outputFormat.schema as Record<string, unknown>)
      : undefined;
    setOutputSchemaError(null);
    const schema = existingSchema ?? DEFAULT_OUTPUT_SCHEMA;
    setHasEditedOutputSchema(true);
    setOutputSchemaText(JSON.stringify(schema, null, 2));
    onUpdateOutputFormat?.(buildOutputFormatPayload(schema));
  }

  function handleApplySchema() {
    const parsed = parseSchemaText(displayOutputSchemaText);
    if (!parsed) {
      return;
    }
    setHasEditedOutputSchema(true);
    setOutputSchemaText(JSON.stringify(parsed, null, 2));
    onUpdateOutputFormat?.(buildOutputFormatPayload(parsed));
  }

  function handleImportSchemaFile(file: File | undefined) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      const parsed = parseSchemaText(content);
      if (!parsed) {
        return;
      }
      setHasEditedOutputSchema(true);
      setOutputSchemaText(JSON.stringify(parsed, null, 2));
      onUpdateOutputFormat?.(buildOutputFormatPayload(parsed));
    };
    reader.onerror = () => {
      setOutputSchemaError("Failed to read schema file.");
    };
    reader.readAsText(file);
  }

  function togglePolicyId(policyId: string) {
    const nextIds = assignedPolicyIds.includes(policyId)
      ? assignedPolicyIds.filter((entry) => entry !== policyId)
      : [...assignedPolicyIds, policyId];

    // Nothing attached means nothing to evaluate: clear the field.
    void onUpdatePolicyConfig?.(nextIds.length === 0 ? null : nextIds);
  }

  return (
    <div className="flex flex-col gap-5">
      {onUpdatePolicyConfig && (
        <div className="flex flex-col gap-3">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Guardrail Policies
          </span>
          <p className="text-[11px] text-muted-foreground">
            Rules this agent follows. Each policy carries its own mode: audit
            records decisions without blocking, enforce blocks what it denies.
          </p>
          <div className="flex flex-col gap-1.5">
            {(policyOptions ?? []).map((policy) => {
              const selected = assignedPolicyIds.includes(policy._id);

              return (
                <Button
                  key={policy._id}
                  type="button"
                  variant={selected ? "secondary" : "outline"}
                  size="sm"
                  className="h-8 justify-start truncate text-xs"
                  onClick={() => togglePolicyId(policy._id)}
                >
                  {policy.name}
                </Button>
              );
            })}
            {policyOptions && policyOptions.length === 0 && (
              <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                No policies in this stage.
              </p>
            )}
          </div>
        </div>
      )}

      {agentConfig && onUpdateToolConfig && (
        <>
          <Separator />
          <div className="flex flex-col gap-3">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Provider Tools
            </span>
            <ToggleRow
              label="Google Search"
              description={
                selectedProvider === "google"
                  ? "Grounded search via Google"
                  : "Requires Google provider"
              }
              checked={googleSearchEnabled}
              disabled={selectedProvider !== "google"}
              onCheckedChange={(next) =>
                void onUpdateToolConfig("googleSearch", {
                  ...googleSearchCfg,
                  enabled: next,
                })
              }
            />
            {googleSearchEnabled && selectedProvider === "google" && (
              <ExpandBlock>
                <ToggleRow
                  label="Needs approval"
                  checked={googleSearchCfg.needsApproval === true}
                  onCheckedChange={(next) =>
                    void onUpdateToolConfig("googleSearch", {
                      ...googleSearchCfg,
                      needsApproval: next,
                    })
                  }
                />
              </ExpandBlock>
            )}
          </div>
        </>
      )}

      {agentConfig && (
        <>
          <Separator />
          <div className="flex flex-col gap-3">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Output Format
            </span>
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-foreground">
                  Structured Output
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Import a JSON schema or write one manually
                </span>
              </div>
              <Switch
                checked={outputFormatEnabled}
                onCheckedChange={(checked) => handleToggleOutputFormat(checked)}
              />
            </div>

            {outputFormatEnabled && (
              <div className="ml-1 flex flex-col gap-2.5 border-l-2 border-border pl-3">
                <input
                  ref={schemaFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    handleImportSchemaFile(e.target.files?.[0]);
                    e.currentTarget.value = "";
                  }}
                />
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() => schemaFileInputRef.current?.click()}
                  >
                    Import Schema
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={handleApplySchema}
                  >
                    Save Schema
                  </Button>
                </div>
                <Textarea
                  value={displayOutputSchemaText}
                  onChange={(e) => {
                    setHasEditedOutputSchema(true);
                    setOutputSchemaText(e.target.value);
                    setOutputSchemaError(null);
                  }}
                  placeholder={
                    '{\n  "type": "object",\n  "additionalProperties": true,\n  "properties": {\n    "answer": { "type": "string" }\n  },\n  "required": ["answer"]\n}'
                  }
                  spellCheck={false}
                  className="min-h-36 resize-y font-mono text-xs"
                />
                {outputSchemaError && (
                  <p className="text-xs text-destructive">
                    {outputSchemaError}
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <Separator />

      {/* Advanced — the raw config escape hatch, collapsed by default. */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors">
          <ChevronRight className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90" />
          Advanced — raw configuration
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-[11px] text-muted-foreground">
              The agent&apos;s raw configuration (JSON). Saving merges your edit
              into the existing configuration — settings you don&apos;t touch
              here are kept.
            </p>
            <BranchEditor
              title="Raw config"
              value={fullNestedConfig}
              onSave={onSaveConfig}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
