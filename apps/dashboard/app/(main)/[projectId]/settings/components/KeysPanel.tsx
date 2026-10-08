"use client";

/**
 * Project › Settings › Keys: two lists with two purposes. Runtime keys are
 * minted with the stage, one each; the only actions are rotate and reveal
 * (on the Runtime key tab). API keys are made by people for deploys and
 * integrations and carry a name and a description. Admins only; a member
 * sees a lock.
 */

import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { CopyButton } from "@/app/components/CopyButton";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableFooter,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  TIME_WORDS,
} from "@/app/components/DataTable";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import {
  EmptyState,
  LockedValue,
  NoPermission,
} from "@/app/components/EmptyState";
import { RevealSecretDialog } from "@/app/components/RevealSecretDialog";
import { SearchInput } from "@/app/components/SearchInput";
import { Toolbar } from "@/app/components/Toolbar";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { PLATFORM, Who } from "@/app/components/Who";
import { useListState } from "@/app/hooks/useListState";
import { useNow } from "@/app/hooks/useNow";
import { usePermissions } from "@/app/hooks/usePermissions";
import { useSubmit } from "@/app/hooks/useSubmit";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { formatDate } from "@/app/lib/formatTime";
import type { SortKey } from "@/app/lib/tableState";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { useState } from "react";
import { relativeTime } from "../../sandbox/components/sandboxFormat";

type ProjectKeys = NonNullable<
  FunctionReturnType<typeof api.apiKeys.listForProject>
>;
type RuntimeKey = ProjectKeys["runtime"][number];
type ApiKey = ProjectKeys["api"][number];
type RuntimeColumn = "stage" | "lastUsed" | "rotatedAt" | "rotatedBy";
type ApiColumn =
  | "name"
  | "description"
  | "stage"
  | "lastUsed"
  | "createdAt"
  | "createdBy";
type ApiField = (typeof API_QUERY_FIELDS)[number];

// The `field:value` tokens the API key search box understands.
const API_QUERY_FIELDS = ["stage"] as const;

// The runtime list has no search box.
const NO_FIELDS: readonly never[] = [];

const RUNTIME_SORT: Record<RuntimeColumn, (key: RuntimeKey) => SortKey> = {
  stage: (key) => key.stageName,
  lastUsed: (key) => key.lastUsedAt ?? null,
  rotatedAt: (key) => key.rotatedAt ?? null,
  rotatedBy: (key) => key.rotatedBy?.name ?? null,
};

const API_SORT: Record<ApiColumn, (key: ApiKey) => SortKey> = {
  name: (key) => key.name,
  description: (key) => key.description ?? null,
  stage: (key) => key.stageName,
  lastUsed: (key) => key.lastUsedAt ?? null,
  createdAt: (key) => key.createdAt,
  createdBy: (key) => key.createdBy?.name ?? null,
};

interface Props {
  projectId: Id<"projects">;
  stageId: Id<"stages"> | null;
}

export function KeysPanel({ projectId, stageId }: Props): React.JSX.Element {
  const { can } = usePermissions(projectId);
  const keys = useQuery(api.apiKeys.listForProject, { projectId: projectId });
  const stages = useQuery(api.stage.list, { projectId: projectId });

  if (keys === undefined || stages === undefined) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (keys === null) {
    return <NoPermission permission="keys.read" scope="this project" />;
  }

  return (
    <div className="grid gap-6">
      <RuntimeKeysTable
        projectId={projectId}
        keys={keys.runtime}
        canWrite={can("keys:write")}
      />
      <ApiKeysTable
        projectId={projectId}
        keys={keys.api}
        stages={stages}
        defaultStageId={stageId}
        canWrite={can("keys:write")}
      />
    </div>
  );
}

/** One row per stage: the key minted with it, when it was rotated and by whom. */
function RuntimeKeysTable({
  projectId,
  keys,
  canWrite,
}: {
  projectId: Id<"projects">;
  keys: RuntimeKey[];
  canWrite: boolean;
}): React.JSX.Element {
  const now = useNow();
  const rotate = useMutation(api.agent.deployments.rotate);
  const [rotating, setRotating] = useState<RuntimeKey | null>(null);
  const { pending, error, run } = useSubmit();
  const list = useListState({
    rows: keys,
    fields: NO_FIELDS,
    initialSort: { column: "stage", dir: "asc" },
    sortKey: RUNTIME_SORT,
  });

  async function confirmRotate(): Promise<void> {
    if (!rotating) return;
    const done = await run(() =>
      rotate({ projectId: projectId, stageId: rotating.stageId }).then(
        () => undefined,
      ),
    );
    if (done) setRotating(null);
  }

  return (
    <section className="grid gap-2">
      <div>
        <h2 className="text-sm font-semibold">Runtime keys</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          One per stage. Agents and the SDK run with these.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={list.sortFor("stage")}>Stage</DataTableHead>
              <DataTableHead>Policies</DataTableHead>
              <DataTableHead>Key</DataTableHead>
              <DataTableHead sort={list.sortFor("lastUsed", TIME_WORDS)}>
                Last used
              </DataTableHead>
              <DataTableHead sort={list.sortFor("rotatedAt", TIME_WORDS)}>
                Rotated at
              </DataTableHead>
              <DataTableHead sort={list.sortFor("rotatedBy")}>
                Rotated by
              </DataTableHead>
              <DataTableHead align="right" />
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map((key) => (
              <DataTableRow key={key.stageId}>
                <DataTableCell className="font-medium">
                  {key.stageName}
                </DataTableCell>
                <DataTableCell>Stage runtime</DataTableCell>
                <DataTableCell muted className="font-mono">
                  {key.keyHint}
                </DataTableCell>
                <DataTableCell>
                  {key.lastUsedAt ? (
                    relativeTime(key.lastUsedAt, now)
                  ) : (
                    <span className="text-muted-foreground">never</span>
                  )}
                </DataTableCell>
                <DataTableCell muted>
                  {key.rotatedAt ? formatDate(key.rotatedAt) : "—"}
                </DataTableCell>
                <DataTableCell>
                  <Who actor={key.rotatedBy ?? PLATFORM} />
                </DataTableCell>
                <DataTableCell align="right">
                  {canWrite ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      tone="muted"
                      className="cursor-pointer"
                      onClick={() => setRotating(key)}
                    >
                      Rotate
                    </Button>
                  ) : (
                    <LockedValue reason="No permission to rotate keys">
                      Rotate
                    </LockedValue>
                  )}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {keys.length === 0 && (
          <EmptyState
            title="No runtime keys yet."
            detail="A stage mints its key on the first deploy, or from the Runtime key tab."
          />
        )}
        <DataTableFooter
          total={keys.length}
          noun={keys.length === 1 ? "stage" : "stages"}
        />
      </div>

      {rotating && (
        <ConfirmDialog
          title={`Rotate the ${rotating.stageName} runtime key?`}
          description="The current key stops working at once. Anything running with it needs the new one."
          verb="Rotate"
          pending={pending}
          error={error}
          onConfirm={confirmRotate}
          onClose={() => setRotating(null)}
        />
      )}
    </section>
  );
}

/** Keys people make: name, description, the stage they reach, and who made them. */
function ApiKeysTable({
  projectId,
  keys,
  stages,
  defaultStageId,
  canWrite,
}: {
  projectId: Id<"projects">;
  keys: ApiKey[];
  stages: Doc<"stages">[];
  defaultStageId: Id<"stages"> | null;
  canWrite: boolean;
}): React.JSX.Element {
  const now = useNow();
  const remove = useMutation(api.deployKeys.remove);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{
    token: string;
    stageName: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);
  const [removing, setRemoving] = useState(false);
  const list = useListState({
    rows: keys,
    fields: API_QUERY_FIELDS,
    initialSort: { column: "lastUsed", dir: "desc" },
    sortKey: API_SORT,
    matches: matchesStage,
    text: apiKeyText,
  });

  async function confirmDelete(): Promise<void> {
    if (!deleting) return;
    setRemoving(true);
    try {
      await remove({ deployKeyId: deleting._id });
      setDeleting(null);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <section className="grid gap-2">
      <div>
        <h2 className="text-sm font-semibold">API keys</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Made by people, for deploys and integrations. Each reaches one stage.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <Toolbar>
          <SearchInput
            value={list.query}
            onChange={list.setQuery}
            fields={API_QUERY_FIELDS}
            placeholder="Search API keys"
          />
          <Button
            size="sm"
            className="cursor-pointer"
            disabled={!canWrite}
            title={canWrite ? undefined : "No permission to create keys"}
            onClick={() => setCreating(true)}
          >
            <Plus className="size-4" />
            New key
          </Button>
        </Toolbar>
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={list.sortFor("name")}>Name</DataTableHead>
              <DataTableHead sort={list.sortFor("description")}>
                Description
              </DataTableHead>
              <DataTableHead sort={list.sortFor("stage")}>Stage</DataTableHead>
              <DataTableHead>Policies</DataTableHead>
              <DataTableHead>Key</DataTableHead>
              <DataTableHead sort={list.sortFor("lastUsed", TIME_WORDS)}>
                Last used
              </DataTableHead>
              <DataTableHead sort={list.sortFor("createdAt", TIME_WORDS)}>
                Created at
              </DataTableHead>
              <DataTableHead sort={list.sortFor("createdBy")}>
                Created by
              </DataTableHead>
              <DataTableHead align="right" />
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map((key) => (
              <DataTableRow key={key._id}>
                <DataTableCell className="font-medium">
                  {key.name}
                </DataTableCell>
                <DataTableCell
                  muted
                  className="max-w-64 truncate"
                  title={key.description}
                >
                  {key.description || "—"}
                </DataTableCell>
                <DataTableCell>{key.stageName}</DataTableCell>
                <DataTableCell>Deploy to {key.stageName}</DataTableCell>
                <DataTableCell muted className="font-mono">
                  {key.keyHint}
                </DataTableCell>
                <DataTableCell>
                  {key.lastUsedAt ? (
                    relativeTime(key.lastUsedAt, now)
                  ) : (
                    <span className="text-muted-foreground">never</span>
                  )}
                </DataTableCell>
                <DataTableCell muted>{formatDate(key.createdAt)}</DataTableCell>
                <DataTableCell>
                  {key.createdBy ? (
                    <Who actor={key.createdBy} />
                  ) : (
                    <span className="text-muted-foreground">API</span>
                  )}
                </DataTableCell>
                <DataTableCell align="right">
                  {canWrite && (
                    <Button
                      variant="ghost"
                      size="sm"
                      tone="muted-destructive"
                      className="cursor-pointer"
                      onClick={() => setDeleting(key)}
                    >
                      Revoke
                    </Button>
                  )}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {list.shown.length === 0 && (
          <EmptyState
            title={
              keys.length === 0
                ? "No API keys yet."
                : "No keys match the current filters."
            }
          />
        )}
        <DataTableFooter
          shown={list.shown.length}
          total={keys.length}
          noun={keys.length === 1 ? "key" : "keys"}
        />
      </div>

      {creating && (
        <NewKeyDialog
          projectId={projectId}
          stages={stages}
          defaultStageId={defaultStageId}
          onClose={() => setCreating(false)}
          onCreated={(token, stageName) => {
            setCreating(false);
            setRevealed({ token: token, stageName: stageName });
          }}
        />
      )}
      {revealed && (
        <RevealedKeyDialog
          token={revealed.token}
          stageName={revealed.stageName}
          onClose={() => setRevealed(null)}
        />
      )}
      {deleting && (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          resourceName={deleting.name}
          resourceType="API key"
          critical={false}
          onConfirm={confirmDelete}
          isDeleting={removing}
        />
      )}
    </section>
  );
}

/** Name, description and stage for a new API key. */
function NewKeyDialog({
  projectId,
  stages,
  defaultStageId,
  onClose,
  onCreated,
}: {
  projectId: Id<"projects">;
  stages: Doc<"stages">[];
  defaultStageId: Id<"stages"> | null;
  onClose: () => void;
  onCreated: (token: string, stageName: string) => void;
}): React.JSX.Element {
  const create = useMutation(api.deployKeys.create);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stage, setStage] = useState<Doc<"stages"> | null>(
    stages.find((entry) => entry._id === defaultStageId) ?? stages[0] ?? null,
  );
  const { pending, error, run } = useSubmit();
  const canSubmit = name.trim().length > 0 && stage !== null && !pending;

  async function submit(): Promise<void> {
    if (!stage || !canSubmit) return;
    await run(async () => {
      const result = await create({
        projectId: projectId,
        stageId: stage._id,
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onCreated(result.token, stage.name);
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New API key</DialogTitle>
          <DialogDescription>
            Deploys and sets variables on one stage. Shown once.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1">
            <Label htmlFor="key-name" variant="muted" className="text-xs">
              Name
            </Label>
            <Input
              id="key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="CI staging"
            />
          </div>
          <div className="grid gap-1">
            <Label
              htmlFor="key-description"
              variant="muted"
              className="text-xs"
            >
              Description
            </Label>
            <Input
              id="key-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Deploys from GitHub Actions"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="key-stage" variant="muted" className="text-xs">
              Stage
            </Label>
            <Select
              items={stages.map((entry) => ({
                label: entry.name,
                value: entry._id,
              }))}
              value={stage?._id ?? ""}
              onValueChange={(value) =>
                setStage(stages.find((entry) => entry._id === value) ?? null)
              }
            >
              <SelectTrigger id="key-stage" className="w-full cursor-pointer">
                <SelectValue placeholder="Pick a stage" />
              </SelectTrigger>
              <SelectContent>
                {stages.map((entry) => (
                  <SelectItem
                    key={entry._id}
                    value={entry._id}
                    className="cursor-pointer"
                  >
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            className="cursor-pointer"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="cursor-pointer"
            onClick={submit}
            disabled={!canSubmit}
          >
            {pending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The one-time plaintext, with the deploy line that uses it. */
function RevealedKeyDialog({
  token,
  stageName,
  onClose,
}: {
  token: string;
  stageName: string;
  onClose: () => void;
}): React.JSX.Element {
  const endpoint = resolveCoreEndpoint();
  const command = endpoint.ok
    ? `BROODS_TOKEN=${token} BROODS_BASE_URL=${endpoint.httpBaseUrl} broods deploy --stage ${stageName.toLowerCase()}`
    : null;

  return (
    <RevealSecretDialog
      title="Save your new API key"
      label="API key"
      secret={token}
      onClose={onClose}
    >
      {command && (
        <div className="grid gap-1">
          <span className="text-2xs text-muted-foreground">
            Deploy from CI or a shell with it
          </span>
          <div className="flex items-start gap-1">
            <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">
              {command}
            </code>
            <CopyButton value={command} label="deploy command" />
          </div>
        </div>
      )}
    </RevealSecretDialog>
  );
}

function apiKeyText(key: ApiKey): string {
  return `${key.name} ${key.description ?? ""}`;
}

function matchesStage(key: ApiKey, _field: ApiField, value: string): boolean {
  return key.stageName.toLowerCase() === value;
}
