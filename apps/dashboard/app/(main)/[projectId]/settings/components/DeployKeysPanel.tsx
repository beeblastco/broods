"use client";

import { CopyButton, useCopied } from "@/app/components/CopyButton";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { IconTooltip } from "@/app/components/IconTooltip";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { Input } from "@/app/components/ui/input";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Check, Copy, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

const DEPLOYING_GUIDE_URL = "https://docs.broods.app/guides/deploying";

type DeployKey = FunctionReturnType<typeof api.deployKeys.list>[number];

interface Props {
  projectId: Id<"projects">;
  stageId: Id<"stages"> | null;
}

export function DeployKeysPanel({
  projectId,
  stageId,
}: Props): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const deployKeys = useQuery(
    api.deployKeys.list,
    stageId ? { projectId: projectId, stageId: stageId } : "skip",
  );
  const createKey = useMutation(api.deployKeys.create);
  const removeKey = useMutation(api.deployKeys.remove);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const { copied, failed, copy: copyToken } = useCopied(revealed ?? "");

  const [deletingKey, setDeletingKey] = useState<DeployKey | null>(null);
  const [isDeletingKey, setIsDeletingKey] = useState(false);

  async function handleCreate(): Promise<void> {
    if (!name.trim() || busy || !stageId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createKey({
        projectId: projectId,
        stageId: stageId,
        name: name.trim(),
      });
      setRevealed(result.token);
      setName("");
      setAdding(false);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteKey(): Promise<void> {
    if (!deletingKey) return;
    setIsDeletingKey(true);
    try {
      await removeKey({ deployKeyId: deletingKey._id });
      setDeletingKey(null);
    } finally {
      setIsDeletingKey(false);
    }
  }

  if (!stageId) {
    return (
      <Section description="Project keys deploy and set variables on this stage only.">
        <p className="text-sm text-muted-foreground">
          Select a stage to manage its project keys.
        </p>
      </Section>
    );
  }

  return (
    <>
      <Section description="Project keys deploy and set variables on this stage only.">
        {revealed && (
          <div className="rounded-md border border-success/40 bg-success/5 p-3">
            <p className="mb-1 text-xs font-medium text-foreground">
              Copy this key now. It won&apos;t be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                {revealed}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer"
                aria-label="Copy project key"
                onClick={copyToken}
              >
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="cursor-pointer"
                onClick={() => setRevealed(null)}
              >
                Done
              </Button>
            </div>
            {failed ? (
              <p role="alert" className="mt-1 text-xs text-destructive">
                Copy failed. Try again or select and copy the key manually.
              </p>
            ) : null}
            <DeployCommand
              token={revealed}
              projectId={projectId}
              stageId={stageId}
            />
          </div>
        )}

        {deployKeys && deployKeys.length === 0 && (
          <p className="text-sm text-muted-foreground">No project keys yet.</p>
        )}
        <div className="grid gap-2">
          {deployKeys?.map((key) => (
            <div key={key._id} className="flex items-center gap-2">
              <span className="flex-1 truncate text-sm font-medium text-foreground">
                {key.name}
              </span>
              <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                {key.keyHint}
              </code>
              {canWrite && (
                <IconTooltip label={`Delete ${key.name}`}>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    tone="muted-destructive"
                    className="cursor-pointer"
                    onClick={() => setDeletingKey(key)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </IconTooltip>
              )}
            </div>
          ))}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {adding ? (
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Key name (e.g. CI staging)"
              aria-label="Project key name"
              className="flex-1 text-sm"
              autoFocus
            />
            <Button
              size="sm"
              className="cursor-pointer"
              disabled={!name.trim() || busy}
              onClick={handleCreate}
            >
              {busy ? "Creating…" : "Create"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="cursor-pointer"
              onClick={() => {
                setAdding(false);
                setName("");
                setError(null);
              }}
            >
              Cancel
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
            New Project Key
          </Button>
        ) : null}
      </Section>

      {deletingKey && (
        <DeleteConfirmDialog
          open={deletingKey !== null}
          onOpenChange={(open) => {
            if (!open) setDeletingKey(null);
          }}
          resourceName={deletingKey.name}
          resourceType="project key"
          critical={false}
          onConfirm={handleDeleteKey}
          isDeleting={isDeletingKey}
        />
      )}
    </>
  );
}

// The exact `broods deploy` line for a just-revealed key, as the deploying
// guide documents it. Nothing until the stage name and gateway URL are known.
function DeployCommand({
  token,
  projectId,
  stageId,
}: {
  token: string;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
}): React.JSX.Element | null {
  const stages = useQuery(api.stage.list, { projectId: projectId });
  // The CLI matches --stage against the stage name case-insensitively.
  const stageSlug = stages
    ?.find((stage) => stage._id === stageId)
    ?.name.toLowerCase();
  const endpoint = resolveCoreEndpoint();
  if (!stageSlug || !endpoint.ok) return null;
  const command = `BROODS_TOKEN=${token} BROODS_BASE_URL=${endpoint.httpBaseUrl} broods deploy --stage ${stageSlug}`;

  return (
    <>
      <p className="mt-3 mb-1 text-xs text-muted-foreground">
        Deploy from CI or a shell with this key.{" "}
        <a
          href={DEPLOYING_GUIDE_URL}
          target="_blank"
          rel="noreferrer"
          className="cursor-pointer underline underline-offset-2 hover:text-foreground"
        >
          Deploying guide
        </a>
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-muted px-2 py-1 font-mono text-xs break-all">
          {command}
        </code>
        <CopyButton value={command} label="deploy command" />
      </div>
    </>
  );
}
