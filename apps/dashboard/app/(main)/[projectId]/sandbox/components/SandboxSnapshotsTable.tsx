"use client";

/**
 * Read-only. A snapshot is captured from an instance, or registered by the
 * image pipeline.
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
import { useNow } from "@/app/hooks/useNow";
import { parseQuery } from "@/app/lib/queryTokens";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useMemo, useState } from "react";
import { SandboxSnapshotSheet } from "./SandboxSnapshotSheet";
import { formatProvider, relativeTime, SNAPSHOT_TONE } from "./sandboxFormat";

// The `field:value` tokens the search box understands.
const SNAPSHOT_QUERY_FIELDS = ["provider", "status"] as const;

interface Props {
  snapshots: Array<Doc<"sandboxSnapshots">>;
}

export function SandboxSnapshotsTable({ snapshots }: Props): React.JSX.Element {
  const now = useNow();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Doc<"sandboxSnapshots"> | null>(
    null,
  );

  const query = useMemo(
    () => parseQuery(filter, SNAPSHOT_QUERY_FIELDS),
    [filter],
  );
  const shown = useMemo(
    () =>
      snapshots.filter((snapshot) => {
        const fieldsPass = query.fields.every(({ field, value }) =>
          field === "provider"
            ? formatProvider(snapshot.provider).toLowerCase().startsWith(value)
            : snapshot.status.startsWith(value),
        );
        if (!fieldsPass) return false;
        if (!query.text) return true;

        return `${snapshot.name} ${snapshot.externalImageId} ${snapshot.baseImage}`
          .toLowerCase()
          .includes(query.text);
      }),
    [snapshots, query],
  );

  if (snapshots.length === 0) {
    return (
      <EmptyState
        title="No snapshots yet."
        detail="Capture one from a running instance's detail panel, or publish a curated image."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar className="border-b-0 px-0">
        <SearchInput
          value={filter}
          onChange={setFilter}
          fields={SNAPSHOT_QUERY_FIELDS}
          placeholder="Search snapshots · provider: status:"
        />
        <ToolbarCount shown={shown.length} total={snapshots.length} />
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card">
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead>Name</DataTableHead>
              <DataTableHead>Status</DataTableHead>
              <DataTableHead>Provider</DataTableHead>
              <DataTableHead>Base image</DataTableHead>
              <DataTableHead align="right">Pulled</DataTableHead>
              <DataTableHead>Created</DataTableHead>
              <DataTableHead>Last used</DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {shown.map((snapshot) => (
              <DataTableRow
                key={snapshot._id}
                selected={selected?._id === snapshot._id}
                onClick={() => setSelected(snapshot)}
              >
                <DataTableCell className="max-w-64">
                  <div className="truncate font-medium text-foreground">
                    {snapshot.name}
                  </div>
                  <DataTableSub className="font-mono">
                    {snapshot.externalImageId}
                  </DataTableSub>
                </DataTableCell>
                <DataTableCell>
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone={SNAPSHOT_TONE[snapshot.status]} />
                    {snapshot.status.replace("_", " ")}
                  </span>
                </DataTableCell>
                <DataTableCell muted>
                  {formatProvider(snapshot.provider)}
                </DataTableCell>
                <DataTableCell muted>{snapshot.baseImage}</DataTableCell>
                <DataTableCell align="right" muted>
                  {snapshot.pulledCount}
                </DataTableCell>
                <DataTableCell muted>
                  {relativeTime(snapshot.createdAt, now)}
                </DataTableCell>
                <DataTableCell muted>
                  {relativeTime(snapshot.lastUsedAt, now)}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {shown.length === 0 && (
          <EmptyState title="No snapshots match the current filters." />
        )}
      </div>

      {selected && (
        <SandboxSnapshotSheet
          snapshot={selected}
          now={now}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
