"use client";

/**
 * JSON editor for a single nested branch of an AgentConfig. Owns its own
 * dirty/error/saved state so the side panel can stack multiple editors that
 * each save an isolated slice.
 */
import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { Check } from "lucide-react";
import { useMemo, useState } from "react";

const EMPTY_DEFAULT = "{}";

export function BranchEditor({
  title,
  value,
  placeholder = EMPTY_DEFAULT,
  onSave,
  disabled,
}: {
  title: string;
  value: unknown;
  placeholder?: string;
  onSave: (parsed: unknown) => Promise<void> | void;
  disabled?: boolean;
}) {
  const serialized = useMemo(
    () =>
      value === undefined || value === null
        ? placeholder
        : JSON.stringify(value, null, 2),
    [value, placeholder],
  );

  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [syncedSource, setSyncedSource] = useState(serialized);

  // Reset the draft when the upstream serialized value changes (set during
  // render rather than in an effect to avoid a cascading re-render).
  if (serialized !== syncedSource) {
    setSyncedSource(serialized);
    setDraft(serialized);
    setError(null);
    setSaved(false);
  }

  const dirty = draft !== serialized;

  async function handleSave() {
    let parsed: unknown;
    try {
      parsed = draft.trim().length === 0 ? undefined : JSON.parse(draft);
    } catch {
      setError("Invalid JSON");

      return;
    }

    setError(null);
    setIsSaving(true);
    try {
      await onSave(parsed);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
        {title}
      </span>
      <Textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
          setSaved(false);
        }}
        spellCheck={false}
        rows={8}
        className="min-h-32 resize-y bg-muted/50 font-mono text-xs"
        disabled={disabled}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 cursor-pointer text-xs disabled:cursor-not-allowed"
          disabled={disabled || !dirty || isSaving}
          onClick={handleSave}
        >
          {isSaving ? "Saving…" : "Save"}
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
