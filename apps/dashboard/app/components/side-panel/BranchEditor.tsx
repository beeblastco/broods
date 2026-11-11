"use client";

import { Button } from "@/app/components/ui/button";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { Textarea } from "@/app/components/ui/textarea";
import { SectionHeader } from "@/app/components/side-panel/SectionHeader";
import { Check } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toErrorMessage } from "@/app/lib/errors";

const EMPTY_DEFAULT = "{}";

export function BranchEditor({
  title,
  value,
  onSave,
}: {
  title: string;
  value: unknown;
  onSave: (parsed: unknown) => Promise<void> | void;
}): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const serialized = useMemo(
    () =>
      value === undefined || value === null
        ? EMPTY_DEFAULT
        : JSON.stringify(value, null, 2),
    [value],
  );

  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [syncedSource, setSyncedSource] = useState(serialized);
  const errorId = useId();

  if (serialized !== syncedSource) {
    setSyncedSource(serialized);
    setDraft(serialized);
    setError(null);
    setSaved(false);
  }

  const dirty = draft !== serialized;

  async function handleSave(): Promise<void> {
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
      setError(toErrorMessage(e));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <SectionHeader>{title}</SectionHeader>
      <Textarea
        variant="code"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
          setSaved(false);
        }}
        spellCheck={false}
        aria-label={title}
        aria-invalid={error !== null}
        aria-describedby={error !== null ? errorId : undefined}
        rows={8}
        className="min-h-32 resize-y"
        readOnly={!canWrite}
      />
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {canWrite && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 cursor-pointer text-xs"
            disabled={!dirty || isSaving}
            onClick={handleSave}
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        )}
        {saved && (
          <span className="flex items-center gap-1 text-xs text-success">
            <Check className="size-3" /> Saved
          </span>
        )}
      </div>
    </div>
  );
}
