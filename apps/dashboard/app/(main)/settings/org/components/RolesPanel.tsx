"use client";

/**
 * Organization › Roles: a role is a name for a set of policies, and members
 * get one role each. Built-in roles are the three tiers; custom roles sit on
 * the member tier and add what their policies allow.
 */

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
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState } from "@/app/components/EmptyState";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Switch } from "@/app/components/ui/switch";
import { PLATFORM, Who, WhoGroup } from "@/app/components/Who";
import { useListState } from "@/app/hooks/useListState";
import { usePermissions } from "@/app/hooks/usePermissions";
import { useSubmit } from "@/app/hooks/useSubmit";
import { formatDate } from "@/app/lib/formatTime";
import type { SortKey } from "@/app/lib/tableState";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  DASHBOARD_DESCRIPTIONS,
  DASHBOARD_POLICY_ACTIONS,
} from "@broods/convex/model/policyRules";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { useState } from "react";

type Role = FunctionReturnType<typeof api.access.listRoles>[number];
type CustomRole = Extract<Role, { kind: "custom" }>;
type Policy = FunctionReturnType<typeof api.access.listPolicies>[number];
type Column = "name" | "description" | "policies" | "members" | "createdAt";
type Field = (typeof QUERY_FIELDS)[number];

const QUERY_FIELDS = ["kind"] as const;

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
  const [selectedName, setSelectedName] = useState<string | null>(null);
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

  if (roles === undefined || policies === undefined) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar className="border-b-0 px-0">
        <SearchInput
          value={list.query}
          onChange={list.setQuery}
          fields={QUERY_FIELDS}
          placeholder="Search roles"
        />
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
        tableMinWidth={TABLE_MIN_WIDTH}
        detail={
          selected && (
            <RoleDetail
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
                Created at
              </DataTableHead>
              <DataTableHead>Created by</DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map((role) => (
              <DataTableRow
                key={role.name}
                selected={selectedName === role.name}
                onClick={() => setSelectedName(role.name)}
              >
                <DataTableCell className="font-medium">
                  {role.name}
                </DataTableCell>
                <DataTableCell muted className="max-w-72 truncate">
                  {role.description}
                </DataTableCell>
                <DataTableCell>
                  {role.kind === "built-in" ? (
                    <span className="text-muted-foreground">all</span>
                  ) : (
                    role.policyIds.length
                  )}
                </DataTableCell>
                <DataTableCell>
                  {role.members.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
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
        <DataTableFooter
          shown={list.shown.length}
          total={roles.length}
          noun="roles"
        />
      </DetailSplit>
      {creating && (
        <RoleDialog policies={policies} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

/** The selected role: its facts, its policies with attach and detach, and the pages it opens. */
function RoleDetail({
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
  const [deleting, setDeleting] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const { error, run } = useSubmit();
  const attached = policies.filter((policy) =>
    role.policyIds.includes(policy._id),
  );
  const attachable = policies.filter(
    (policy) => !role.policyIds.includes(policy._id),
  );
  const custom = role.kind === "custom" ? role : null;
  const editable = canChange && custom !== null;

  function setPolicies(policyIds: Id<"agentPolicies">[]): void {
    if (custom)
      void run(() => update({ roleId: custom._id, policyIds: policyIds }));
  }

  async function confirmDelete(): Promise<void> {
    if (!custom) return;
    setDeletePending(true);
    try {
      await remove({ roleId: custom._id });
      onClose();
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <DetailPanel
      title={role.name}
      meta={
        editable && (
          <div className="mt-1 flex gap-1">
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              tone="muted-destructive"
              className="cursor-pointer"
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          </div>
        )
      }
      onClose={onClose}
    >
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Name</dt>
        <dd>{role.name}</dd>
        <dt className="text-muted-foreground">Description</dt>
        <dd className="truncate">{role.description}</dd>
        <dt className="text-muted-foreground">Members</dt>
        <dd>
          {role.members.length === 0 ? (
            <span className="text-muted-foreground">none</span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <WhoGroup actors={role.members} />
              <span className="text-muted-foreground">
                {role.members.map((member) => member.name).join(", ")}
              </span>
            </span>
          )}
        </dd>
        {custom && (
          <>
            <dt className="text-muted-foreground">Created at</dt>
            <dd>{formatDate(custom.createdAt)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Created by</dt>
        <dd>
          <Who actor={custom?.createdBy ?? PLATFORM} />
        </dd>
      </dl>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <div className="mt-4 flex items-center justify-between">
        <h4 className="text-xs font-semibold">Policies</h4>
        {editable && attachable.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                />
              }
            >
              Attach policy
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {attachable.map((policy) => (
                <DropdownMenuItem
                  key={policy._id}
                  onClick={() => setPolicies([...role.policyIds, policy._id])}
                >
                  {policy.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {role.kind === "built-in" ? (
        <p className="mt-1 text-xs text-muted-foreground">
          A built-in role holds every permission of its tier.
        </p>
      ) : attached.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">No policies yet.</p>
      ) : (
        <DataTable className="mt-1">
          <DataTableHeader className="static">
            <tr>
              <DataTableHead>Policy</DataTableHead>
              <DataTableHead>Permissions</DataTableHead>
              <DataTableHead>Scope</DataTableHead>
              <DataTableHead align="right" />
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {attached.map((policy) => (
              <DataTableRow key={policy._id}>
                <DataTableCell>{policy.name}</DataTableCell>
                <DataTableCell muted>{policy.permissions.length}</DataTableCell>
                <DataTableCell muted>{policy.scope}</DataTableCell>
                <DataTableCell align="right">
                  {editable && (
                    <Button
                      variant="ghost"
                      size="sm"
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

      <h4 className="mt-4 text-xs font-semibold">Pages</h4>
      <DataTable className="mt-1">
        <DataTableHeader className="static">
          <tr>
            <DataTableHead>Page</DataTableHead>
            <DataTableHead>Allowed</DataTableHead>
          </tr>
        </DataTableHeader>
        <DataTableBody>
          {DASHBOARD_POLICY_ACTIONS.map((action) => {
            const allowed = role.permissions.includes(action);

            return (
              <DataTableRow key={action}>
                <DataTableCell>{DASHBOARD_DESCRIPTIONS[action]}</DataTableCell>
                <DataTableCell muted={!allowed}>
                  {allowed ? "yes" : "no"}
                </DataTableCell>
              </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTable>

      {editing && custom && (
        <RoleDialog
          role={custom}
          policies={policies}
          onClose={() => setEditing(false)}
        />
      )}
      {deleting && (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(false)}
          resourceName={role.name}
          resourceType="role"
          critical={false}
          onConfirm={confirmDelete}
          isDeleting={deletePending}
        />
      )}
    </DetailPanel>
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
