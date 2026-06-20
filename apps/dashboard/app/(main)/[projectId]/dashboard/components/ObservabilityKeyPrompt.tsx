"use client";

/** Empty-state prompt that mints a runtime viewing key so logs/traces can stream without the CLI. */
import { Button } from "@/app/components/ui/button";
import { KeyRound, Loader2 } from "lucide-react";

interface Props {
  generating: boolean;
  error: string | null;
  onGenerate: () => void;
}

/** Shown on the Monitoring/Tracing tabs when an environment has no runtime API key yet. */
export function ObservabilityKeyPrompt({ generating, error, onGenerate }: Props) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 text-center">
      <div className="rounded-full border border-border bg-muted/40 p-3">
        <KeyRound className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Generate a viewing key</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Streaming logs and traces needs this environment&apos;s runtime API key. Generate one
          here to view them — no CLI required.
        </p>
      </div>

      <Button className="cursor-pointer" disabled={generating} onClick={onGenerate}>
        {generating ? <Loader2 className="size-4 animate-spin" /> : "Generate key"}
      </Button>

      {error ? <p className="max-w-sm text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
