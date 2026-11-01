"use client";

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/app/components/DataTable";
import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { api } from "@broods/convex/_generated/api";
import { useQuery } from "convex/react";

interface Props {
  assignedPolicyIds: string[];
  /** `null` clears the list. Absent when the viewer cannot write. */
  onUpdatePolicyConfig?: (policies: string[] | null) => Promise<void>;
}

export function PoliciesTab({
  assignedPolicyIds,
  onUpdatePolicyConfig,
}: Props): React.JSX.Element {
  const policies = useQuery(api.access.listPolicies, {});
  const assigned = new Set(assignedPolicyIds);
  const attached = (policies ?? []).filter((policy) =>
    assigned.has(policy._id),
  );
  const attachable = (policies ?? []).filter(
    (policy) => !assigned.has(policy._id),
  );

  const write = (next: string[]): void => {
    void onUpdatePolicyConfig?.(next.length === 0 ? null : next);
  };

  return (
    <div className="flex flex-1 flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold">Policies</h3>
        {onUpdatePolicyConfig && attachable.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                />
              }
            >
              Attach policy
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {attachable.map((policy) => (
                <DropdownMenuItem
                  key={policy._id}
                  onClick={() => write([...assignedPolicyIds, policy._id])}
                >
                  {policy.name}
                  <span className="text-muted-foreground">{policy.scope}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {policies === undefined ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : attached.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Without a policy the agent can only answer.
        </p>
      ) : (
        <DataTable>
          <DataTableHeader className="static">
            <tr>
              <DataTableHead>Policy</DataTableHead>
              <DataTableHead>Permissions</DataTableHead>
              <DataTableHead>Mode</DataTableHead>
              <DataTableHead align="right" />
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {attached.map((policy) => (
              <DataTableRow key={policy._id}>
                <DataTableCell>{policy.name}</DataTableCell>
                <DataTableCell muted className="max-w-48 truncate font-mono">
                  {policy.permissions.join(", ") || "—"}
                </DataTableCell>
                <DataTableCell muted>{policy.mode}</DataTableCell>
                <DataTableCell align="right">
                  {onUpdatePolicyConfig && (
                    <Button
                      variant="ghost"
                      size="sm"
                      tone="muted"
                      className="cursor-pointer"
                      onClick={() =>
                        write(
                          assignedPolicyIds.filter((id) => id !== policy._id),
                        )
                      }
                    >
                      Detach
                    </Button>
                  )}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </div>
  );
}
