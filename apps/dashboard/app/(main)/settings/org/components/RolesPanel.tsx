"use client";

/**
 * Organization › Roles: a role is a name for a set of policies, and members
 * get one role each. Built-in roles are the three tiers; custom roles sit on
 * the member tier and add what their policies allow.
 *
 * Laid out like Monitoring: a toolbar, a flush table whose headers sort on
 * click, and a detail panel with Edit on its title line, the role's policies
 * and pages in the body, and the danger zone at the end.
 */

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/app/components/DataTable";
import { DeleteZone } from "@/app/components/DangerZone";
import { DetailRows, type DetailRow } from "@/app/components/DetailSections";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { StatusWord } from "@/app/components/StatusDot";
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Switch } from "@/app/components/ui/switch";
import { actorName, PLATFORM, Who, WhoGroup } from "@/app/components/Who";
import { createdRows } from "./createdRows";
import { useListState } from "@/app/hooks/useListState";
import { usePermissions } from "@/app/hooks/usePermissions";
import { useSubmit } from "@/app/hooks/useSubmit";
import { formatDate } from "@/app/lib/formatTime";
import { tabHref } from "@/app/lib/navigation";
import type { SortKey } from "@/app/lib/tableState";
import { parseAsName } from "@/app/lib/urlState";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  DASHBOARD_DESCRIPTIONS,
  DASHBOARD_POLICY_ACTIONS,
} from "@broods/convex/model/policyRules";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useQueryState } from "nuqs";
import { useState } from "react";

type Role = FunctionReturnType<typeof api.access.listRoles>[number];
type CustomRole = Extract<Role, { kind: "custom" }>;
type Policy = FunctionReturnType<typeof api.access.listPolicies>[number];
type Column = "name" | "description" | "policies" | "members" | "createdAt";
type Field = (typeof QUERY_FIELDS)[number];

// The `field:value` tokens the search box understands.
const QUERY_FIELDS = ["kind"] as const;

// Six columns of short text; below this the detail panel would wrap them.
const TABLE_MIN_WIDTH = 640;

const NO_ROWS: Role[] = [];

const SORT_KEY: Record<Column, (role: Role) => SortKey> = {
  name: (role) => role.name,
  description: (role) => role.description,
  policies: (role) => role.policyIds.length,
  members: (role) => role.members.length,
  createdAt: (role) => (role.kind === "custom" ? role.createdAt : null),
};

export function RolesPanel(): React.JSX.Element {
  const { can } = usePermissions();
  const canChange = can("access:write");
  const roles = useQuery(api.access.listRoles, {});
  const policies = useQuery(api.access.listPolicies, {});
  const [selectedName, setSelectedName] = useQueryState("sel", parseAsName);
  const [creating, setCreating] = useState(false);
  const list = useListState({
    rows: roles ?? NO_ROWS,
    fields: QUERY_FIELDS,
    initialSort: { column: "name", dir: "asc" },
    sortKey: SORT_KEY,
    matches: matchesField,
    text: searchText,
  });
  const selected = roles?.find((role) => role.name === selectedName);
  const filters = {
    kind: list.filterFor("kind", ["built-in", "custom"]),
  };

  useShortcut("table.create", () => canChange && setCreating(true));

  if (roles === undefined || policies === undefined) {
    return <p className="px-6 pt-6 text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <SearchInput
          value={list.query}
          onChange={list.setQuery}
          fields={QUERY_FIELDS}
          placeholder="Search roles · kind:"
        />
        <FilterButton columns={[{ label: "Kind", filter: filters.kind }]} />
        {canChange && (
          <Button
            size="sm"
            className="cursor-pointer"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-4" />
            New role
          </Button>
        )}
      </Toolbar>
      <DetailSplit
        flush
        tableMinWidth={TABLE_MIN_WIDTH}
        detail={
          selected && (
            <RolePanel
              key={selected.name}
              role={selected}
              policies={policies}
              canChange={canChange}
              onClose={() => setSelectedName(null)}
            />
          )
        }
      >
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={list.sortFor("name")}>Role</DataTableHead>
              <DataTableHead sort={list.sortFor("description")}>
                Description
              </DataTableHead>
              <DataTableHead sort={list.sortFor("policies")}>
                Policies
              </DataTableHead>
              <DataTableHead sort={list.sortFor("members")}>
                Members
              </DataTableHead>
              <DataTableHead sort={list.sortFor("createdAt")}>
                Created
              </DataTableHead>
              <DataTableHead>Created by</DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map((role) => (
              <DataTableRow
                key={role.name}
                selected={selectedName === role.name}
                onClick={() =>
                  setSelectedName(selectedName === role.name ? null : role.name)
                }
              >
                <DataTableCell className="font-medium">
                  {role.name}
                </DataTableCell>
                <DataTableCell muted className="max-w-72 truncate">
                  {role.description}
                </DataTableCell>
                <DataTableCell muted={role.kind === "built-in"}>
                  {role.kind === "built-in" ? "all" : role.policyIds.length}
                </DataTableCell>
                <DataTableCell muted={role.members.length === 0}>
                  {role.members.length === 0 ? (
                    "—"
                  ) : (
                    <WhoGroup actors={role.members} />
                  )}
                </DataTableCell>
                <DataTableCell muted>
                  {role.kind === "custom" ? formatDate(role.createdAt) : "—"}
                </DataTableCell>
                <DataTableCell>
                  <Who
                    actor={
                      (role.kind === "custom" && role.createdBy) || PLATFORM
                    }
                  />
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {list.shown.length === 0 && (
          <EmptyState title="No roles match the current filters." />
        )}
      </DetailSplit>
      {creating && (
        <RoleDialog policies={policies} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

/**
 * The selected role. Edit sits on the title line; the body holds its facts,
 * its policies with attach and detach, the pages it opens, and the danger zone.
 */
function RolePanel({
  role,
  policies,
  canChange,
  onClose,
}: {
  role: Role;
  policies: Policy[];
  canChange: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const update = useMutation(api.access.updateRole);
  const remove = useMutation(api.access.removeRole);
  const [editing, setEditing] = useState(false);
  const { error, run } = useSubmit();
  const attached = policies.filter((policy) =>
    role.policyIds.includes(policy._id),
  );
  const attachable = policies.filter(
    (policy) => !role.policyIds.includes(policy._id),
  );
  const custom = role.kind === "custom" ? role : null;
  const editable = canChange && custom !== null;

  const facts: DetailRow[] = [
    {
      key: "description",
      label: "Description",
      value: role.description,
      words: true,
    },
    {
      key: "members",
      label: "Members",
      value:
        role.members.length === 0
          ? "none"
          : role.members.map(actorName).join(", "),
      words: true,
    },
    ...createdRows(custom?.createdAt, custom?.createdBy),
  ];

  function setPolicies(policyIds: Id<"agentPolicies">[]): void {
    if (custom)
      void run(() => update({ roleId: custom._id, policyIds: policyIds }));
  }

  return (
    <DetailPanel
      title={role.name}
      actions={
        editable && (
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
        <h4 className="text-sm font-medium">Policies</h4>
        {editable && (
          <AttachPolicy
            policies={policies}
            attachable={attachable}
            onAttach={(policy) => setPolicies([...role.policyIds, policy._id])}
          />
        )}
      </div>
      {role.kind === "built-in" ? (
        <p className="text-xs text-muted-foreground">
          A built-in role holds every permission of its tier.
        </p>
      ) : attached.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {policies.length === 0
            ? "No policies in the organization yet. Make one under Policies, then attach it here."
            : "No policies yet. Attach one to give the role its permissions."}
        </p>
      ) : (
        <DataTable>
          <DataTableHeader className="static bg-transparent">
            <tr>
              <DataTableHead>Policy</DataTableHead>
              <DataTableHead>Rules</DataTableHead>
              <DataTableHead>Scope</DataTableHead>
              <DataTableHead align="right" />
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {attached.map((policy) => (
              <DataTableRow key={policy._id}>
                <DataTableCell>{policy.name}</DataTableCell>
                <DataTableCell muted className="tabular-nums">
                  {policy.rules.length}
                </DataTableCell>
                <DataTableCell muted>{policy.scope}</DataTableCell>
                <DataTableCell align="right">
                  {editable && (
                    <Button
                      variant="ghost"
                      size="xs"
                      tone="muted"
                      className="cursor-pointer"
                      onClick={() =>
                        setPolicies(
                          role.policyIds.filter((id) => id !== policy._id),
                        )
                      }
                    >
                      Detach
                    </Button>
                  )}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}

      <h4 className="mt-5 mb-1.5 text-sm font-medium">Pages</h4>
      <p className="mb-1.5 text-xs text-muted-foreground">
        What a member with this role may do in the dashboard.
      </p>
      <DataTable>
        <DataTableHeader className="static bg-transparent">
          <tr>
            <DataTableHead>Page</DataTableHead>
            <DataTableHead align="right">Access</DataTableHead>
          </tr>
        </DataTableHeader>
        <DataTableBody>
          {DASHBOARD_POLICY_ACTIONS.map((action) => {
            const allowed = role.permissions.includes(action);

            return (
              <DataTableRow key={action}>
                <DataTableCell>{DASHBOARD_DESCRIPTIONS[action]}</DataTableCell>
                <DataTableCell align="right">
                  <StatusWord tone={allowed ? "ok" : "ended"}>
                    {allowed ? "allowed" : "denied"}
                  </StatusWord>
                </DataTableCell>
              </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTable>

      {editable && custom && (
        <DeleteZone
          description="Delete the role. A member who holds it has to be given another role first."
          resourceName={custom.name}
          resourceType="role"
          onDelete={() => remove({ roleId: custom._id })}
          onDeleted={onClose}
        />
      )}

      {editing && custom && (
        <RoleDialog
          role={custom}
          policies={policies}
          onClose={() => setEditing(false)}
        />
      )}
    </DetailPanel>
  );
}

/**
 * The Policies section's one control. With no policy in the org it links to
 * the Policies tab, since there is nothing to attach yet; otherwise it lists
 * the policies the role does not hold, or says every one is attached.
 */
function AttachPolicy({
  policies,
  attachable,
  onAttach,
}: {
  policies: Policy[];
  attachable: Policy[];
  onAttach: (policy: Policy) => void;
}): React.JSX.Element {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const look = {
    variant: "outline",
    size: "sm",
    tone: "muted",
    className: "cursor-pointer",
  } as const;

  if (policies.length === 0) {
    return (
      <Button
        {...look}
        nativeButton={false}
        render={<Link href={tabHref(pathname, "policies", search)} />}
      >
        New policy
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button {...look} />}>
        Attach policy
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {attachable.length === 0 && (
          <DropdownMenuItem disabled>Every policy is attached</DropdownMenuItem>
        )}
        {attachable.map((policy) => (
          <DropdownMenuItem key={policy._id} onClick={() => onAttach(policy)}>
            {policy.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
/** New or edit: name, description and the policies the role holds. */
function RoleDialog({
  role,
  policies,
  onClose,
}: {
  role?: CustomRole;
  policies: Policy[];
  onClose: () => void;
}): React.JSX.Element {
  const create = useMutation(api.access.createRole);
  const update = useMutation(api.access.updateRole);
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [policyIds, setPolicyIds] = useState<Id<"agentPolicies">[]>(
    role?.policyIds ?? [],
  );
  const { pending, error, run } = useSubmit();

  async function submit(): Promise<void> {
    const done = await run(() =>
      role
        ? update({
            roleId: role._id,
            name: name.trim(),
            description: description.trim() || null,
            policyIds: policyIds,
          })
        : create({
            name: name.trim(),
            description: description.trim() || undefined,
            policyIds: policyIds,
          }),
    );
    if (done) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{role ? "Edit role" : "New role"}</DialogTitle>
          <DialogDescription>
            A role is a name for a set of policies. Members get one role each.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1">
            <Label htmlFor="role-name" variant="muted" className="text-xs">
              Name
            </Label>
            <Input
              id="role-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Engineer"
            />
          </div>
          <div className="grid gap-1">
            <Label
              htmlFor="role-description"
              variant="muted"
              className="text-xs"
            >
              Description
            </Label>
            <Input
              id="role-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Deploys to development and runs the support agents"
            />
          </div>
          <div className="grid gap-1">
            <Label variant="muted" className="text-xs">
              Policies
            </Label>
            {policies.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No policies yet. Make one under Policies first.
              </p>
            ) : (
              <div className="grid gap-1.5">
                {policies.map((policy) => (
                  <label
                    key={policy._id}
                    className="flex cursor-pointer items-center justify-between gap-2 text-xs"
                  >
                    <span>
                      {policy.name}
                      <span className="text-muted-foreground">
                        {" "}
                        · {policy.scope}
                      </span>
                    </span>
                    <Switch
                      checked={policyIds.includes(policy._id)}
                      onCheckedChange={(checked) =>
                        setPolicyIds(
                          checked
                            ? [...policyIds, policy._id]
                            : policyIds.filter((id) => id !== policy._id),
                        )
                      }
                      aria-label={policy.name}
                    />
                  </label>
                ))}
              </div>
            )}
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
            disabled={pending || !name.trim()}
          >
            {pending ? "Saving…" : role ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function matchesField(role: Role, _field: Field, value: string): boolean {
  return role.kind === value;
}

function searchText(role: Role): string {
  return `${role.name} ${role.description}`;
}
