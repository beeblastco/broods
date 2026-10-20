"use client";

/**
 * Organization › API access: the keys whose home is the organization. The
 * account key reaches everything; its plaintext is shown once after
 * provision or rotate. Scoped keys carry their own permissions (none, read
 * or write per API resource), an optional project/stage scope and an
 * optional expiry; they are edited in place and revoked by deleting them.
 * Needs `keys:read`; `keys:write` unlocks New key, Edit, Revoke and Rotate.
 */

import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { CopyRow } from "@/app/components/CopyButton";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableFooter,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/app/components/DataTable";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { EmptyState, NoPermission } from "@/app/components/EmptyState";
import { RevealSecretDialog } from "@/app/components/RevealSecretDialog";
import { SegmentedControl } from "@/app/components/SegmentedControl";
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
import { useNow } from "@/app/hooks/useNow";
import { usePermissions } from "@/app/hooks/usePermissions";
import { useSubmit } from "@/app/hooks/useSubmit";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { formatDate } from "@/app/lib/formatTime";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import {
  API_POLICY_ACTIONS,
  type ApiPolicyAction,
} from "@broods/convex/model/policyRules";
import type { FunctionReturnType } from "convex/server";
import { useAction, useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { useState } from "react";
import { relativeTime } from "../../../[projectId]/sandbox/components/sandboxFormat";

const DAY_MS = 24 * 60 * 60 * 1000;

const LEVELS = [
  { id: "none", label: "None" },
  { id: "read", label: "Read" },
  { id: "write", label: "Write" },
] as const;

const EXPIRY_OPTIONS = [
  { id: "30", label: "30d" },
  { id: "90", label: "90d" },
  { id: "365", label: "1y" },
  { id: "never", label: "Never" },
] as const;

/** One grid row per API resource, in the order the action list names them. */
const RESOURCES = [
  ...new Set(API_POLICY_ACTIONS.map((action) => action.split(":")[0])),
] as Resource[];

const RESOURCE_LABELS: Record<Resource, string> = {
  account: "Account",
  agents: "Agents",
  audit: "Audit log",
  channels: "Channels",
  crons: "Crons",
  env: "Env vars",
  hooks: "Hooks",
  mcp: "MCP servers",
  policies: "Policies",
  sandboxes: "Sandboxes",
  skills: "Skills",
  workspaces: "Workspaces",
};

/** An expiry inside this window shows in the warning color. */
const EXPIRY_WARNING_MS = 7 * DAY_MS;

type Expiry = (typeof EXPIRY_OPTIONS)[number]["id"];
type Level = (typeof LEVELS)[number]["id"];
type OrgKeys = NonNullable<FunctionReturnType<typeof api.apiKeys.listForOrg>>;
type OrgKey = OrgKeys["keys"][number];
type Resource = ApiPolicyAction extends `${infer R}:${string}` ? R : never;
type StageOption = OrgKeys["stages"][number];

interface Props {
  org: Doc<"orgs">;
}

export function ApiAccessPanel({ org }: Props): React.JSX.Element {
  // `keys:write` for the organization makes, edits and revokes keys and
  // rotates the account key: the admin tier holds it, and a role may be
  // granted it.
  const { can } = usePermissions();
  const canWrite = can("keys:write");
  const now = useNow();
  const account = useQuery(api.org.orgs.getActiveAccount, {});
  const listed = useQuery(api.apiKeys.listForOrg, {});
  const provision = useAction(api.org.lifecycle.provision);
  const rotate = useAction(api.org.lifecycle.rotateSecret);
  const remove = useMutation(api.accountApiKeys.remove);
  const endpoint = resolveCoreEndpoint();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [editing, setEditing] = useState<OrgKey | "new" | null>(null);
  const [revoking, setRevoking] = useState<OrgKey | null>(null);
  const [removing, setRemoving] = useState(false);
  const { pending, error, run } = useSubmit();

  async function mint(
    action: () => Promise<{ secret: string }>,
  ): Promise<void> {
    const done = await run(async () => {
      const result = await action();
      setRevealed(result.secret);
    });
    if (done) setRotateOpen(false);
  }

  async function confirmRevoke(): Promise<void> {
    if (!revoking?._id) return;
    setRemoving(true);
    try {
      await remove({ orgId: org._id, keyId: revoking._id });
      setRevoking(null);
    } finally {
      setRemoving(false);
    }
  }

  if (account === undefined || listed === undefined) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (listed === null) {
    return <NoPermission permission="keys.read" scope="this organization" />;
  }
  const { keys, stages } = listed;

  return (
    <div className="grid gap-6">
      <section className="grid gap-2">
        <div>
          <h2 className="text-sm font-semibold">API access</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Keys whose home is the organization. Project and stage keys live in
            the project.
          </p>
        </div>
        {account && (
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Account ID</dt>
            <dd className="min-w-0">
              <CopyRow
                value={account.accountId}
                className="flex w-full rounded-md bg-muted px-3 py-2 font-mono text-xs"
              >
                <span className="flex-1 truncate">{account.accountId}</span>
              </CopyRow>
            </dd>
            <dt className="text-muted-foreground">Base URL</dt>
            <dd className="min-w-0">
              {endpoint.ok ? (
                <CopyRow
                  value={endpoint.httpBaseUrl}
                  className="flex w-full rounded-md bg-muted px-3 py-2 font-mono text-xs"
                >
                  <span className="flex-1 truncate">
                    {endpoint.httpBaseUrl}
                  </span>
                </CopyRow>
              ) : (
                <span className="text-warning">{endpoint.message}</span>
              )}
            </dd>
          </dl>
        )}
      </section>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {account && (
          <Toolbar className="justify-end">
            <NewKeyButton
              canWrite={canWrite}
              onClick={() => setEditing("new")}
            />
          </Toolbar>
        )}
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead>Name</DataTableHead>
              <DataTableHead>Description</DataTableHead>
              <DataTableHead>Permissions</DataTableHead>
              <DataTableHead>Scope</DataTableHead>
              <DataTableHead>Key</DataTableHead>
              <DataTableHead>Last used</DataTableHead>
              <DataTableHead>Expires</DataTableHead>
              <DataTableHead>Created at</DataTableHead>
              <DataTableHead>Created by</DataTableHead>
              <DataTableHead align="right" />
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {account &&
              keys.map((key) => (
                <KeyRow
                  key={key._id ?? "account"}
                  orgKey={key}
                  stages={stages}
                  now={now}
                >
                  {canWrite && (
                    <KeyActions
                      scoped={key._id !== undefined}
                      pending={pending}
                      onRotate={() => setRotateOpen(true)}
                      onEdit={() => setEditing(key)}
                      onRevoke={() => setRevoking(key)}
                    />
                  )}
                </KeyRow>
              ))}
          </DataTableBody>
        </DataTable>
        {!account && (
          <EmptyState
            title="This organization has no API account yet."
            detail="Provisioning creates the backend tenant and issues a one-time account key."
            action={
              canWrite && (
                <Button
                  size="sm"
                  className="cursor-pointer"
                  disabled={pending}
                  onClick={() => mint(() => provision({ orgId: org._id }))}
                >
                  {pending ? "Provisioning…" : "Provision account"}
                </Button>
              )
            }
          />
        )}
        <DataTableFooter
          total={account ? keys.length : 0}
          noun={account ? ["key", "keys"] : ["account", "accounts"]}
        />
      </div>
      {error && !rotateOpen && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {rotateOpen && (
        <ConfirmDialog
          title="Rotate the account key?"
          description="The current key stops working at once. Anything using it needs the new one."
          verb="Rotate"
          pending={pending}
          error={error}
          onConfirm={() => mint(() => rotate({ orgId: org._id }))}
          onClose={() => setRotateOpen(false)}
        />
      )}
      {editing && (
        <KeyDialog
          orgId={org._id}
          editing={editing === "new" ? null : editing}
          stages={stages}
          onClose={() => setEditing(null)}
          onCreated={(token) => {
            setEditing(null);
            setRevealed(token);
          }}
        />
      )}
      {revoking && (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => !open && setRevoking(null)}
          resourceName={revoking.name}
          resourceType="key"
          verb="Revoke"
          onConfirm={confirmRevoke}
          isDeleting={removing}
        />
      )}
      {revealed && (
        <RevealSecretDialog
          title="Save your new account key"
          label="account key"
          secret={revealed}
          onClose={() => setRevealed(null)}
        />
      )}
    </div>
  );
}

/** "never", the expiry date, or "Expired"; a date within a week is a warning. */
function ExpiryLabel({
  expiresAt,
  now,
}: {
  expiresAt: number | undefined;
  now: number;
}): React.JSX.Element {
  if (expiresAt === undefined) {
    return <span className="text-muted-foreground">never</span>;
  }
  if (expiresAt <= now)
    return <span className="text-destructive">Expired</span>;

  return (
    <span
      className={
        expiresAt - now < EXPIRY_WARNING_MS ? "text-warning" : undefined
      }
    >
      {formatDate(expiresAt)}
    </span>
  );
}

/** Rotate for the account key; Edit and Revoke for a scoped key. */
function KeyActions({
  scoped,
  pending,
  onRotate,
  onEdit,
  onRevoke,
}: {
  scoped: boolean;
  pending: boolean;
  onRotate: () => void;
  onEdit: () => void;
  onRevoke: () => void;
}): React.JSX.Element {
  if (!scoped) {
    return (
      <Button
        variant="ghost"
        size="sm"
        tone="muted"
        className="cursor-pointer"
        disabled={pending}
        onClick={onRotate}
      >
        Rotate
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        tone="muted"
        className="cursor-pointer"
        onClick={onEdit}
      >
        Edit
      </Button>
      <Button
        variant="ghost"
        size="sm"
        tone="muted-destructive"
        className="cursor-pointer"
        onClick={onRevoke}
      >
        Revoke
      </Button>
    </>
  );
}

/** One key's row; `children` are its actions. */
function KeyRow({
  orgKey,
  stages,
  now,
  children,
}: {
  orgKey: OrgKey;
  stages: StageOption[];
  now: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <DataTableRow>
      <DataTableCell className="font-medium">{orgKey.name}</DataTableCell>
      <DataTableCell
        muted
        className="max-w-64 truncate"
        title={orgKey.description}
      >
        {orgKey.description || "—"}
      </DataTableCell>
      <DataTableCell>
        <PermissionSummary actions={orgKey.actions} />
      </DataTableCell>
      <DataTableCell muted={!orgKey.stageId}>
        {scopeLabel(orgKey, stages)}
      </DataTableCell>
      <DataTableCell muted className="font-mono">
        {orgKey.keyHint ?? "shown once"}
      </DataTableCell>
      <DataTableCell>
        {orgKey.lastUsedAt ? (
          relativeTime(orgKey.lastUsedAt, now)
        ) : (
          <span className="text-muted-foreground">
            {orgKey._id ? "never" : "—"}
          </span>
        )}
      </DataTableCell>
      <DataTableCell>
        <ExpiryLabel expiresAt={orgKey.expiresAt} now={now} />
      </DataTableCell>
      <DataTableCell muted>{formatDate(orgKey.createdAt)}</DataTableCell>
      <DataTableCell>
        <Who actor={orgKey.createdBy ?? PLATFORM} />
      </DataTableCell>
      <DataTableCell align="right">{children}</DataTableCell>
    </DataTableRow>
  );
}

/**
 * Create a scoped key, or edit one in place. The grid sets none, read or
 * write per resource (write includes read); the scope and, on create, the
 * expiry sit above it. The secret and expiry never change on edit.
 */
function KeyDialog({
  orgId,
  editing,
  stages,
  onClose,
  onCreated,
}: {
  orgId: Id<"orgs">;
  editing: OrgKey | null;
  stages: StageOption[];
  onClose: () => void;
  onCreated: (token: string) => void;
}): React.JSX.Element {
  const create = useMutation(api.accountApiKeys.create);
  const update = useMutation(api.accountApiKeys.update);
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [stageId, setStageId] = useState<string>(editing?.stageId ?? "org");
  const [expiry, setExpiry] = useState<Expiry>("90");
  const [levels, setLevels] = useState<Record<Resource, Level>>(() =>
    levelsOf(editing?.actions ?? []),
  );
  const { pending, error, run } = useSubmit();
  const actions = actionsOf(levels);
  const canSubmit = name.trim().length > 0 && actions.length > 0 && !pending;
  const pin = keyPin(stageId, stages, editing);
  const scopeItems = scopeChoices(stages, editing);

  function setAll(level: Level): void {
    setLevels(
      Object.fromEntries(
        RESOURCES.map((resource) => [resource, level]),
      ) as Record<Resource, Level>,
    );
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    const fields = {
      orgId: orgId,
      name: name.trim(),
      description: description.trim() || undefined,
      actions: actions,
      projectId: pin?.projectId,
      stageId: pin?.stageId,
    };
    await run(async () => {
      if (editing?._id) {
        await update({ ...fields, keyId: editing._id });
        onClose();

        return;
      }
      const result = await create({
        ...fields,
        expiresAt:
          expiry === "never" ? undefined : Date.now() + Number(expiry) * DAY_MS,
      });
      onCreated(result.token);
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit key" : "New account key"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes apply to the next request the key makes."
              : "Reaches only what you allow here. Shown once."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label htmlFor="org-key-name" variant="muted" className="text-xs">
                Name
              </Label>
              <Input
                id="org-key-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Grafana"
              />
            </div>
            <div className="grid gap-1">
              <Label
                htmlFor="org-key-description"
                variant="muted"
                className="text-xs"
              >
                Description
              </Label>
              <Input
                id="org-key-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Reads the audit log"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label
                htmlFor="org-key-scope"
                variant="muted"
                className="text-xs"
              >
                Scope
              </Label>
              <Select
                items={scopeItems}
                value={stageId}
                onValueChange={(value) => setStageId(value ?? "org")}
              >
                <SelectTrigger
                  id="org-key-scope"
                  className="w-full cursor-pointer"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopeItems.map((item) => (
                    <SelectItem
                      key={item.value}
                      value={item.value}
                      className="cursor-pointer"
                    >
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <span className="text-xs text-muted-foreground">Expires</span>
              {editing ? (
                <span className="py-1.5 text-sm">
                  {editing.expiresAt ? formatDate(editing.expiresAt) : "Never"}
                </span>
              ) : (
                <SegmentedControl
                  options={EXPIRY_OPTIONS}
                  value={expiry}
                  onChange={setExpiry}
                  ariaLabel="Expires"
                />
              )}
            </div>
          </div>
          <div className="grid gap-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Permissions</span>
              <div className="flex items-center">
                {LEVELS.map((level) => (
                  <Button
                    key={level.id}
                    variant="ghost"
                    size="sm"
                    tone="muted"
                    className="cursor-pointer"
                    onClick={() => setAll(level.id)}
                  >
                    All {level.label.toLowerCase()}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
              {RESOURCES.map((resource) => (
                <div
                  key={resource}
                  className="flex items-center justify-between gap-3 px-3 py-1.5"
                >
                  <span className="text-sm">{RESOURCE_LABELS[resource]}</span>
                  <SegmentedControl
                    options={LEVELS}
                    value={levels[resource]}
                    onChange={(level) =>
                      setLevels({ ...levels, [resource]: level })
                    }
                    ariaLabel={`${RESOURCE_LABELS[resource]} access`}
                  />
                </div>
              ))}
            </div>
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
            className={canSubmit ? "cursor-pointer" : "cursor-not-allowed"}
            onClick={submit}
            disabled={!canSubmit}
          >
            {pending ? "Saving…" : editing ? "Save" : "Create key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The toolbar's primary action, disabled with a reason without `keys:write`. */
function NewKeyButton({
  canWrite,
  onClick,
}: {
  canWrite: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <Button
      size="sm"
      className={canWrite ? "cursor-pointer" : "cursor-not-allowed"}
      disabled={!canWrite}
      title={canWrite ? undefined : "No permission to make keys"}
      onClick={onClick}
    >
      <Plus className="size-4" />
      New key
    </Button>
  );
}

/** "Full access" for the account key; otherwise write and read counts, listed on hover. */
function PermissionSummary({
  actions,
}: {
  actions: ApiPolicyAction[] | undefined;
}): React.JSX.Element {
  if (!actions) return <span>Full access</span>;
  const levels = levelsOf(actions);
  const granted = RESOURCES.filter((resource) => levels[resource] !== "none");
  const writes = granted.filter((resource) => levels[resource] === "write");
  const parts = [
    writes.length > 0 ? `${writes.length} write` : null,
    granted.length > writes.length
      ? `${granted.length - writes.length} read`
      : null,
  ].filter((part) => part !== null);

  return (
    <span
      className="cursor-help"
      title={granted
        .map((resource) => `${RESOURCE_LABELS[resource]}: ${levels[resource]}`)
        .join("\n")}
    >
      {parts.join(" · ")}
    </span>
  );
}

/** The actions a grid grants; write carries read with it. */
function actionsOf(levels: Record<Resource, Level>): ApiPolicyAction[] {
  return API_POLICY_ACTIONS.filter((action) => {
    const [resource, verb] = action.split(":") as [Resource, "read" | "write"];
    const level = levels[resource];

    return level === "write" || (level === "read" && verb === "read");
  });
}

/**
 * The pin a save sends for the picked scope. A key pinned to a stage since
 * deleted keeps that pin, so the save is refused instead of quietly widening
 * the key to the whole organization.
 */
function keyPin(
  stageId: string,
  stages: StageOption[],
  editing: OrgKey | null,
): { projectId?: Id<"projects">; stageId?: Id<"stages"> } | undefined {
  if (stageId === "org") return undefined;

  return (
    stages.find((entry) => entry.stageId === stageId) ?? editing ?? undefined
  );
}

/** Each resource's grid level from the actions a key holds. */
function levelsOf(actions: ApiPolicyAction[]): Record<Resource, Level> {
  const held = new Set(actions);

  return Object.fromEntries(
    RESOURCES.map((resource) => [
      resource,
      held.has(`${resource}:write`)
        ? "write"
        : held.has(`${resource}:read`)
          ? "read"
          : "none",
    ]),
  ) as Record<Resource, Level>;
}

/** The scope picker's options; an edited key's deleted stage stays listed as such. */
function scopeChoices(
  stages: StageOption[],
  editing: OrgKey | null,
): { label: string; value: string }[] {
  const choices = [
    { label: "Whole organization", value: "org" },
    ...stages.map((entry) => ({
      label: `${entry.projectName} / ${entry.stageName}`,
      value: entry.stageId,
    })),
  ];
  const lost = editing?.stageId;
  if (lost && !stages.some((entry) => entry.stageId === lost)) {
    choices.push({ label: "Deleted stage", value: lost });
  }

  return choices;
}

function scopeLabel(key: OrgKey, stages: StageOption[]): string {
  if (!key.stageId) return "Organization";
  const stage = stages.find((entry) => entry.stageId === key.stageId);

  return stage ? `${stage.projectName} / ${stage.stageName}` : "Deleted stage";
}
