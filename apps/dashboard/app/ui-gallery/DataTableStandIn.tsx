"use client";

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableFooter,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/app/components/DataTable";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusWord } from "@/app/components/StatusDot";
import { FilterButton, Toolbar } from "@/app/components/Toolbar";
import { Who } from "@/app/components/Who";
import { useListState } from "@/app/hooks/useListState";
import type { SortKey } from "@/app/lib/tableState";

const FIELDS = ["agent", "status"] as const;

type Column = "name" | "agent" | "status" | "at";
type Field = (typeof FIELDS)[number];
type Row = (typeof ROWS)[number];

const ROWS = [
  { name: "Daily summary", agent: "support-bot", status: "ok", at: 3 },
  { name: "Invoice sweep", agent: "billing", status: "failed", at: 1 },
  { name: "Weekly digest", agent: "support-bot", status: "ok", at: 2 },
  { name: "Health probe", agent: "ops", status: "running", at: 4 },
] as const;

const SORT_KEY: Record<Column, (row: Row) => SortKey> = {
  name: (row) => row.name,
  agent: (row) => row.agent,
  status: (row) => row.status,
  at: (row) => row.at,
};

/**
 * A list on the kit with every header sortable and two of them filterable,
 * so a spec can open the header menu, pick a value and see the chip land in
 * the search box, and the Filter button reach the same menu.
 */
export function DataTableStandIn(): React.JSX.Element {
  const list = useListState({
    rows: ROWS,
    fields: FIELDS,
    initialSort: { column: "name", dir: "asc" },
    sortKey: SORT_KEY,
    matches: matchesField,
    text: searchText,
  });
  const filters = {
    agent: list.filterFor("agent", [...new Set(ROWS.map((row) => row.agent))]),
    status: list.filterFor("status", [
      ...new Set(ROWS.map((row) => row.status)),
    ]),
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      <Toolbar>
        <SearchInput
          value={list.query}
          onChange={list.setQuery}
          fields={FIELDS}
          placeholder="Search jobs"
        />
        <FilterButton
          columns={[
            { label: "Agent", filter: filters.agent },
            { label: "Status", filter: filters.status },
          ]}
        />
      </Toolbar>
      <DataTable>
        <DataTableHeader>
          <tr>
            <DataTableHead sort={list.sortFor("name")}>Name</DataTableHead>
            <DataTableHead sort={list.sortFor("agent")} filter={filters.agent}>
              Agent
            </DataTableHead>
            <DataTableHead
              sort={list.sortFor("status")}
              filter={filters.status}
            >
              Status
            </DataTableHead>
            <DataTableHead
              sort={list.sortFor("at", ["Oldest first", "Newest first"])}
            >
              Last run
            </DataTableHead>
          </tr>
        </DataTableHeader>
        <DataTableBody>
          {list.shown.map((row) => (
            <DataTableRow key={row.name}>
              <DataTableCell className="font-medium">{row.name}</DataTableCell>
              <DataTableCell>
                <Who
                  actor={{
                    kind: "agent",
                    name: row.agent,
                    agentId: row.agent as never,
                  }}
                />
              </DataTableCell>
              <DataTableCell>
                <StatusWord
                  tone={
                    row.status === "failed"
                      ? "error"
                      : row.status === "ok"
                        ? "ok"
                        : "running"
                  }
                >
                  {row.status}
                </StatusWord>
              </DataTableCell>
              <DataTableCell muted>{row.at}d ago</DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
      <DataTableFooter
        shown={list.shown.length}
        total={ROWS.length}
        noun="jobs"
      >
        <span data-table-query>{list.query}</span>
      </DataTableFooter>
    </div>
  );
}

function matchesField(row: Row, field: Field, value: string): boolean {
  return row[field] === value;
}

function searchText(row: Row): string {
  return row.name;
}
