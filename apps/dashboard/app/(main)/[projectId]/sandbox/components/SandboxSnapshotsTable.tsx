"use client";

/**
 * Read-only. A snapshot is captured from an instance, or registered by the
 * image pipeline.
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
import { useNow } from "@/app/hooks/useNow";
import { useRemembered } from "@/app/hooks/useRemembered";
import { parseQuery } from "@/app/lib/queryTokens";
import { sortRows, type SortKey, type SortState } from "@/app/lib/tableState";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useMemo, useState } from "react";
import { SandboxSnapshotSheet } from "./SandboxSnapshotSheet";
import { formatProvider, relativeTime, SNAPSHOT_TONE } from "./sandboxFormat";

// The `field:value` tokens the search box understands.
const SNAPSHOT_QUERY_FIELDS = ["provider", "status"] as const;

type Snapshot = Doc<"sandboxSnapshots">;
type Column =
  | "name"
  | "status"
  | "provider"
  | "baseImage"
  | "pulled"
  | "created"
  | "lastUsed";

// What a column sorts a snapshot by.
const SORT_KEY: Record<Column, (snapshot: Snapshot) => SortKey> = {
  name: (snapshot) => snapshot.name,
  status: (snapshot) => snapshot.status,
  provider: (snapshot) => formatProvider(snapshot.provider),
  baseImage: (snapshot) => snapshot.baseImage,
  pulled: (snapshot) => snapshot.pulledCount,
  created: (snapshot) => snapshot.createdAt,
  lastUsed: (snapshot) => snapshot.lastUsedAt ?? null,
};

interface Props {
  snapshots: Snapshot[];
}

export function SandboxSnapshotsTable({ snapshots }: Props): React.JSX.Element {
  const now = useNow();
  const [filter, setFilter] = useRemembered("snapshots.filter", "");
  const [sort, setSort] = useRemembered<SortState<Column>>("snapshots.sort", {
    column: "created",
    dir: "desc",
  });
  const [selected, setSelected] = useState<Snapshot | null>(null);
  const sortFor = (column: Column): HeadSort => ({
    dir: sort.column === column ? sort.dir : null,
    onSort: (dir) => setSort({ column: column, dir: dir }),
  });

  const query = useMemo(
    () => parseQuery(filter, SNAPSHOT_QUERY_FIELDS),
    [filter],
  );
  const shown = useMemo(() => {
    const matching = snapshots.filter((snapshot) => {
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
    });

    return sortRows(matching, SORT_KEY[sort.column], sort.dir);
  }, [snapshots, query, sort]);

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
          placeholder="Search snapshots"
        />
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card">
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={sortFor("name")}>Name</DataTableHead>
              <DataTableHead sort={sortFor("status")}>Status</DataTableHead>
              <DataTableHead sort={sortFor("provider")}>Provider</DataTableHead>
              <DataTableHead sort={sortFor("baseImage")}>
                Base image
              </DataTableHead>
              <DataTableHead align="right" sort={sortFor("pulled")}>
                Pulled
              </DataTableHead>
              <DataTableHead sort={sortFor("created")}>Created</DataTableHead>
              <DataTableHead sort={sortFor("lastUsed")}>
                Last used
              </DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {shown.map((snapshot) => (
              <DataTableRow
                key={snapshot._id}
                selected={selected?._id === snapshot._id}
                onClick={() => setSelected(snapshot)}
              >
                <DataTableCell className="max-w-64 truncate font-medium">
                  {snapshot.name}
                </DataTableCell>
                <DataTableCell>
                  <StatusWord tone={SNAPSHOT_TONE[snapshot.status]}>
                    {snapshot.status.replace("_", " ")}
                  </StatusWord>
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
        <DataTableFooter>
          {shown.length === snapshots.length
            ? `${snapshots.length} snapshots`
            : `${shown.length} of ${snapshots.length} snapshots`}
        </DataTableFooter>
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
