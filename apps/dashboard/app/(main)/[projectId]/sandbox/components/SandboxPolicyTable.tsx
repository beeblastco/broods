"use client";

/**
 * Read-only. broods mirrors each sandbox config's tool-approval and egress mode
 * onto its instance rows; edit them on the config, from the canvas or the CLI.
 */

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DataTableSub,
} from "@/app/components/DataTable";
import { EmptyState } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusDot } from "@/app/components/StatusDot";
import { Toolbar, ToolbarCount } from "@/app/components/Toolbar";
import { parseQuery } from "@/app/lib/queryTokens";
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

interface Props {
  instances: Array<Doc<"sandboxInstances">>;
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
  const query = useMemo(
    () => parseQuery(filter, POLICY_QUERY_FIELDS),
    [filter],
  );
  const shown = useMemo(
    () =>
      instances.filter((instance) => {
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
      }),
    [instances, query],
  );

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
          placeholder="Search instances · provider: status:"
        />
        <ToolbarCount shown={shown.length} total={instances.length} />
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card">
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead>Name</DataTableHead>
              <DataTableHead>Status</DataTableHead>
              <DataTableHead>Provider</DataTableHead>
              <DataTableHead>{copy.column}</DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {shown.map((instance) => (
              <DataTableRow key={instance._id}>
                <DataTableCell className="max-w-64">
                  <div className="truncate font-medium text-foreground">
                    {instance.name}
                  </div>
                  <DataTableSub className="font-mono">
                    {instance.externalId}
                  </DataTableSub>
                </DataTableCell>
                <DataTableCell>
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone={INSTANCE_TONE[instance.status]} />
                    {instance.status}
                  </span>
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
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{copy.note}</p>
    </div>
  );
}
