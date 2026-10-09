"use client";

/**
 * Organization › Permissions: every name a rule may use. Built-in ones are
 * the action vocabulary and cannot change; custom ones name something only
 * this org knows, such as a tool an agent may call.
 *
 * Laid out like Monitoring: a toolbar, a flush table whose headers sort on
 * click, and a detail panel with the permission's facts and, for a custom
 * one, the danger zone.
 */

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/app/components/DataTable";
import { DangerZone } from "@/app/components/DangerZone";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { DetailRows, type DetailRow } from "@/app/components/DetailSections";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState } from "@/app/components/EmptyState";
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
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { actorName, PLATFORM, Who } from "@/app/components/Who";
import { useListState } from "@/app/hooks/useListState";
import { usePermissions } from "@/app/hooks/usePermissions";
import { useSubmit } from "@/app/hooks/useSubmit";
import { formatDate } from "@/app/lib/formatTime";
import type { SortKey } from "@/app/lib/tableState";
import { parseAsName } from "@/app/lib/urlState";
import { api } from "@broods/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { useQueryState } from "nuqs";
import { useState } from "react";

type Permission = FunctionReturnType<typeof api.access.listPermissions>[number];
type Column = "name" | "description" | "resource" | "kind" | "createdAt";
type Field = (typeof QUERY_FIELDS)[number];

// The `field:value` tokens the search box understands.
const QUERY_FIELDS = ["resource", "kind"] as const;

// Six columns of short text; below this the detail panel would wrap them.
const TABLE_MIN_WIDTH = 640;

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
  const [selectedName, setSelectedName] = useQueryState("sel", parseAsName);
  const [creating, setCreating] = useState(false);
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
  const selected = permissions?.find((row) => row.name === selectedName);

  useShortcut("table.create", () => canChange && setCreating(true));

  if (permissions === undefined) {
    return <p className="px-6 pt-6 text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <SearchInput
          value={list.query}
          onChange={list.setQuery}
          fields={QUERY_FIELDS}
          placeholder="Search permissions · resource: kind:"
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
      <DetailSplit
        flush
        tableMinWidth={TABLE_MIN_WIDTH}
        detail={
          selected && (
            <PermissionPanel
              key={selected.name}
              permission={selected}
              canChange={canChange}
              onClose={() => setSelectedName(null)}
            />
          )
        }
      >
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={list.sortFor("name")}>
                Permission
              </DataTableHead>
              <DataTableHead sort={list.sortFor("description")}>
                Description
              </DataTableHead>
              <DataTableHead sort={list.sortFor("resource")}>
                Resource
              </DataTableHead>
              <DataTableHead sort={list.sortFor("kind")}>Kind</DataTableHead>
              <DataTableHead sort={list.sortFor("createdAt")}>
                Created
              </DataTableHead>
              <DataTableHead>Created by</DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map((row) => (
              <DataTableRow
                key={row.name}
                selected={selectedName === row.name}
                onClick={() =>
                  setSelectedName(selectedName === row.name ? null : row.name)
                }
              >
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
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {list.shown.length === 0 && (
          <EmptyState title="No permissions match the current filters." />
        )}
      </DetailSplit>
      {creating && <NewPermissionDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/**
 * The selected permission: its facts, and for a custom one the danger zone.
 * A built-in one is the vocabulary itself and has nothing to change.
 */
function PermissionPanel({
  permission,
  canChange,
  onClose,
}: {
  permission: Permission;
  canChange: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const remove = useMutation(api.access.removePermission);
  const [deleting, setDeleting] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const custom = permission.kind === "custom" ? permission : null;
  const facts: DetailRow[] = [
    { key: "name", label: "Name", value: permission.name },
    {
      key: "description",
      label: "Description",
      value: permission.description || "—",
      words: true,
    },
    {
      key: "resource",
      label: "Resource",
      value: permission.resource,
      words: true,
    },
    { key: "kind", label: "Kind", value: permission.kind, words: true },
  ];
  if (custom) {
    facts.push({
      key: "created",
      label: "Created",
      value: formatDate(custom.createdAt),
      words: true,
    });
  }
  facts.push({
    key: "creator",
    label: "Created by",
    value: actorName(custom?.createdBy ?? PLATFORM),
    words: true,
  });

  async function confirmDelete(): Promise<void> {
    if (!custom) return;
    setDeletePending(true);
    try {
      await remove({ permissionId: custom._id });
      onClose();
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <DetailPanel title={permission.name} onClose={onClose}>
      <DetailRows rows={facts} />
      {custom === null && (
        <p className="mt-2 text-xs text-muted-foreground">
          A built-in permission is part of the action vocabulary and cannot
          change.
        </p>
      )}

      {canChange && custom && (
        <DangerZone description="Delete the permission. A policy whose rule names it has to drop that rule first.">
          <Button
            variant="destructive"
            size="sm"
            className="cursor-pointer"
            onClick={() => setDeleting(true)}
          >
            Delete
          </Button>
        </DangerZone>
      )}

      {deleting && custom && (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(false)}
          resourceName={custom.name}
          resourceType="permission"
          critical={false}
          onConfirm={confirmDelete}
          isDeleting={deletePending}
        />
      )}
    </DetailPanel>
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

function matchesField(row: Permission, field: Field, value: string): boolean {
  return field === "resource"
    ? row.resource.toLowerCase() === value
    : row.kind === value;
}

function searchText(row: Permission): string {
  return `${row.name} ${row.description}`;
}
