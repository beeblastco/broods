"use client";

/**
 * Organization › Members: one row per member with their role, and a panel
 * for the selected one. Role is a Select for anyone holding `members:write`;
 * for everyone else it reads plain with a lock. The owner's row never
 * changes here.
 *
 * Laid out like Monitoring: a toolbar, a flush table whose headers sort on
 * click, and a detail panel with the facts, the role control, and the
 * danger zone at the end.
 */

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/app/components/DataTable";
import { DeleteZone } from "@/app/components/DangerZone";
import { DetailRows, type DetailRow } from "@/app/components/DetailSections";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState, LockedValue } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { StatusWord } from "@/app/components/StatusDot";
import { FilterButton, Toolbar } from "@/app/components/Toolbar";
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
import { actorName, Who } from "@/app/components/Who";
import { useListState } from "@/app/hooks/useListState";
import { usePermissions } from "@/app/hooks/usePermissions";
import { useSubmit } from "@/app/hooks/useSubmit";
import { formatDate } from "@/app/lib/formatTime";
import type { SortKey } from "@/app/lib/tableState";
import { parseAsId } from "@/app/lib/urlState";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { useQueryState } from "nuqs";
import { useState } from "react";

type Member = FunctionReturnType<typeof api.org.members.list>[number];
type Role = FunctionReturnType<typeof api.access.listRoles>[number];
type CustomRole = Extract<Role, { kind: "custom" }>;
type Tier = Member["role"];
type Column = "name" | "email" | "role" | "joined" | "invitedBy";
type Field = (typeof QUERY_FIELDS)[number];

/** What the role Select holds: a tier, or a custom role's id. */
type RolePick =
  | { tier: "admin" | "member"; roleId?: undefined }
  | { tier: "member"; roleId: Id<"orgRoles"> };

// The `field:value` tokens the search box understands.
const QUERY_FIELDS = ["role"] as const;

// Six columns of short text; below this the panel would wrap them.
const TABLE_MIN_WIDTH = 640;

// The open row's id, in `?sel=` so a link opens it; it only picks among rows already loaded.
const MEMBER_ID = parseAsId<"orgMembers">();

const NO_ROWS: Member[] = [];

const TIER_LABEL: Record<Tier, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

const SORT_KEY: Record<Column, (member: Member) => SortKey> = {
  name: (member) => member.name,
  email: (member) => member.email,
  role: (member) => roleName(member),
  joined: (member) => member.createdAt,
  invitedBy: (member) => member.invitedBy?.name ?? null,
};

interface Props {
  org: Doc<"orgs">;
}

export function MembersPanel({ org }: Props): React.JSX.Element {
  const { can } = usePermissions();
  const canChange = can("members:write");
  const members = useQuery(api.org.members.list, { orgId: org._id });
  const roles = useQuery(api.access.listRoles, {});
  const [selectedId, setSelectedId] = useQueryState("sel", MEMBER_ID);
  const [inviting, setInviting] = useState(false);
  const list = useListState({
    rows: members ?? NO_ROWS,
    fields: QUERY_FIELDS,
    initialSort: { column: "name", dir: "asc" },
    sortKey: SORT_KEY,
    matches: matchesField,
    text: searchText,
  });
  const selected = members?.find(
    (member) => member.membershipId === selectedId,
  );
  const customRoles = (roles ?? []).filter(
    (role): role is CustomRole => role.kind === "custom",
  );
  const filters = {
    role: list.filterFor("role", [
      ...new Set(
        (members ?? []).map((member) => roleName(member).toLowerCase()),
      ),
    ]),
  };

  useShortcut("table.create", () => canChange && setInviting(true));

  if (members === undefined) {
    return <p className="px-6 pt-6 text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <SearchInput
          value={list.query}
          onChange={list.setQuery}
          fields={QUERY_FIELDS}
          placeholder="Search members · role:"
        />
        <FilterButton columns={[{ label: "Role", filter: filters.role }]} />
        {canChange && (
          <Button
            size="sm"
            className="cursor-pointer"
            onClick={() => setInviting(true)}
          >
            <Plus className="size-4" />
            Invite
          </Button>
        )}
      </Toolbar>
      <DetailSplit
        flush
        tableMinWidth={TABLE_MIN_WIDTH}
        detail={
          selected && (
            <MemberPanel
              key={selected.membershipId}
              member={selected}
              customRoles={customRoles}
              canChange={canChange}
              onClose={() => setSelectedId(null)}
            />
          )
        }
      >
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={list.sortFor("name")}>Member</DataTableHead>
              <DataTableHead sort={list.sortFor("email")}>Email</DataTableHead>
              <DataTableHead sort={list.sortFor("role")}>Role</DataTableHead>
              <DataTableHead>Status</DataTableHead>
              <DataTableHead sort={list.sortFor("joined")}>
                Joined
              </DataTableHead>
              <DataTableHead sort={list.sortFor("invitedBy")}>
                Invited by
              </DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map((member) => (
              <DataTableRow
                key={member.membershipId}
                selected={selectedId === member.membershipId}
                onClick={() =>
                  setSelectedId(
                    selectedId === member.membershipId
                      ? null
                      : member.membershipId,
                  )
                }
              >
                <DataTableCell>
                  <Who actor={member} />
                </DataTableCell>
                <DataTableCell muted>{member.email}</DataTableCell>
                <DataTableCell>{roleName(member)}</DataTableCell>
                <DataTableCell>
                  <StatusWord tone="ok">active</StatusWord>
                </DataTableCell>
                <DataTableCell muted>
                  {formatDate(member.createdAt)}
                </DataTableCell>
                <DataTableCell>
                  {member.invitedBy ? (
                    <Who actor={member.invitedBy} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {list.shown.length === 0 && (
          <EmptyState title="No members match the current filters." />
        )}
      </DetailSplit>
      {inviting && (
        <InviteDialog
          orgId={org._id}
          customRoles={customRoles}
          onClose={() => setInviting(false)}
        />
      )}
    </div>
  );
}

/**
 * The selected member: their facts, the role control, and the danger zone.
 * The role is a Select for anyone holding `members:write`; the owner's role
 * never changes here.
 */
function MemberPanel({
  member,
  customRoles,
  canChange,
  onClose,
}: {
  member: Member;
  customRoles: CustomRole[];
  canChange: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const updateRole = useMutation(api.org.members.updateRole);
  const remove = useMutation(api.org.members.remove);
  const { error, run } = useSubmit();
  const editable = canChange && !member.isOwner;
  const items = roleItems(customRoles);
  const facts: DetailRow[] = [
    { key: "email", label: "Email", value: member.email },
    { key: "status", label: "Status", value: "active", words: true },
    {
      key: "joined",
      label: "Joined",
      value: formatDate(member.createdAt),
      words: true,
    },
    {
      key: "invitedBy",
      label: "Invited by",
      value: member.invitedBy ? actorName(member.invitedBy) : "—",
      words: true,
    },
  ];

  return (
    <DetailPanel title={member.name} onClose={onClose}>
      <DetailRows rows={facts} />

      <h4 className="mt-5 mb-1.5 text-sm font-medium">Role</h4>
      {editable ? (
        <Select
          items={items}
          value={member.roleId ?? member.role}
          onValueChange={(value: string | null) => {
            const pick = value === null ? null : rolePick(value, customRoles);
            if (pick) {
              void run(() =>
                updateRole({
                  membershipId: member.membershipId,
                  role: pick.tier,
                  roleId: pick.roleId,
                }),
              );
            }
          }}
        >
          <SelectTrigger size="sm" className="w-44 cursor-pointer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
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
      ) : (
        <p className="text-xs">
          <LockedValue
            reason={
              member.isOwner
                ? "The owner's role cannot change"
                : "No permission to change roles"
            }
          >
            {roleName(member)}
          </LockedValue>
        </p>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {editable && (
        <DeleteZone
          description="Remove the member from the organization. They keep their account and can be invited again."
          verb="Remove"
          resourceName={member.name}
          resourceType="member"
          onDelete={() => remove({ membershipId: member.membershipId })}
          onDeleted={onClose}
        />
      )}
    </DetailPanel>
  );
}

/** Adds an existing user by email with a role. */
function InviteDialog({
  orgId,
  customRoles,
  onClose,
}: {
  orgId: Id<"orgs">;
  customRoles: CustomRole[];
  onClose: () => void;
}): React.JSX.Element {
  const add = useMutation(api.org.members.add);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const { pending, error, run } = useSubmit();
  const items = roleItems(customRoles);

  async function submit(): Promise<void> {
    const pick = rolePick(role, customRoles);
    if (!email.trim() || !pick) return;
    const done = await run(() =>
      add({
        orgId: orgId,
        email: email.trim(),
        role: pick.tier,
        roleId: pick.roleId,
      }),
    );
    if (done) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            The person must have signed in once before.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1">
            <Label htmlFor="invite-email" variant="muted" className="text-xs">
              Email
            </Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="ada@example.com"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="invite-role" variant="muted" className="text-xs">
              Role
            </Label>
            <Select
              items={items}
              value={role}
              onValueChange={(value) => value !== null && setRole(value)}
            >
              <SelectTrigger id="invite-role" className="w-full cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
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
            disabled={pending || !email.trim()}
          >
            {pending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The roles a member may be given: the two tiers and every custom role. */
function roleItems(
  customRoles: CustomRole[],
): Array<{ value: string; label: string }> {
  return [
    { value: "member", label: TIER_LABEL.member },
    { value: "admin", label: TIER_LABEL.admin },
    ...customRoles.map((role) => ({ value: role._id, label: role.name })),
  ];
}

/** What a Select value means: a tier, or one of the org's custom roles. */
function rolePick(value: string, customRoles: CustomRole[]): RolePick | null {
  if (value === "admin" || value === "member") return { tier: value };
  const custom = customRoles.find((role) => role._id === value);

  return custom ? { tier: "member", roleId: custom._id } : null;
}

function matchesField(member: Member, _field: Field, value: string): boolean {
  return roleName(member).toLowerCase() === value;
}

function roleName(member: Member): string {
  return member.roleName ?? TIER_LABEL[member.role];
}

function searchText(member: Member): string {
  return `${member.name} ${member.email}`;
}
