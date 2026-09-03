"use client";

/** Environment variables panel: manage runtime variables for the stage currently selected in the header. */
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Check, Eye, EyeOff, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";

// A single masked variable as returned by the `list` query (no encrypted fields).
type EnvironmentVariable = FunctionReturnType<
  typeof api.environmentVariables.list
>[number];

// Shared sizing so read-only value chips and the add inputs match height, font,
// and shrink behaviour exactly. `md:text-xs` overrides the Input's `md:text-sm`
// so typed text stays the same size as the chips; `min-w-0` lets long values
// truncate instead of widening the row.
const FIELD_CLASS = "h-8 min-w-0 flex-1 font-mono text-xs";

interface Props {
  /** Project that owns the stage. */
  projectId: Id<"projects">;
  /** Active stage whose variables are managed, or null while none is selected. */
  stageId: Id<"stages"> | null;
}

/** Lists, adds, and removes runtime variables for the active stage. */
export function EnvironmentVariablesPanel({
  projectId,
  stageId,
}: Props): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const variables = useQuery(
    api.environmentVariables.list,
    stageId ? { projectId: projectId, stageId: stageId } : "skip",
  );
  const setVariable = useMutation(api.environmentVariables.set);
  const removeVariable = useMutation(api.environmentVariables.remove);
  const revealVariable = useMutation(api.environmentVariables.reveal);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  // Plaintext values revealed via the eye icon, keyed by variable id. Each reveal is audited server-side.
  const [revealedState, setRevealedState] = useState<{
    stageId: Id<"stages"> | null;
    values: Record<string, string>;
  }>({ stageId: null, values: {} });
  const revealed =
    revealedState.stageId === stageId ? revealedState.values : {};

  // Variable pending delete confirmation.
  const [deletingVar, setDeletingVar] = useState<EnvironmentVariable | null>(
    null,
  );
  const [isDeletingVar, setIsDeletingVar] = useState(false);

  async function toggleReveal(variableId: Id<"environmentVariables">) {
    if (!stageId) return;
    if (revealed[variableId] !== undefined) {
      setRevealedState((prev) => {
        const next = {
          ...(prev.stageId === stageId ? prev.values : {}),
        };
        delete next[variableId];

        return { stageId: stageId, values: next };
      });

      return;
    }
    const { value: plaintext } = await revealVariable({
      projectId: projectId,
      stageId: stageId,
      variableId: variableId,
    });
    setRevealedState((prev) => ({
      stageId: stageId,
      values: {
        ...(prev.stageId === stageId ? prev.values : {}),
        [variableId]: plaintext,
      },
    }));
  }

  async function handleAdd() {
    if (!name.trim() || busy || !stageId) return;
    setBusy(true);
    try {
      await setVariable({
        projectId: projectId,
        stageId: stageId,
        name: name.trim(),
        value: value,
      });
      setName("");
      setValue("");
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteVar() {
    if (!deletingVar) return;
    setIsDeletingVar(true);
    try {
      await removeVariable({ variableId: deletingVar._id });
      setDeletingVar(null);
    } finally {
      setIsDeletingVar(false);
    }
  }

  if (!stageId) {
    return (
      <Section description="Environment variables for this stage.">
        <p className="text-sm text-muted-foreground">
          Select a stage to manage its variables.
        </p>
      </Section>
    );
  }

  return (
    <>
      <Section description="Environment variables for this stage.">
        {variables && variables.length === 0 && (
          <p className="text-sm text-muted-foreground">No variables yet.</p>
        )}
        <div className="grid grid-cols-1 gap-2">
          {variables?.map((v) => (
            <div key={v._id} className="flex min-w-0 items-center gap-2">
              <code
                className={cn(
                  FIELD_CLASS,
                  "truncate rounded-md bg-muted px-3 leading-8",
                )}
              >
                {v.name}
              </code>
              <code
                className={cn(
                  FIELD_CLASS,
                  "truncate rounded-md bg-muted px-3 leading-8",
                )}
              >
                {revealed[v._id] !== undefined ? (
                  revealed[v._id] || (
                    <span className="text-muted-foreground">empty</span>
                  )
                ) : v.value ? (
                  "••••••••"
                ) : (
                  <span className="text-muted-foreground">empty</span>
                )}
              </code>
              {canWrite && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                    title={
                      revealed[v._id] !== undefined
                        ? "Hide value"
                        : "Reveal value"
                    }
                    onClick={() => toggleReveal(v._id)}
                  >
                    {revealed[v._id] !== undefined ? (
                      <EyeOff className="size-3.5" />
                    ) : (
                      <Eye className="size-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
                    onClick={() => setDeletingVar(v)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
        {adding ? (
          <div className="flex min-w-0 items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="KEY_NAME"
              className={cn(FIELD_CLASS, "md:text-xs")}
              autoFocus
            />
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="value"
              className={cn(FIELD_CLASS, "md:text-xs")}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "shrink-0",
                !name.trim() || busy
                  ? "cursor-not-allowed text-muted-foreground"
                  : "cursor-pointer text-muted-foreground hover:text-foreground",
              )}
              disabled={!name.trim() || busy}
              onClick={handleAdd}
              title="Add variable"
              aria-label="Add variable"
            >
              <Check className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
              onClick={() => {
                setAdding(false);
                setName("");
                setValue("");
              }}
              title="Cancel"
              aria-label="Cancel"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : canWrite ? (
          <Button
            variant="outline"
            size="sm"
            className="w-fit cursor-pointer"
            onClick={() => setAdding(true)}
          >
            <Plus className="mr-1 size-3.5" />
            Add Variable
          </Button>
        ) : null}
      </Section>

      {deletingVar && (
        <DeleteConfirmDialog
          open={deletingVar !== null}
          onOpenChange={(open) => {
            if (!open) setDeletingVar(null);
          }}
          resourceName={deletingVar.name}
          resourceType="variable"
          critical={false}
          onConfirm={handleDeleteVar}
          isDeleting={isDeletingVar}
        />
      )}
    </>
  );
}
