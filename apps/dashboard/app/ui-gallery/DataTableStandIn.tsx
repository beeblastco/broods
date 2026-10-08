"use client";

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableFooter,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  type HeadFilter,
} from "@/app/components/DataTable";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusWord } from "@/app/components/StatusDot";
import { FilterButton, Toolbar } from "@/app/components/Toolbar";
import { Who } from "@/app/components/Who";
import { parseQuery } from "@/app/lib/queryTokens";
import {
  clearField,
  sortRows,
  toggleToken,
  tokenValues,
  type SortState,
} from "@/app/lib/tableState";
import { useMemo, useState } from "react";

const FIELDS = ["agent", "status"] as const;

type Column = "name" | "agent" | "status" | "at";

const ROWS = [
  { name: "Daily summary", agent: "support-bot", status: "ok", at: 3 },
  { name: "Invoice sweep", agent: "billing", status: "failed", at: 1 },
  { name: "Weekly digest", agent: "support-bot", status: "ok", at: 2 },
  { name: "Health probe", agent: "ops", status: "running", at: 4 },
] as const;

/**
 * A list on the kit with every header sortable and two of them filterable,
 * so a spec can open the header menu, pick a value and see the chip land in
 * the search box, and the Filter button reach the same menu.
 */
export function DataTableStandIn(): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState<Column>>({
    column: "name",
    dir: "asc",
  });
  const parsed = useMemo(() => parseQuery(query, FIELDS), [query]);

  const filterFor = (field: (typeof FIELDS)[number]): HeadFilter => ({
    field: field,
    values: [...new Set(ROWS.map((row) => row[field]))].map((value) => ({
      value: value,
      label: value,
    })),
    active: tokenValues(query, field),
    onToggle: (value) => setQuery(toggleToken(query, field, value)),
    onClear: () => setQuery(clearField(query, field)),
  });
  const sortFor = (
    column: Column,
  ): { dir: "asc" | "desc" | null; onSort: (dir: "asc" | "desc") => void } => ({
    dir: sort.column === column ? sort.dir : null,
    onSort: (dir) => setSort({ column: column, dir: dir }),
  });

  const shown = sortRows(
    ROWS.filter((row) =>
      parsed.fields.every(({ field, value }) => row[field] === value),
    ),
    (row) => row[sort.column],
    sort.dir,
  );
  const filters = { agent: filterFor("agent"), status: filterFor("status") };

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      <Toolbar>
        <SearchInput
          value={query}
          onChange={setQuery}
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
            <DataTableHead sort={sortFor("name")}>Name</DataTableHead>
            <DataTableHead sort={sortFor("agent")} filter={filters.agent}>
              Agent
            </DataTableHead>
            <DataTableHead sort={sortFor("status")} filter={filters.status}>
              Status
            </DataTableHead>
            <DataTableHead
              sort={{
                ...sortFor("at"),
                words: ["Oldest first", "Newest first"],
              }}
            >
              Last run
            </DataTableHead>
          </tr>
        </DataTableHeader>
        <DataTableBody>
          {shown.map((row) => (
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
      <DataTableFooter>
        {shown.length} of {ROWS.length} jobs ·{" "}
        <span data-table-query>{query}</span>
      </DataTableFooter>
    </div>
  );
}
