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
  TIME_WORDS,
} from "@/app/components/DataTable";
import { EmptyState } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusWord } from "@/app/components/StatusDot";
import { Toolbar } from "@/app/components/Toolbar";
import { useListState } from "@/app/hooks/useListState";
import { useNow } from "@/app/hooks/useNow";
import type { SortKey } from "@/app/lib/tableState";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useState } from "react";
import { SandboxSnapshotSheet } from "./SandboxSnapshotSheet";
import { formatProvider, relativeTime, SNAPSHOT_TONE } from "./sandboxFormat";

// The `field:value` tokens the search box understands.
const QUERY_FIELDS = ["provider", "status"] as const;

type Snapshot = Doc<"sandboxSnapshots">;
type Field = (typeof QUERY_FIELDS)[number];
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
  projectId: Id<"projects">;
  snapshots: Snapshot[];
}

export function SandboxSnapshotsTable({
  projectId,
  snapshots,
}: Props): React.JSX.Element {
  const now = useNow();
  const [selected, setSelected] = useState<Snapshot | null>(null);
  const list = useListState({
    rows: snapshots,
    fields: QUERY_FIELDS,
    initialSort: { column: "created", dir: "desc" },
    sortKey: SORT_KEY,
    matches: matchesField,
    text: searchText,
    remember: `snapshots:${projectId}`,
  });

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
          value={list.query}
          onChange={list.setQuery}
          fields={QUERY_FIELDS}
          placeholder="Search snapshots"
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
              <DataTableHead sort={list.sortFor("baseImage")}>
                Base image
              </DataTableHead>
              <DataTableHead align="right" sort={list.sortFor("pulled")}>
                Pulled
              </DataTableHead>
              <DataTableHead sort={list.sortFor("created", TIME_WORDS)}>
                Created
              </DataTableHead>
              <DataTableHead sort={list.sortFor("lastUsed", TIME_WORDS)}>
                Last used
              </DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map((snapshot) => (
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
        {list.shown.length === 0 && (
          <EmptyState title="No snapshots match the current filters." />
        )}
        <DataTableFooter
          shown={list.shown.length}
          total={snapshots.length}
          noun="snapshots"
        />
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

function matchesField(
  snapshot: Snapshot,
  field: Field,
  value: string,
): boolean {
  return field === "provider"
    ? formatProvider(snapshot.provider).toLowerCase().startsWith(value)
    : snapshot.status.startsWith(value);
}

function searchText(snapshot: Snapshot): string {
  return `${snapshot.name} ${snapshot.externalImageId} ${snapshot.baseImage}`;
}
