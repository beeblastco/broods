"use client";

/**
 * Organization › API access: the keys whose home is the organization, laid
 * out like Roles. The account key reaches everything and rotates. A scoped
 * key holds no access, read, or read and write per config area, an optional
 * stage pin and an optional expiry, and each of them changes inline and saves
 * on pick: the access preset in its table row, each area, the scope and the
 * expiry in its panel. Needs `keys:read`; `keys:write` unlocks every change.
 */

import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/app/components/DataTable";
import { DeleteZone } from "@/app/components/DangerZone";
import {
  DetailRows,
  type ControlRow,
  type DetailRow,
} from "@/app/components/DetailSections";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState, NoPermission } from "@/app/components/EmptyState";
import { RevealSecretDialog } from "@/app/components/RevealSecretDialog";
import { SearchInput } from "@/app/components/SearchInput";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { FilterButton, Toolbar } from "@/app/components/Toolbar";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
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
import { parseAsName } from "@/app/lib/urlState";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import type { ApiResourceType } from "@broods/convex/model/apiAuthorization";
import {
  API_POLICY_ACTIONS,
  type ApiPolicyAction,
} from "@broods/convex/model/policyRules";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { useQueryState } from "nuqs";
import { useEffect, useState } from "react";
import { relativeTime } from "../../../[projectId]/sandbox/components/sandboxFormat";
import { createdRows } from "./createdRows";

const DAY_MS = 24 * 60 * 60 * 1000;

/** An expiry inside this window shows in the warning color. */
const EXPIRY_WARNING_MS = 7 * DAY_MS;

/** The expiry picks, in days from now; "never" sits after them. */
const EXPIRY_DAYS = ["30", "90", "365"] as const;

/** How long a "Saved" note stays beside the control that saved. */
const SAVED_NOTE_MS = 2000;

/** One row per config area, in the order the API action list names them. */
const AREA_LABELS: Record<ApiResourceType, string> = {
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

const AREAS = Object.keys(AREA_LABELS) as ApiResourceType[];

const LEVEL_WORDS: Record<Level, string> = {
  none: "No access",
  read: "Read",
  write: "Read and write",
};

const LEVEL_ITEMS: MenuItem<Level>[] = (["none", "read", "write"] as const).map(
  (level) => ({ value: level, label: LEVEL_WORDS[level] }),
);

const PRESET_WORDS: Record<Preset, string> = {
  full: "Full access",
  read: "Read only",
  restricted: "Restricted",
};

const READ_ACTIONS = API_POLICY_ACTIONS.filter((action) =>
  action.endsWith(":read"),
);

const PRESET_ACTIONS: Record<
  Exclude<Preset, "restricted">,
  ApiPolicyAction[]
> = {
  full: [...API_POLICY_ACTIONS],
  read: READ_ACTIONS,
};

/** Write on sandboxes reaches into running machines, not just their config. */
const SANDBOX_WRITE_WARNING = "Can run commands and open a terminal in them.";

// The `field:value` tokens the search box understands.
const QUERY_FIELDS = ["access"] as const;

// Six columns of short text; below this the detail panel would wrap them.
const TABLE_MIN_WIDTH = 600;

const NO_ROWS: OrgKey[] = [];

const SORT_KEY: Record<Column, (key: OrgKey) => SortKey> = {
  name: (key) => key.name,
  lastUsedAt: (key) => key.lastUsedAt ?? null,
  expiresAt: (key) => key.expiresAt ?? null,
};

type Column = "name" | "lastUsedAt" | "expiresAt";
type Field = (typeof QUERY_FIELDS)[number];
type KeyPatch = Omit<
  FunctionArgs<typeof api.accountApiKeys.update>,
  "orgId" | "keyId"
>;
type Level = "none" | "read" | "write";
type MenuItem<V extends string> = {
  value: V;
  label: string;
  disabled?: boolean;
};
type OrgAccount = NonNullable<
  FunctionReturnType<typeof api.org.orgs.getActiveAccount>
>;
type OrgKeys = NonNullable<FunctionReturnType<typeof api.apiKeys.listForOrg>>;
type OrgKey = OrgKeys["keys"][number];
type Preset = "full" | "read" | "restricted";
type ScopedKey = OrgKey & {
  _id: Id<"accountApiKeys">;
  actions: ApiPolicyAction[];
};
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
  const [selectedId, setSelectedId] = useQueryState("sel", parseAsName);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const { pending, error, run } = useSubmit();
  const list = useListState({
    rows: listed?.keys ?? NO_ROWS,
    fields: QUERY_FIELDS,
    initialSort: { column: "name", dir: "asc" },
    sortKey: SORT_KEY,
    matches: matchesField,
    text: searchText,
  });
  const selected = listed?.keys.find((key) => rowId(key) === selectedId);

  useShortcut("table.create", () => canWrite && account && setCreating(true));

  if (account === undefined || listed === undefined) {
    return <p className="px-6 pt-6 text-sm text-muted-foreground">Loading…</p>;
  }
  if (listed === null) {
    return (
      <div className="px-6 pt-6">
        <NoPermission permission="keys.read" scope="this organization" />
      </div>
    );
  }
  if (!account) {
    return (
      <div className="px-6 pt-6">
        <EmptyState
          title="This organization has no API account yet."
          detail="Provisioning creates the backend tenant and issues a one-time account key."
          action={
            canWrite && (
              <Button
                size="sm"
                className="cursor-pointer"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    const result = await provision({ orgId: org._id });
                    setRevealed(result.secret);
                  })
                }
              >
                {pending ? "Provisioning…" : "Provision account"}
              </Button>
            )
          }
        />
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
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
  const { stages } = listed;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <SearchInput
          value={list.query}
          onChange={list.setQuery}
          fields={QUERY_FIELDS}
          placeholder="Search keys · access:"
        />
        <FilterButton
          columns={[
            {
              label: "Access",
              filter: list.filterFor("access", ["full", "read", "restricted"]),
            },
          ]}
        />
        {canWrite && (
          <Button
            size="sm"
            className="cursor-pointer"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-4" />
            New key
          </Button>
        )}
      </Toolbar>
      <DetailSplit
        flush
        tableMinWidth={TABLE_MIN_WIDTH}
        detail={
          selected &&
          (isScoped(selected) ? (
            <ScopedKeyPanel
              key={selected._id}
              orgId={org._id}
              orgKey={selected}
              stages={stages}
              canWrite={canWrite}
              now={now}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <AccountKeyPanel
              account={account}
              orgId={org._id}
              orgKey={selected}
              canWrite={canWrite}
              onClose={() => setSelectedId(null)}
              onRotated={setRevealed}
            />
          ))
        }
      >
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={list.sortFor("name")}>Key</DataTableHead>
              <DataTableHead>Access</DataTableHead>
              <DataTableHead>Scope</DataTableHead>
              <DataTableHead sort={list.sortFor("lastUsedAt")}>
                Last used
              </DataTableHead>
              <DataTableHead sort={list.sortFor("expiresAt")}>
                Expires
              </DataTableHead>
              <DataTableHead>Created by</DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map((key) => (
              <DataTableRow
                key={rowId(key)}
                selected={selectedId === rowId(key)}
                onClick={() =>
                  setSelectedId(selectedId === rowId(key) ? null : rowId(key))
                }
              >
                <DataTableCell className="font-medium">
                  {key.name}
                </DataTableCell>
                <DataTableCell muted={!isScoped(key)}>
                  {isScoped(key) && canWrite ? (
                    <AccessCell
                      orgId={org._id}
                      orgKey={key}
                      onRestrict={() => setSelectedId(key._id)}
                    />
                  ) : (
                    PRESET_WORDS[presetOf(key)]
                  )}
                </DataTableCell>
                <DataTableCell muted={!key.stageId}>
                  {scopeLabel(key, stages)}
                </DataTableCell>
                <DataTableCell muted={!key.lastUsedAt}>
                  {key.lastUsedAt
                    ? relativeTime(key.lastUsedAt, now)
                    : isScoped(key)
                      ? "never"
                      : "—"}
                </DataTableCell>
                <DataTableCell>
                  <ExpiryLabel expiresAt={key.expiresAt} now={now} />
                </DataTableCell>
                <DataTableCell>
                  <Who actor={key.createdBy ?? PLATFORM} />
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {list.shown.length === 0 && (
          <EmptyState title="No keys match the current filters." />
        )}
      </DetailSplit>
      {creating && (
        <KeyDialog
          orgId={org._id}
          stages={stages}
          onClose={() => setCreating(false)}
          onCreated={(keyId, token) => {
            setCreating(false);
            void setSelectedId(keyId);
            setRevealed(token);
          }}
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

/** A scoped key's Access cell: its preset as a menu that saves on pick. */
function AccessCell({
  orgId,
  orgKey,
  onRestrict,
}: {
  orgId: Id<"orgs">;
  orgKey: ScopedKey;
  onRestrict: () => void;
}): React.JSX.Element {
  const { save, saved, error } = useKeySave(orgId, orgKey._id);

  return (
    <span className="flex items-center gap-1.5" title={error ?? undefined}>
      <InlineMenu
        label="Access"
        value={presetOf(orgKey)}
        items={presetItems(true)}
        className="-ml-2"
        onPick={(preset) =>
          preset === "restricted"
            ? onRestrict()
            : save("access", { actions: PRESET_ACTIONS[preset] })
        }
      />
      {saved === "access" && <Saved />}
      {error && <span className="text-2xs text-destructive">Not saved</span>}
    </span>
  );
}

/**
 * The account key: where to call it from and what it is, with Rotate on the
 * title line. Rotating hands the new secret to `onRotated` to show once.
 */
function AccountKeyPanel({
  account,
  orgId,
  orgKey,
  canWrite,
  onClose,
  onRotated,
}: {
  account: OrgAccount;
  orgId: Id<"orgs">;
  orgKey: OrgKey;
  canWrite: boolean;
  onClose: () => void;
  onRotated: (secret: string) => void;
}): React.JSX.Element {
  const rotate = useAction(api.org.lifecycle.rotateSecret);
  const [rotating, setRotating] = useState(false);
  const { pending, error, run } = useSubmit();
  const endpoint = resolveCoreEndpoint();
  const facts: Array<DetailRow | ControlRow> = [
    {
      key: "access",
      label: "Access",
      value: "Everything, including runs and roles",
      words: true,
    },
    { key: "hint", label: "Key", value: orgKey.keyHint ?? "shown once" },
    { key: "account", label: "Account ID", value: account.accountId },
    endpoint.ok
      ? { key: "base", label: "Base URL", value: endpoint.httpBaseUrl }
      : {
          key: "base",
          label: "Base URL",
          control: (
            <span className="truncate text-warning">{endpoint.message}</span>
          ),
        },
    ...createdRows(orgKey.createdAt, orgKey.createdBy),
  ];

  async function confirmRotate(): Promise<void> {
    const done = await run(async () => {
      const result = await rotate({ orgId: orgId });
      onRotated(result.secret);
    });
    if (done) setRotating(false);
  }

  return (
    <DetailPanel
      title={orgKey.name}
      actions={
        canWrite && (
          <Button
            variant="outline"
            size="sm"
            tone="muted"
            className="cursor-pointer"
            onClick={() => setRotating(true)}
          >
            Rotate
          </Button>
        )
      }
      onClose={onClose}
    >
      <DetailRows rows={facts} />
      {rotating && (
        <ConfirmDialog
          title="Rotate the account key?"
          description="The current key stops working at once. Anything using it needs the new one."
          verb="Rotate"
          pending={pending}
          error={error}
          onConfirm={confirmRotate}
          onClose={() => setRotating(false)}
        />
      )}
    </DetailPanel>
  );
}

/** A labeled full-width Select in the key dialog. */
function DialogSelect({
  id,
  label,
  value,
  items,
  onPick,
}: {
  id: string;
  label: string;
  value: string;
  items: { value: string; label: string }[];
  onPick: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} variant="muted" className="text-xs">
        {label}
      </Label>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => next !== null && onPick(next)}
      >
        <SelectTrigger id={id} className="w-full cursor-pointer">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
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
  if (expiresAt <= now) {
    return <span className="text-destructive">Expired</span>;
  }

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

/** The expiry as an inline pick: keep it, a number of days from now, or never. */
function ExpiryMenu({
  expiresAt,
  now,
  onPick,
}: {
  expiresAt: number | undefined;
  now: number;
  onPick: (expiresAt: number | null) => void;
}): React.JSX.Element {
  const items: MenuItem<string>[] = [
    ...(expiresAt === undefined
      ? []
      : [
          {
            value: "current",
            label: expiresAt <= now ? "Expired" : formatDate(expiresAt),
          },
        ]),
    ...expiryItems(),
  ];

  return (
    <InlineMenu
      label="Expires"
      value={expiresAt === undefined ? "never" : "current"}
      items={items}
      className="-ml-2"
      onPick={(value) =>
        onPick(value === "never" ? null : now + Number(value) * DAY_MS)
      }
    />
  );
}

/**
 * A value edited in place: a quiet button that shows it, and a menu of
 * choices that saves on pick. Clicks stop here, so a menu inside a clickable
 * table row never also toggles the row.
 */
function InlineMenu<V extends string>({
  label,
  value,
  items,
  muted = false,
  className,
  onPick,
}: {
  label: string;
  value: V;
  items: MenuItem<V>[];
  muted?: boolean;
  className?: string;
  onPick: (value: V) => void;
}): React.JSX.Element {
  const stop = (event: React.MouseEvent): void => event.stopPropagation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            tone={muted ? "muted" : undefined}
            className={cn("cursor-pointer", className)}
            aria-label={label}
            onClick={stop}
          />
        }
      >
        {items.find((item) => item.value === value)?.label}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={stop}>
        <DropdownMenuRadioGroup value={value}>
          {items.map((item) => (
            <DropdownMenuRadioItem
              key={item.value}
              value={item.value}
              disabled={item.disabled}
              closeOnClick
              onClick={() => item.value !== value && onPick(item.value)}
            >
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * New key: name, description, scope, expiry and a starting preset. Edit:
 * name and description; everything else changes inline in the panel.
 */
function KeyDialog({
  orgId,
  stages,
  orgKey,
  onClose,
  onCreated,
}: {
  orgId: Id<"orgs">;
  stages: StageOption[];
  orgKey?: ScopedKey;
  onClose: () => void;
  onCreated?: (keyId: Id<"accountApiKeys">, token: string) => void;
}): React.JSX.Element {
  const create = useMutation(api.accountApiKeys.create);
  const update = useMutation(api.accountApiKeys.update);
  const [name, setName] = useState(orgKey?.name ?? "");
  const [description, setDescription] = useState(orgKey?.description ?? "");
  const [stageId, setStageId] = useState("org");
  const [expiry, setExpiry] = useState("90");
  const [preset, setPreset] = useState<"full" | "read">("read");
  const { pending, error, run } = useSubmit();
  const canSubmit = name.trim().length > 0 && !pending;
  const stage = stages.find((entry) => entry.stageId === stageId);

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    await run(async () => {
      if (orgKey) {
        await update({
          orgId: orgId,
          keyId: orgKey._id,
          name: name.trim(),
          description: description.trim(),
        });
        onClose();

        return;
      }
      const result = await create({
        orgId: orgId,
        name: name.trim(),
        description: description.trim() || undefined,
        actions: PRESET_ACTIONS[preset],
        projectId: stage?.projectId,
        stageId: stage?.stageId,
        expiresAt:
          expiry === "never" ? undefined : Date.now() + Number(expiry) * DAY_MS,
      });
      onCreated?.(result._id, result.token);
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{orgKey ? "Edit key" : "New account key"}</DialogTitle>
          <DialogDescription>
            {orgKey
              ? "Access, scope and expiry change in the panel."
              : "Reaches only what you allow. Shown once."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
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
          {!orgKey && (
            <>
              <DialogSelect
                id="org-key-scope"
                label="Scope"
                value={stageId}
                items={scopeItems(stages)}
                onPick={setStageId}
              />
              <DialogSelect
                id="org-key-expiry"
                label="Expires"
                value={expiry}
                items={expiryItems()}
                onPick={setExpiry}
              />
              <div className="grid gap-1">
                <DialogSelect
                  id="org-key-access"
                  label="Access"
                  value={preset}
                  items={[
                    { value: "read", label: PRESET_WORDS.read },
                    { value: "full", label: PRESET_WORDS.full },
                  ]}
                  onPick={(value) =>
                    setPreset(value === "full" ? "full" : "read")
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {preset === "full"
                    ? `Every config area. Sandboxes: ${SANDBOX_WRITE_WARNING.toLowerCase()}`
                    : "Narrow it per config area in the panel."}
                </p>
              </div>
            </>
          )}
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
            {pending ? "Saving…" : orgKey ? "Save" : "Create key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The note beside a control whose change just saved. */
function Saved(): React.JSX.Element {
  return (
    <span className="flex items-center gap-1 text-2xs text-muted-foreground">
      <Check className="size-3 text-success" />
      Saved
    </span>
  );
}

/**
 * The selected scoped key. Edit (name and description) sits on the title
 * line; scope, expiry and each config area's access change in place and save
 * on pick, with "Saved" beside the control; Revoke ends the panel.
 */
function ScopedKeyPanel({
  orgId,
  orgKey,
  stages,
  canWrite,
  now,
  onClose,
}: {
  orgId: Id<"orgs">;
  orgKey: ScopedKey;
  stages: StageOption[];
  canWrite: boolean;
  now: number;
  onClose: () => void;
}): React.JSX.Element {
  const remove = useMutation(api.accountApiKeys.remove);
  const [editing, setEditing] = useState(false);
  const { save, saved, error } = useKeySave(orgId, orgKey._id);
  const levels = levelsOf(orgKey.actions);
  const withSaved = (
    field: string,
    control: React.ReactNode,
  ): React.ReactNode => (
    <span className="flex min-w-0 items-center gap-2">
      {control}
      {saved === field && <Saved />}
    </span>
  );
  const facts: Array<DetailRow | ControlRow> = [
    ...(orgKey.description
      ? [
          {
            key: "description",
            label: "Description",
            value: orgKey.description,
            words: true,
          } as const,
        ]
      : []),
    { key: "hint", label: "Key", value: orgKey.keyHint ?? "" },
    canWrite
      ? {
          key: "scope",
          label: "Scope",
          control: withSaved(
            "scope",
            <InlineMenu
              label="Scope"
              value={orgKey.stageId ?? "org"}
              items={scopeItems(stages)}
              className="-ml-2"
              onPick={(value) => {
                const stage = stages.find((entry) => entry.stageId === value);
                save("scope", {
                  scope: stage
                    ? { projectId: stage.projectId, stageId: stage.stageId }
                    : {},
                });
              }}
            />,
          ),
        }
      : {
          key: "scope",
          label: "Scope",
          value: scopeLabel(orgKey, stages),
          words: true,
        },
    canWrite
      ? {
          key: "expires",
          label: "Expires",
          control: withSaved(
            "expires",
            <ExpiryMenu
              expiresAt={orgKey.expiresAt}
              now={now}
              onPick={(expiresAt) => save("expires", { expiresAt: expiresAt })}
            />,
          ),
        }
      : {
          key: "expires",
          label: "Expires",
          control: <ExpiryLabel expiresAt={orgKey.expiresAt} now={now} />,
        },
    {
      key: "used",
      label: "Last used",
      value: orgKey.lastUsedAt ? relativeTime(orgKey.lastUsedAt, now) : "never",
      words: true,
    },
    ...createdRows(orgKey.createdAt, orgKey.createdBy),
  ];

  function setLevel(area: ApiResourceType, level: Level): void {
    save("access", { actions: actionsOf({ ...levels, [area]: level }) });
  }

  return (
    <DetailPanel
      title={orgKey.name}
      actions={
        canWrite && (
          <Button
            variant="outline"
            size="sm"
            tone="muted"
            className="cursor-pointer"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )
      }
      onClose={onClose}
    >
      <DetailRows rows={facts} />
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <div className="mt-5 mb-1.5 flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">API access</h4>
        <div className="flex items-center gap-2">
          {saved === "access" && <Saved />}
          {canWrite ? (
            <InlineMenu
              label="Access"
              value={presetOf(orgKey)}
              items={presetItems(false)}
              onPick={(preset) =>
                preset !== "restricted" &&
                save("access", { actions: PRESET_ACTIONS[preset] })
              }
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              {PRESET_WORDS[presetOf(orgKey)]}
            </span>
          )}
        </div>
      </div>
      <DataTable>
        <DataTableHeader className="static bg-transparent">
          <tr>
            <DataTableHead>Config area</DataTableHead>
            <DataTableHead align="right">Access</DataTableHead>
          </tr>
        </DataTableHeader>
        <DataTableBody>
          {AREAS.map((area) => (
            <DataTableRow key={area}>
              <DataTableCell muted={levels[area] === "none"}>
                {AREA_LABELS[area]}
                {area === "sandboxes" && levels[area] === "write" && (
                  <p className="text-2xs text-warning">
                    {SANDBOX_WRITE_WARNING}
                  </p>
                )}
              </DataTableCell>
              <DataTableCell align="right">
                {canWrite ? (
                  <InlineMenu
                    label={`${AREA_LABELS[area]} access`}
                    value={levels[area]}
                    items={LEVEL_ITEMS}
                    muted={levels[area] === "none"}
                    onPick={(level) => setLevel(area, level)}
                  />
                ) : (
                  LEVEL_WORDS[levels[area]]
                )}
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
      <p className="mt-1.5 text-xs text-muted-foreground">
        A scoped key never runs agents or manages roles.
      </p>

      {canWrite && (
        <DeleteZone
          description="Revoke the key. Anything using it gets 401 from its next request."
          resourceName={orgKey.name}
          resourceType="key"
          verb="Revoke"
          onDelete={() => remove({ orgId: orgId, keyId: orgKey._id })}
          onDeleted={onClose}
        />
      )}

      {editing && (
        <KeyDialog
          orgId={orgId}
          stages={stages}
          orgKey={orgKey}
          onClose={() => setEditing(false)}
        />
      )}
    </DetailPanel>
  );
}

/** The actions a set of area levels grants; write carries read with it. */
function actionsOf(levels: Record<ApiResourceType, Level>): ApiPolicyAction[] {
  return API_POLICY_ACTIONS.filter((action) => {
    const [area, verb] = action.split(":") as [ApiResourceType, string];

    return (
      levels[area] === "write" || (levels[area] === "read" && verb === "read")
    );
  });
}

/** The expiry picks: days from now, then never. */
function expiryItems(): MenuItem<string>[] {
  return [
    ...EXPIRY_DAYS.map((days) => ({
      value: days,
      label: `${days} days from now`,
    })),
    { value: "never", label: "Never" },
  ];
}

function isScoped(key: OrgKey): key is ScopedKey {
  return key._id !== undefined && key.actions !== undefined;
}

/** Each config area's level from the actions a key holds. */
function levelsOf(actions: ApiPolicyAction[]): Record<ApiResourceType, Level> {
  const held = new Set(actions);
  const levels = {} as Record<ApiResourceType, Level>;
  for (const area of AREAS) {
    levels[area] = held.has(`${area}:write`)
      ? "write"
      : held.has(`${area}:read`)
        ? "read"
        : "none";
  }

  return levels;
}

function matchesField(key: OrgKey, _field: Field, value: string): boolean {
  return presetOf(key) === value;
}

/** Full when a key holds every action, read when exactly the reads; the account key is full. */
function presetOf(key: OrgKey): Preset {
  if (!key.actions || key.actions.length === API_POLICY_ACTIONS.length) {
    return "full";
  }
  const reads = key.actions.every((action) => action.endsWith(":read"));

  return reads && key.actions.length === READ_ACTIONS.length
    ? "read"
    : "restricted";
}

/** The presets; Restricted is a pick only where it can open the key's areas. */
function presetItems(restrictable: boolean): MenuItem<Preset>[] {
  return [
    { value: "full", label: PRESET_WORDS.full },
    { value: "read", label: PRESET_WORDS.read },
    {
      value: "restricted",
      label: PRESET_WORDS.restricted,
      disabled: !restrictable,
    },
  ];
}

/** The selection id in `?sel=`: a scoped key's id, or "account". */
function rowId(key: OrgKey): string {
  return key._id ?? "account";
}

function scopeItems(stages: StageOption[]): { value: string; label: string }[] {
  return [
    { value: "org", label: "Organization" },
    ...stages.map((stage) => ({
      value: stage.stageId,
      label: stageLabel(stage),
    })),
  ];
}

function scopeLabel(key: OrgKey, stages: StageOption[]): string {
  if (!key.stageId) return "Organization";
  const stage = stages.find((entry) => entry.stageId === key.stageId);

  return stage ? stageLabel(stage) : "—";
}

function searchText(key: OrgKey): string {
  return `${key.name} ${key.description ?? ""}`;
}

function stageLabel(stage: StageOption): string {
  return `${stage.projectName} / ${stage.stageName}`;
}

/**
 * One inline save of a scoped key at a time, and which control saved last,
 * so its "Saved" note shows beside that control for a moment.
 */
function useKeySave(
  orgId: Id<"orgs">,
  keyId: Id<"accountApiKeys">,
): {
  save: (field: string, patch: KeyPatch) => void;
  saved: string | null;
  error: string | null;
} {
  const update = useMutation(api.accountApiKeys.update);
  const { error, run } = useSubmit();
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (saved === null) return;
    const timer = setTimeout(() => setSaved(null), SAVED_NOTE_MS);

    return () => clearTimeout(timer);
  }, [saved]);

  return {
    save: (field, patch) => {
      setSaved(null);
      void run(async () => {
        await update({ orgId: orgId, keyId: keyId, ...patch });
        setSaved(field);
      });
    },
    saved: saved,
    error: error,
  };
}
