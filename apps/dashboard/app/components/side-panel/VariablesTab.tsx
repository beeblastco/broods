"use client";

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Check, Copy, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

type RuntimeVariable = { key: string; value: string };

function normalizeVariables(entries: RuntimeVariable[]): RuntimeVariable[] {
    const deduped = new Map<string, string>();
    for (const entry of entries) {
        const key = entry.key.trim();
        if (!key) {
            continue;
        }
        deduped.set(key, entry.value);
    }

    return Array.from(deduped.entries()).map(([key, value]) => ({ key: key, value: value }));
}

function keysFromVariables(entries: RuntimeVariable[]): string[] {
    return entries.map((entry) => entry.key.trim()).filter((key) => key.length > 0);
}

const PROVIDER_API_KEY_HINTS: Record<string, { envVar: string; label: string }> = {
    openai: { envVar: "OPENAI_API_KEY", label: "OpenAI" },
    google: { envVar: "GOOGLE_GENERATIVE_AI_API_KEY", label: "Google" },
    anthropic: { envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
    bedrock: { envVar: "AWS_BEDROCK_API_KEY", label: "Bedrock" },
};

export function VariablesTab({
    runtimeVariables,
    isSaving,
    onSave,
    provider,
}: {
    runtimeVariables: RuntimeVariable[];
    isSaving: boolean;
    onSave: (next: RuntimeVariable[]) => Promise<void>;
    provider?: string;
}) {
    const providerHint = provider ? PROVIDER_API_KEY_HINTS[provider] : undefined;
    const [variables, setVariables] = useState<RuntimeVariable[]>(runtimeVariables);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [visibleValueRows, setVisibleValueRows] = useState<Set<number>>(new Set());
    const [copiedField, setCopiedField] = useState<string | null>(null);

    const normalizedCurrent = useMemo(
        () => normalizeVariables(variables),
        [variables],
    );
    const normalizedInitial = useMemo(
        () => normalizeVariables(runtimeVariables),
        [runtimeVariables],
    );

    const invalidKeys = useMemo(
        () =>
            keysFromVariables(variables).filter(
                (key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
            ),
        [variables],
    );

    const duplicateKeys = useMemo(() => {
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const key of keysFromVariables(variables)) {
            const normalized = key.toUpperCase();
            if (seen.has(normalized)) {
                duplicates.add(key);
            }
            seen.add(normalized);
        }

        return Array.from(duplicates);
    }, [variables]);

    const hasChanges = useMemo(
        () => JSON.stringify(normalizedCurrent) !== JSON.stringify(normalizedInitial),
        [normalizedCurrent, normalizedInitial],
    );

    const hasValidationError = invalidKeys.length > 0 || duplicateKeys.length > 0;

    async function handleSave() {
        if (hasValidationError) {
            setSaveError("Fix invalid or duplicate variable keys before saving.");
            return;
        }

        setSaveError(null);
        await onSave(normalizedCurrent);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    }

    function handleCopy(value: string, field: string) {
        if (!value) {
            return;
        }

        navigator.clipboard.writeText(value);
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 2000);
    }

    return (
        <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4">
            <p className="text-xs text-muted-foreground">
                Add runtime environment variables for this agent. Saved values are hidden after reload; leave a value blank to keep it unchanged.
                {providerHint && (
                    <>
                        {" "}For {providerHint.label}, set{" "}
                        <code className="ml-0">{providerHint.envVar}</code>.
                    </>
                )}
            </p>

            <div className="flex min-h-0 flex-1 flex-col gap-2">
                <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Variables</span>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px]"
                        onClick={() => {
                            setVariables((prev) => [...prev, { key: "", value: "" }]);
                            setSaveError(null);
                            setSaved(false);
                        }}
                    >
                        <Plus className="size-3.5" />
                        Add
                    </Button>
                </div>

                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                    {variables.length === 0 ? (
                        <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                            No runtime variables set. The service still loads values from `.env`.
                        </p>
                    ) : (
                        variables.map((variable, index) => (
                            <div key={`${index}-${variable.key}`} className="grid grid-cols-[1fr_1fr_auto_auto_auto] items-center gap-2">
                                <Input
                                    value={variable.key}
                                    placeholder="KEY_NAME"
                                    onChange={(event) => {
                                        const next = [...variables];
                                        next[index] = { ...next[index], key: event.target.value };
                                        setVariables(next);
                                        setSaveError(null);
                                        setSaved(false);
                                    }}
                                    className="h-8 text-xs"
                                />
                                <Input
                                    type={visibleValueRows.has(index) ? "text" : "password"}
                                    value={variable.value}
                                    placeholder="value"
                                    onChange={(event) => {
                                        const next = [...variables];
                                        next[index] = { ...next[index], value: event.target.value };
                                        setVariables(next);
                                        setSaveError(null);
                                        setSaved(false);
                                    }}
                                    className="h-8 text-xs"
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => {
                                        setVisibleValueRows((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(index)) {
                                                next.delete(index);
                                            } else {
                                                next.add(index);
                                            }

                                            return next;
                                        });
                                    }}
                                    aria-label={visibleValueRows.has(index) ? "Hide variable value" : "Show variable value"}
                                >
                                    {visibleValueRows.has(index) ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => handleCopy(variable.value, `value-${index}`)}
                                    aria-label="Copy variable value"
                                    disabled={!variable.value}
                                >
                                    {copiedField === `value-${index}` ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => {
                                        setVariables((prev) => prev.filter((_, i) => i !== index));
                                        setVisibleValueRows((prev) => {
                                            const next = new Set<number>();
                                            for (const rowIndex of prev) {
                                                if (rowIndex < index) {
                                                    next.add(rowIndex);
                                                } else if (rowIndex > index) {
                                                    next.add(rowIndex - 1);
                                                }
                                            }

                                            return next;
                                        });
                                        setSaveError(null);
                                        setSaved(false);
                                    }}
                                    aria-label="Remove variable"
                                >
                                    <Trash2 className="size-3.5" />
                                </Button>
                            </div>
                        ))
                    )}
                </div>
            </div>

            {invalidKeys.length > 0 && (
                <p className="text-xs text-destructive">
                    Invalid keys: {invalidKeys.join(", ")}. Use letters, numbers, and underscores only.
                </p>
            )}
            {duplicateKeys.length > 0 && (
                <p className="text-xs text-destructive">
                    Duplicate keys: {duplicateKeys.join(", ")}.
                </p>
            )}
            {saveError && (
                <p className="text-xs text-destructive">{saveError}</p>
            )}

            <div className="flex items-center gap-2">
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={!hasChanges || isSaving || hasValidationError}
                    onClick={handleSave}
                >
                    {isSaving ? "Saving…" : "Save Variables"}
                </Button>
                {saved && (
                    <span className="flex items-center gap-1 text-xs text-emerald-500">
                        <Check className="size-3" /> Saved
                    </span>
                )}
            </div>
        </div>
    );
}
