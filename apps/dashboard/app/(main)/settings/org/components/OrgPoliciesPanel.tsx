"use client";

/**
 * Organization › Policies: a policy is named rules, each one permission in
 * one scope, optionally narrowed by a condition. Policies are the org's, so
 * one serves any agent, role or key in it.
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
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusWord } from "@/app/components/StatusDot";
import { Toolbar } from "@/app/components/Toolbar";
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
import { PLATFORM, Who } from "@/app/components/Who";
import { useListState } from "@/app/hooks/useListState";
import { usePermissions } from "@/app/hooks/usePermissions";
import { useSubmit } from "@/app/hooks/useSubmit";
import { formatDate } from "@/app/lib/formatTime";
import type { SortKey } from "@/app/lib/tableState";
import { parseAsId } from "@/app/lib/urlState";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  POLICY_CONDITION_OPERATORS,
  type PolicyConditionOperator,
} from "@broods/convex/model/policyRules";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { useQueryState } from "nuqs";
import { useState } from "react";

type Policy = FunctionReturnType<typeof api.access.listPolicies>[number];
type Column = "name" | "description" | "permissions" | "scope" | "createdAt";
type Field = (typeof QUERY_FIELDS)[number];
type Mode = Policy["mode"];

/** One choice in the scope Select: the org, a project, or a stage of the picked project. */
interface ScopeItem {
  value: string;
  label: string;
  projectId?: Id<"projects">;
  stageId?: Id<"stages">;
}

const QUERY_FIELDS = ["scope", "mode"] as const;

const TABLE_MIN_WIDTH = 640;

// The open row's id, in `?sel=` so a link opens it; it only picks among rows already loaded.
const POLICY_ID = parseAsId<"agentPolicies">();

const NO_ROWS: Policy[] = [];

const ORGANIZATION: ScopeItem = {
  value: "organization",
  label: "Organization",
};

const MODES: Array<{ value: Mode; label: string }> = [
  { value: "audit", label: "Audit: record decisions, block nothing" },
  { value: "enforce", label: "Enforce: block what a rule denies" },
];

const SORT_KEY: Record<Column, (policy: Policy) => SortKey> = {
  name: (policy) => policy.name,
  description: (policy) => policy.description ?? null,
  permissions: (policy) => policy.permissions.length,
  scope: (policy) => policy.scope,
  createdAt: (policy) => policy.createdAt,
};

export function OrgPoliciesPanel(): React.JSX.Element {
  const { can } = usePermissions();
  const canChange = can("access:write");
  const policies = useQuery(api.access.listPolicies, {});
  const [selectedId, setSelectedId] = useQueryState("sel", POLICY_ID);
  const [creating, setCreating] = useState(false);
  const list = useListState({
    rows: policies ?? NO_ROWS,
    fields: QUERY_FIELDS,
    initialSort: { column: "name", dir: "asc" },
    sortKey: SORT_KEY,
    matches: matchesField,
    text: searchText,
  });
  const selected = policies?.find((policy) => policy._id === selectedId);

  if (policies === undefined) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar className="border-b-0 px-0">
        <SearchInput
          value={list.query}
          onChange={list.setQuery}
          fields={QUERY_FIELDS}
          placeholder="Search policies"
        />
        {canChange && (
          <Button
            size="sm"
            className="cursor-pointer"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-4" />
            New policy
          </Button>
        )}
      </Toolbar>
      <DetailSplit
        tableMinWidth={TABLE_MIN_WIDTH}
        detail={
          selected && (
            <PolicyDetail
              policy={selected}
              canChange={canChange}
              onClose={() => setSelectedId(null)}
            />
          )
        }
      >
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={list.sortFor("name")}>Policy</DataTableHead>
              <DataTableHead sort={list.sortFor("description")}>
                Description
              </DataTableHead>
              <DataTableHead sort={list.sortFor("permissions")}>
                Permissions
              </DataTableHead>
              <DataTableHead sort={list.sortFor("scope")}>Scope</DataTableHead>
              <DataTableHead>Mode</DataTableHead>
              <DataTableHead sort={list.sortFor("createdAt")}>
                Created at
              </DataTableHead>
              <DataTableHead>Created by</DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map((policy) => (
              <DataTableRow
                key={policy._id}
                selected={selectedId === policy._id}
                onClick={() => setSelectedId(policy._id)}
              >
                <DataTableCell className="font-medium">
                  {policy.name}
                </DataTableCell>
                <DataTableCell muted className="max-w-72 truncate">
                  {policy.description || "—"}
                </DataTableCell>
                <DataTableCell>{policy.permissions.length}</DataTableCell>
                <DataTableCell muted>{policy.scope}</DataTableCell>
                <DataTableCell>
                  <StatusWord tone={policy.mode === "enforce" ? "ok" : "ended"}>
                    {policy.mode}
                  </StatusWord>
                </DataTableCell>
                <DataTableCell muted>
                  {formatDate(policy.createdAt)}
                </DataTableCell>
                <DataTableCell>
                  <Who actor={policy.createdBy ?? PLATFORM} />
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {list.shown.length === 0 && (
          <EmptyState
            title={
              policies.length === 0
                ? "No policies yet."
                : "No policies match the current filters."
            }
          />
        )}
        <DataTableFooter
          shown={list.shown.length}
          total={policies.length}
          noun={["policy", "policies"]}
        />
      </DetailSplit>
      {creating && <PolicyDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/** The selected policy: its facts, its rules with add and remove, and delete. */
function PolicyDetail({
  policy,
  canChange,
  onClose,
}: {
  policy: Policy;
  canChange: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const removeRule = useMutation(api.access.removeRule);
  const removePolicy = useMutation(api.access.removePolicy);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const { error, run } = useSubmit();
  const editable = canChange && policy.managedBy !== "cli";

  async function confirmDelete(): Promise<void> {
    setDeletePending(true);
    try {
      await removePolicy({ policyId: policy._id });
      onClose();
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <DetailPanel
      title={policy.name}
      meta={
        editable && (
          <div className="mt-1 flex gap-1">
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              tone="muted-destructive"
              className="cursor-pointer"
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          </div>
        )
      }
      onClose={onClose}
    >
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Name</dt>
        <dd>{policy.name}</dd>
        <dt className="text-muted-foreground">Description</dt>
        <dd className="truncate">{policy.description || "—"}</dd>
        <dt className="text-muted-foreground">Scope</dt>
        <dd>{policy.scope}</dd>
        <dt className="text-muted-foreground">Mode</dt>
        <dd>
          <StatusWord tone={policy.mode === "enforce" ? "ok" : "ended"}>
            {policy.mode}
          </StatusWord>
        </dd>
        <dt className="text-muted-foreground">Created at</dt>
        <dd>{formatDate(policy.createdAt)}</dd>
        <dt className="text-muted-foreground">Created by</dt>
        <dd>
          <Who actor={policy.createdBy ?? PLATFORM} />
        </dd>
      </dl>
      {policy.managedBy === "cli" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Managed by code. Change it in the project and deploy.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <div className="mt-4 flex items-center justify-between">
        <h4 className="text-xs font-semibold">Rules</h4>
        {editable && (
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={() => setAdding(true)}
          >
            Add rule
          </Button>
        )}
      </div>
      {policy.rules.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">No rules yet.</p>
      ) : (
        <DataTable className="mt-1">
          <DataTableHeader className="static">
            <tr>
              <DataTableHead>Permission</DataTableHead>
              <DataTableHead>Effect</DataTableHead>
              <DataTableHead>Scope</DataTableHead>
              <DataTableHead>Condition</DataTableHead>
              <DataTableHead align="right" />
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {policy.rules.map((rule) => (
              <DataTableRow key={rule.id}>
                <DataTableCell className="font-mono">
                  {rule.permissions.join(", ")}
                </DataTableCell>
                <DataTableCell muted={rule.effect === "allow"}>
                  {rule.effect}
                </DataTableCell>
                <DataTableCell muted>{rule.scope}</DataTableCell>
                <DataTableCell muted className="font-mono">
                  {rule.condition ?? "—"}
                </DataTableCell>
                <DataTableCell align="right">
                  {editable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      tone="muted"
                      className="cursor-pointer"
                      onClick={() =>
                        run(() =>
                          removeRule({ policyId: policy._id, ruleId: rule.id }),
                        )
                      }
                    >
                      Remove
                    </Button>
                  )}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}

      {editing && (
        <PolicyDialog policy={policy} onClose={() => setEditing(false)} />
      )}
      {adding && (
        <AddRuleDialog policyId={policy._id} onClose={() => setAdding(false)} />
      )}
      {deleting && (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(false)}
          resourceName={policy.name}
          resourceType="policy"
          critical={false}
          onConfirm={confirmDelete}
          isDeleting={deletePending}
        />
      )}
    </DetailPanel>
  );
}

/** New or edit: name, description and mode. */
function PolicyDialog({
  policy,
  onClose,
}: {
  policy?: Policy;
  onClose: () => void;
}): React.JSX.Element {
  const create = useMutation(api.access.createPolicy);
  const update = useMutation(api.access.updatePolicy);
  const [name, setName] = useState(policy?.name ?? "");
  const [description, setDescription] = useState(policy?.description ?? "");
  const [mode, setMode] = useState<Mode>(policy?.mode ?? "audit");
  const { pending, error, run } = useSubmit();

  async function submit(): Promise<void> {
    const done = await run(() =>
      policy
        ? update({
            policyId: policy._id,
            name: name.trim(),
            description: description.trim() || null,
            mode: mode,
          })
        : create({
            name: name.trim(),
            description: description.trim() || undefined,
            mode: mode,
          }),
    );
    if (done) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{policy ? "Edit policy" : "New policy"}</DialogTitle>
          <DialogDescription>
            A policy is named rules. Add them once it exists.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1">
            <Label htmlFor="policy-name" variant="muted" className="text-xs">
              Name
            </Label>
            <Input
              id="policy-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Support runner"
            />
          </div>
          <div className="grid gap-1">
            <Label
              htmlFor="policy-description"
              variant="muted"
              className="text-xs"
            >
              Description
            </Label>
            <Input
              id="policy-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Run and watch the support agents"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="policy-mode" variant="muted" className="text-xs">
              Mode
            </Label>
            <Select
              items={MODES}
              value={mode}
              onValueChange={(value) => {
                const picked = MODES.find((item) => item.value === value);
                if (picked) setMode(picked.value);
              }}
            >
              <SelectTrigger id="policy-mode" className="w-full cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((item) => (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    className="cursor-pointer"
                  >
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            {pending ? "Saving…" : policy ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One permission in one scope, with an optional condition. */
function AddRuleDialog({
  policyId,
  onClose,
}: {
  policyId: Id<"agentPolicies">;
  onClose: () => void;
}): React.JSX.Element {
  const addRule = useMutation(api.access.addRule);
  const permissions = useQuery(api.access.listPermissions, {});
  const projects = useQuery(api.project.list, {});
  const [permission, setPermission] = useState("");
  const [effect, setEffect] = useState<"allow" | "deny">("allow");
  const [scope, setScope] = useState<ScopeItem>(ORGANIZATION);
  const [attribute, setAttribute] = useState("");
  const [operator, setOperator] = useState<PolicyConditionOperator>("equals");
  const [value, setValue] = useState("");
  const { pending, error, run } = useSubmit();
  const stages = useQuery(
    api.stage.list,
    scope.projectId ? { projectId: scope.projectId } : "skip",
  );

  const scopeItems: ScopeItem[] = [
    ORGANIZATION,
    ...(projects ?? []).map((project): ScopeItem => ({
      value: project._id,
      label: `Project ${project.name}`,
      projectId: project._id,
    })),
    ...(stages ?? []).map((stage): ScopeItem => ({
      value: stage._id,
      label: `Stage ${stage.name}`,
      projectId: stage.projectId,
      stageId: stage._id,
    })),
  ];
  const permissionItems = (permissions ?? []).map((row) => ({
    value: row.name,
    label: row.name,
  }));

  async function submit(): Promise<void> {
    const done = await run(() =>
      addRule({
        policyId: policyId,
        permission: permission,
        effect: effect,
        scope: { projectId: scope.projectId, stageId: scope.stageId },
        ...(attribute.trim()
          ? {
              condition: {
                attribute: attribute.trim(),
                operator: operator,
                value: value.trim(),
              },
            }
          : {}),
      }),
    );
    if (done) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add rule</DialogTitle>
          <DialogDescription>One permission in one scope.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1">
            <Label
              htmlFor="rule-permission"
              variant="muted"
              className="text-xs"
            >
              Permission
            </Label>
            <Select
              items={permissionItems}
              value={permission}
              onValueChange={(next) => next !== null && setPermission(next)}
            >
              <SelectTrigger
                id="rule-permission"
                className="w-full cursor-pointer"
              >
                <SelectValue placeholder="Pick a permission" />
              </SelectTrigger>
              <SelectContent>
                {permissionItems.map((item) => (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    className="cursor-pointer font-mono text-xs"
                  >
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label htmlFor="rule-effect" variant="muted" className="text-xs">
                Effect
              </Label>
              <Select
                items={[
                  { value: "allow", label: "Allow" },
                  { value: "deny", label: "Deny" },
                ]}
                value={effect}
                onValueChange={(next) =>
                  (next === "allow" || next === "deny") && setEffect(next)
                }
              >
                <SelectTrigger
                  id="rule-effect"
                  className="w-full cursor-pointer"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow" className="cursor-pointer">
                    Allow
                  </SelectItem>
                  <SelectItem value="deny" className="cursor-pointer">
                    Deny
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="rule-scope" variant="muted" className="text-xs">
                Scope
              </Label>
              <Select
                items={scopeItems}
                value={scope.value}
                onValueChange={(next) => {
                  const picked = scopeItems.find((item) => item.value === next);
                  if (picked) setScope(picked);
                }}
              >
                <SelectTrigger
                  id="rule-scope"
                  className="w-full cursor-pointer"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopeItems.map((item) => (
                    <SelectItem
                      key={item.value}
                      value={item.value}
                      className="cursor-pointer"
                    >
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1">
            <Label variant="muted" className="text-xs">
              Condition (optional)
            </Label>
            <div className="grid grid-cols-[1fr_auto_1fr] gap-2">
              <Input
                value={attribute}
                onChange={(event) => setAttribute(event.target.value)}
                placeholder="agent.public"
                aria-label="Condition attribute"
                className="font-mono text-xs"
              />
              <Select
                items={POLICY_CONDITION_OPERATORS}
                value={operator}
                onValueChange={(next) => {
                  const picked = POLICY_CONDITION_OPERATORS.find(
                    (item) => item.value === next,
                  );
                  if (picked) setOperator(picked.value);
                }}
              >
                <SelectTrigger
                  aria-label="Condition operator"
                  className="w-24 cursor-pointer"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POLICY_CONDITION_OPERATORS.map((item) => (
                    <SelectItem
                      key={item.value}
                      value={item.value}
                      className="cursor-pointer"
                    >
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="true"
                aria-label="Condition value"
                className="font-mono text-xs"
              />
            </div>
            <p className="text-2xs text-muted-foreground">
              Attributes available: agent.public, agent.name, stage.kind,
              sandbox.provider.
            </p>
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
            disabled={pending || !permission}
          >
            {pending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function matchesField(policy: Policy, field: Field, value: string): boolean {
  return field === "scope"
    ? policy.scope.toLowerCase().startsWith(value)
    : policy.mode === value;
}

function searchText(policy: Policy): string {
  return `${policy.name} ${policy.description ?? ""}`;
}
