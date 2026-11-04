"use client";

import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { Button } from "@/app/components/ui/button";
import { useNow } from "@/app/hooks/useNow";
import {
  actionChange,
  type CopilotAction,
  type DockProposal,
} from "@/app/lib/copilotActions";
import { ArrowRight, X } from "lucide-react";
import { useState } from "react";

// The one place a proposal is reviewed and applied: its title, its diff, then its deploy.
export function DockApplyBar(): React.JSX.Element | null {
  const { applyProposal, discardProposal, dropChange, proposal } = useCopilot();
  const [openFor, setOpenFor] = useState<string | null>(null);
  if (!proposal) return null;

  const { apply, messageId } = proposal;
  const isOpen = openFor === messageId && apply.phase === "proposed";

  return (
    <section
      data-apply-bar={apply.phase}
      aria-label="Proposed change"
      className="pointer-events-auto w-full max-w-lg rounded-md border border-border bg-card text-xs text-card-foreground shadow-sm"
    >
      <div className="flex h-8 items-center gap-2 pr-1 pl-2.5">
        <span className="min-w-0 flex-1 truncate font-medium">
          {proposal.title}
        </span>
        {apply.phase === "proposed" && (
          <button
            type="button"
            data-apply-code
            aria-expanded={isOpen}
            onClick={() => setOpenFor(isOpen ? null : messageId)}
            className="shrink-0 cursor-pointer text-2xs text-muted-foreground underline"
          >
            <ChangeCount proposal={proposal} />
          </button>
        )}
        {apply.phase === "applying" && (
          <span className="shrink-0 text-muted-foreground">
            {proposal.branch ? (
              <>
                Deploying to {proposal.stage ?? proposal.branch} ·{" "}
                <Elapsed since={apply.startedAt ?? Date.now()} />
              </>
            ) : (
              "Applying"
            )}
          </span>
        )}
        {apply.phase === "failed" && (
          <span className="shrink-0 text-destructive">Deploy failed</span>
        )}
        {apply.phase !== "proposed" && <RunLink href={apply.runUrl} />}
        {apply.phase !== "applying" && (
          <Button
            size="xs"
            variant="ghost"
            tone="muted"
            onClick={() => discardProposal(messageId)}
          >
            Discard
          </Button>
        )}
        {apply.phase !== "applying" && canRetry(proposal) && (
          <Button size="xs" onClick={() => applyProposal(messageId)}>
            {apply.phase === "proposed" ? "Apply" : "Retry"}
          </Button>
        )}
      </div>
      {isOpen && (
        <div
          data-apply-drawer
          className="flex max-h-72 flex-col gap-2 overflow-y-auto border-t border-border px-2.5 pt-1.5 pb-2"
        >
          {proposal.changes.map(({ action, index }) => (
            <StepDetail
              key={index}
              action={action}
              onDrop={(path) => dropChange(messageId, index, path)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** What a step will change: the field's before and after, or each file's diff, each droppable. */
function StepDetail({
  action,
  onDrop,
}: {
  action: CopilotAction;
  onDrop: (path?: string) => void;
}): React.JSX.Element {
  const change = actionChange(action);
  if (action.type !== "commitFiles") {
    return (
      <div data-apply-change className="flex flex-col gap-1">
        <ChangeHeader label={action.label} onDrop={() => onDrop()} />
        {change && (
          <div
            data-plan-change
            className="flex flex-wrap items-center gap-1.5 font-mono text-2xs"
          >
            <span className="text-muted-foreground">{change.field}</span>
            <span className="text-destructive line-through">
              {change.before}
            </span>
            <ArrowRight className="size-3 text-muted-foreground" />
            <span className="text-success">{change.after}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {action.files.map((file) => (
        <div key={file.path} data-apply-change className="flex flex-col gap-1">
          <ChangeHeader
            label={
              <span className="font-mono">
                {file.path} <LineCounts patches={[file.patch]} />
              </span>
            }
            onDrop={() => onDrop(file.path)}
          />
          <pre
            data-plan-diff
            className="overflow-x-auto rounded-sm border border-border p-2 font-mono text-2xs"
          >
            {file.patch.map((line, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- a patch never reorders
              <div key={index} className={diffLineClass(line)}>
                {line}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </>
  );
}

// A retry after the commit landed resends only its writes: a deletion-only commit has none.
function canRetry({ apply, changes }: DockProposal): boolean {
  return (
    !apply.sha ||
    changes.some(
      ({ action }) =>
        action.type === "commitFiles" &&
        action.files.some((file) => file.content !== null),
    )
  );
}

function ChangeCount({
  proposal,
}: {
  proposal: DockProposal;
}): React.JSX.Element {
  const files = proposal.changes.flatMap(({ action }) =>
    action.type === "commitFiles" ? action.files : [],
  );
  const steps = proposal.changes.length - (files.length > 0 ? 1 : 0);
  const parts = [
    steps > 0 && `${steps} ${steps === 1 ? "change" : "changes"}`,
    files.length > 0 &&
      `${files.length} ${files.length === 1 ? "file" : "files"}`,
  ].filter(Boolean);

  return (
    <>
      {parts.join(", ")}
      {files.length > 0 && (
        <>
          {" "}
          <LineCounts patches={files.map((file) => file.patch)} />
        </>
      )}
    </>
  );
}

function ChangeHeader({
  label,
  onDrop,
}: {
  label: React.ReactNode;
  onDrop: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 text-2xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Button
        size="icon-xs"
        variant="ghost"
        tone="muted"
        aria-label="Drop this change"
        onClick={onDrop}
      >
        <X />
      </Button>
    </div>
  );
}

function Elapsed({ since }: { since: number }): React.JSX.Element {
  const seconds = Math.max(0, Math.floor((useNow(1000) - since) / 1000));

  return (
    <span className="tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}

function LineCounts({
  patches,
}: {
  patches: readonly (readonly string[])[];
}): React.JSX.Element {
  const lines = patches.flat();

  return (
    <>
      <span className="text-success">
        +{lines.filter((line) => line.startsWith("+")).length}
      </span>{" "}
      <span className="text-destructive">
        −{lines.filter((line) => line.startsWith("-")).length}
      </span>
    </>
  );
}

function RunLink({ href }: { href?: string }): React.JSX.Element | null {
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="shrink-0 cursor-pointer text-2xs text-muted-foreground underline"
    >
      Run
    </a>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+")) return "text-success";
  if (line.startsWith("-")) return "text-destructive";

  return "text-muted-foreground";
}
