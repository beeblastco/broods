"use client";

/** Config tab with JSON editor for agent configuration fields. */
import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { Check } from "lucide-react";

export function ConfigTab({
    configJson,
    setConfigJson,
    configError,
    setConfigError,
    configChanged,
    isSavingConfig,
    configSaved,
    setConfigSaved,
    onSaveConfig,
}: {
    configJson: string;
    setConfigJson: (json: string) => void;
    configError: string | null;
    setConfigError: (error: string | null) => void;
    configChanged: boolean;
    isSavingConfig: boolean;
    configSaved: boolean;
    setConfigSaved: (saved: boolean) => void;
    onSaveConfig: () => void;
}) {
    return (
        <div className="flex flex-1 flex-col gap-3 p-4 overflow-hidden">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
                Agent Configuration
            </span>
            <Textarea
                value={configJson}
                onChange={(e) => {
                    setConfigJson(e.target.value);
                    setConfigError(null);
                    setConfigSaved(false);
                }}
                spellCheck={false}
                className="flex-1 min-h-0 resize-none bg-muted/50 font-mono text-xs"
            />
            {configError && (
                <p className="text-xs text-destructive">{configError}</p>
            )}
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={!configChanged || isSavingConfig}
                    onClick={onSaveConfig}
                >
                    {isSavingConfig ? "Saving…" : "Save Config"}
                </Button>
                {configSaved && (
                    <span className="flex items-center gap-1 text-xs text-emerald-500">
                        <Check className="size-3" /> Saved
                    </span>
                )}
            </div>
        </div>
    );
}
