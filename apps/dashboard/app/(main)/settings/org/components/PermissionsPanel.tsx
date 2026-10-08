"use client";

/**
 * Organization › Permissions: every name a rule may use. Built-in ones are
 * the action vocabulary and cannot change; custom ones name something only
 * this org knows, such as a tool an agent may call.
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
import { EmptyState } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
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
import { usePermissions } from "@/app/hooks/usePermissions";
import { useSubmit } from "@/app/hooks/useSubmit";
import { formatDate } from "@/app/lib/formatTime";
import type { SortKey } from "@/app/lib/tableState";
import { api } from "@broods/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { useState } from "react";

type Permission = FunctionReturnType<typeof api.access.listPermissions>[number];
type Custom = Extract<Permission, { kind: "custom" }>;
type Column = "name" | "description" | "resource" | "kind" | "createdAt";
type Field = (typeof QUERY_FIELDS)[number];

const QUERY_FIELDS = ["resource", "kind"] as const;

const RESOURCES = ["tool", "agent", "stage", "key", "custom"] as const;

const NO_ROWS: Permission[] = [];

const SORT_KEY: Record<Column, (row: Permission) => SortKey> = {
  name: (row) => row.name,
  description: (row) => row.description,
  resource: (row) => row.resource,
  kind: (row) => row.kind,
  createdAt: (row) => (row.kind === "custom" ? row.createdAt : null),
};

export function PermissionsPanel(): React.JSX.Element {
  const { can } = usePermissions();
  const canChange = can("access:write");
  const permissions = useQuery(api.access.listPermissions, {});
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Custom | null>(null);
  const list = useListState({
    rows: permissions ?? NO_ROWS,
    fields: QUERY_FIELDS,
    initialSort: { column: "name", dir: "asc" },
    sortKey: SORT_KEY,
    matches: matchesField,
    text: searchText,
  });
  const filters = {
    resource: list.filterFor("resource", [
      ...new Set((permissions ?? []).map((row) => row.resource)),
    ]),
    kind: list.filterFor("kind", ["built-in", "custom"]),
  };

  if (permissions === undefined) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  const customCount = permissions.filter((row) => row.kind === "custom").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar className="border-b-0 px-0">
        <SearchInput
          value={list.query}
          onChange={list.setQuery}
          fields={QUERY_FIELDS}
          placeholder="Search permissions"
        />
        <FilterButton
          columns={[
            { label: "Resource", filter: filters.resource },
            { label: "Kind", filter: filters.kind },
          ]}
        />
        {canChange && (
          <Button
            size="sm"
            className="cursor-pointer"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-4" />
            New permission
          </Button>
        )}
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card">
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={list.sortFor("name")}>
                Permission
              </DataTableHead>
              <DataTableHead sort={list.sortFor("description")}>
                Description
              </DataTableHead>
              <DataTableHead
                sort={list.sortFor("resource")}
                filter={filters.resource}
              >
                Resource
              </DataTableHead>
              <DataTableHead sort={list.sortFor("kind")} filter={filters.kind}>
                Kind
              </DataTableHead>
              <DataTableHead sort={list.sortFor("createdAt")}>
                Created at
              </DataTableHead>
              <DataTableHead>Created by</DataTableHead>
              <DataTableHead align="right" />
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map((row) => (
              <DataTableRow key={row.name}>
                <DataTableCell className="font-mono">{row.name}</DataTableCell>
                <DataTableCell muted className="max-w-72 truncate">
                  {row.description}
                </DataTableCell>
                <DataTableCell>{row.resource}</DataTableCell>
                <DataTableCell muted>{row.kind}</DataTableCell>
                <DataTableCell muted>
                  {row.kind === "custom" ? formatDate(row.createdAt) : "—"}
                </DataTableCell>
                <DataTableCell>
                  <Who
                    actor={(row.kind === "custom" && row.createdBy) || PLATFORM}
                  />
                </DataTableCell>
                <DataTableCell align="right">
                  {canChange && row.kind === "custom" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      tone="muted-destructive"
                      className="cursor-pointer"
                      onClick={() => setRemoving(row)}
                    >
                      Delete
                    </Button>
                  )}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {list.shown.length === 0 && (
          <EmptyState title="No permissions match the current filters." />
        )}
        <DataTableFooter
          shown={list.shown.length}
          total={permissions.length}
          noun="permissions"
        >
          {`, ${customCount} custom`}
        </DataTableFooter>
      </div>
      {creating && <NewPermissionDialog onClose={() => setCreating(false)} />}
      {removing && (
        <RemovePermissionDialog
          permission={removing}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

function NewPermissionDialog({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const create = useMutation(api.access.createPermission);
  const [name, setName] = useState("");
  const [resource, setResource] = useState<string>("tool");
  const [description, setDescription] = useState("");
  const { pending, error, run } = useSubmit();

  async function submit(): Promise<void> {
    const done = await run(() =>
      create({
        name: name.trim(),
        resource: resource,
        description: description.trim() || undefined,
      }),
    );
    if (done) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New permission</DialogTitle>
          <DialogDescription>
            A permission names one thing an agent or member may do.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1">
            <Label htmlFor="perm-name" variant="muted" className="text-xs">
              Name
            </Label>
            <Input
              id="perm-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="tool.stripe.refund"
              className="font-mono text-xs"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="perm-resource" variant="muted" className="text-xs">
              Resource
            </Label>
            <Select
              items={RESOURCES.map((value) => ({ value: value, label: value }))}
              value={resource}
              onValueChange={(value) => value !== null && setResource(value)}
            >
              <SelectTrigger
                id="perm-resource"
                className="w-full cursor-pointer"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESOURCES.map((value) => (
                  <SelectItem
                    key={value}
                    value={value}
                    className="cursor-pointer"
                  >
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label
              htmlFor="perm-description"
              variant="muted"
              className="text-xs"
            >
              Description
            </Label>
            <Input
              id="perm-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Let an agent call the refund tool"
            />
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
            {pending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The typed-confirm delete; the mutation's rejection shows under its input. */
function RemovePermissionDialog({
  permission,
  onClose,
}: {
  permission: Custom;
  onClose: () => void;
}): React.JSX.Element {
  const remove = useMutation(api.access.removePermission);
  const [pending, setPending] = useState(false);

  async function confirm(): Promise<void> {
    setPending(true);
    try {
      await remove({ permissionId: permission._id });
      onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <DeleteConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      resourceName={permission.name}
      resourceType="permission"
      critical={false}
      onConfirm={confirm}
      isDeleting={pending}
    />
  );
}

function matchesField(row: Permission, field: Field, value: string): boolean {
  return field === "resource"
    ? row.resource.toLowerCase() === value
    : row.kind === value;
}

function searchText(row: Permission): string {
  return `${row.name} ${row.description}`;
}
