"use client";

/**
 * Read-only. broods mirrors each sandbox config's tool-approval and egress mode
 * onto its instance rows; edit them on the config, from the canvas or the CLI.
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
import { EmptyState } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusWord } from "@/app/components/StatusDot";
import { Toolbar } from "@/app/components/Toolbar";
import { useListState } from "@/app/hooks/useListState";
import type { SortKey } from "@/app/lib/tableState";
import type { Doc } from "@broods/convex/_generated/dataModel";
import {
  egressBadge,
  formatProvider,
  INSTANCE_TONE,
  permissionModeBadge,
} from "./sandboxFormat";

// The `field:value` tokens the search box understands.
const QUERY_FIELDS = ["provider", "status"] as const;

type Instance = Doc<"sandboxInstances">;
type Field = (typeof QUERY_FIELDS)[number];
type Column = "name" | "status" | "provider" | "policy";
type Dimension = "security" | "networking";

interface Props {
  instances: Instance[];
  dimension: Dimension;
}

const COPY = {
  security: {
    column: "Permission mode",
    note: "Tool-approval policy enforced per sandbox (edit applies, ask prompts, bypass skips checks). Set it on the sandbox config.",
  },
  networking: {
    column: "Egress",
    note: "Outbound network policy per sandbox (deny-all blocks egress, restricted allowlists, allow-all opens the internet). Set it on the sandbox config.",
  },
} as const;

// What a column sorts an instance by; the policy column reads the dimension's field.
const SORT_KEY: Record<
  Dimension,
  Record<Column, (instance: Instance) => SortKey>
> = {
  security: {
    name: (instance) => instance.name,
    status: (instance) => instance.status,
    provider: (instance) => formatProvider(instance.provider),
    policy: (instance) => instance.permissionMode ?? null,
  },
  networking: {
    name: (instance) => instance.name,
    status: (instance) => instance.status,
    provider: (instance) => formatProvider(instance.provider),
    policy: (instance) => instance.egress ?? null,
  },
};

export function SandboxPolicyTable({
  instances,
  dimension,
}: Props): React.JSX.Element {
  const copy = COPY[dimension];
  const list = useListState({
    rows: instances,
    fields: QUERY_FIELDS,
    initialSort: { column: "name", dir: "asc" },
    sortKey: SORT_KEY[dimension],
    matches: matchesField,
    text: searchText,
  });

  if (instances.length === 0) {
    return (
      <EmptyState title="No running sandbox instances." detail={copy.note} />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar className="border-b-0 px-0">
        <SearchInput
          value={list.query}
          onChange={list.setQuery}
          fields={QUERY_FIELDS}
          placeholder="Search instances"
        />
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card">
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={list.sortFor("name")}>Name</DataTableHead>
              <DataTableHead sort={list.sortFor("status")}>
                Status
              </DataTableHead>
              <DataTableHead sort={list.sortFor("provider")}>
                Provider
              </DataTableHead>
              <DataTableHead sort={list.sortFor("policy")}>
                {copy.column}
              </DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map((instance) => (
              <DataTableRow key={instance._id}>
                <DataTableCell className="max-w-64 truncate font-medium">
                  {instance.name}
                </DataTableCell>
                <DataTableCell>
                  <StatusWord tone={INSTANCE_TONE[instance.status]}>
                    {instance.status}
                  </StatusWord>
                </DataTableCell>
                <DataTableCell muted>
                  {formatProvider(instance.provider)}
                </DataTableCell>
                <DataTableCell>
                  {dimension === "security"
                    ? permissionModeBadge(instance.permissionMode)
                    : egressBadge(instance.egress)}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {list.shown.length === 0 && (
          <EmptyState title="No instances match the current filters." />
        )}
        <DataTableFooter
          shown={list.shown.length}
          total={instances.length}
          noun={["instance", "instances"]}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{copy.note}</p>
    </div>
  );
}

function matchesField(
  instance: Instance,
  field: Field,
  value: string,
): boolean {
  return field === "provider"
    ? formatProvider(instance.provider).toLowerCase().startsWith(value)
    : instance.status.startsWith(value);
}

function searchText(instance: Instance): string {
  return `${instance.name} ${instance.externalId}`;
}
