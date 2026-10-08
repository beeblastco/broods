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
  type HeadSort,
} from "@/app/components/DataTable";
import { EmptyState } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusWord } from "@/app/components/StatusDot";
import { Toolbar } from "@/app/components/Toolbar";
import { parseQuery } from "@/app/lib/queryTokens";
import { sortRows, type SortKey, type SortState } from "@/app/lib/tableState";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useMemo, useState } from "react";
import {
  egressBadge,
  formatProvider,
  INSTANCE_TONE,
  permissionModeBadge,
} from "./sandboxFormat";

// The `field:value` tokens the search box understands.
const POLICY_QUERY_FIELDS = ["provider", "status"] as const;

type Instance = Doc<"sandboxInstances">;
type Column = "name" | "status" | "provider" | "policy";

interface Props {
  instances: Instance[];
  dimension: "security" | "networking";
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

export function SandboxPolicyTable({
  instances,
  dimension,
}: Props): React.JSX.Element {
  const copy = COPY[dimension];
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortState<Column>>({
    column: "name",
    dir: "asc",
  });
  const sortFor = (column: Column): HeadSort => ({
    dir: sort.column === column ? sort.dir : null,
    onSort: (dir) => setSort({ column: column, dir: dir }),
  });
  const query = useMemo(
    () => parseQuery(filter, POLICY_QUERY_FIELDS),
    [filter],
  );
  const shown = useMemo(() => {
    const matching = instances.filter((instance) => {
      const fieldsPass = query.fields.every(({ field, value }) =>
        field === "provider"
          ? formatProvider(instance.provider).toLowerCase().startsWith(value)
          : instance.status.startsWith(value),
      );
      if (!fieldsPass) return false;
      if (!query.text) return true;

      return `${instance.name} ${instance.externalId}`
        .toLowerCase()
        .includes(query.text);
    });

    return sortRows(
      matching,
      (instance) => sortKey(sort.column, instance, dimension),
      sort.dir,
    );
  }, [instances, query, sort, dimension]);

  if (instances.length === 0) {
    return (
      <EmptyState title="No running sandbox instances." detail={copy.note} />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar className="border-b-0 px-0">
        <SearchInput
          value={filter}
          onChange={setFilter}
          fields={POLICY_QUERY_FIELDS}
          placeholder="Search instances"
        />
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card">
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={sortFor("name")}>Name</DataTableHead>
              <DataTableHead sort={sortFor("status")}>Status</DataTableHead>
              <DataTableHead sort={sortFor("provider")}>Provider</DataTableHead>
              <DataTableHead sort={sortFor("policy")}>
                {copy.column}
              </DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {shown.map((instance) => (
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
        {shown.length === 0 && (
          <EmptyState title="No instances match the current filters." />
        )}
        <DataTableFooter>
          {shown.length === instances.length
            ? `${instances.length} instances`
            : `${shown.length} of ${instances.length} instances`}
        </DataTableFooter>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{copy.note}</p>
    </div>
  );
}

/** What a column sorts an instance by; the policy column reads the dimension's field. */
function sortKey(
  column: Column,
  instance: Instance,
  dimension: Props["dimension"],
): SortKey {
  switch (column) {
    case "name":
      return instance.name;
    case "status":
      return instance.status;
    case "provider":
      return formatProvider(instance.provider);
    case "policy":
      return dimension === "security"
        ? (instance.permissionMode ?? null)
        : (instance.egress ?? null);
  }
}
