"use client";

/**
 * Organization › Members: one row per member with their role, and a panel
 * for the selected one. Role is a Select for anyone holding `members:write`;
 * for everyone else it reads plain with a lock. The owner's row never
 * changes here.
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
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState, LockedValue } from "@/app/components/EmptyState";
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
import { Who } from "@/app/components/Who";
import { usePermissions } from "@/app/hooks/usePermissions";
import { toErrorMessage } from "@/app/lib/errors";
import { formatDate } from "@/app/lib/formatTime";
import { parseQuery } from "@/app/lib/queryTokens";
import { sortRows, type SortKey, type SortState } from "@/app/lib/tableState";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";

type Member = FunctionReturnType<typeof api.org.members.list>[number];
type Tier = Member["role"];
type Column = "name" | "email" | "role" | "joined" | "invitedBy";

// The `field:value` tokens the search box understands.
const QUERY_FIELDS = ["role"] as const;

// Six columns of short text; below this the panel would wrap them.
const TABLE_MIN_WIDTH = 640;

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
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortState<Column>>({
    column: "name",
    dir: "asc",
  });
  const [selectedId, setSelectedId] = useState<Id<"orgMembers"> | null>(null);
  const [inviting, setInviting] = useState(false);

  const query = useMemo(() => parseQuery(filter, QUERY_FIELDS), [filter]);
  const shown = useMemo(() => {
    const matching = (members ?? []).filter((member) => {
      const rolePass = query.fields.every(
        ({ value }) => roleName(member).toLowerCase() === value,
      );
      if (!rolePass) return false;
      if (!query.text) return true;

      return `${member.name} ${member.email}`
        .toLowerCase()
        .includes(query.text);
    });

    return sortRows(matching, SORT_KEY[sort.column], sort.dir);
  }, [members, query, sort]);
  const selected = members?.find(
    (member) => member.membershipId === selectedId,
  );
  const sortFor = (column: Column): HeadSort => ({
    dir: sort.column === column ? sort.dir : null,
    onSort: (dir) => setSort({ column: column, dir: dir }),
  });
  const customRoles = (roles ?? []).filter((role) => role.kind === "custom");

  if (members === undefined) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar className="border-b-0 px-0">
        <SearchInput
          value={filter}
          onChange={setFilter}
          fields={QUERY_FIELDS}
          placeholder="Search members"
        />
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
        tableMinWidth={TABLE_MIN_WIDTH}
        detail={
          selected && (
            <MemberDetail
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
              <DataTableHead sort={sortFor("name")}>Member</DataTableHead>
              <DataTableHead sort={sortFor("email")}>Email</DataTableHead>
              <DataTableHead sort={sortFor("role")}>Role</DataTableHead>
              <DataTableHead>Status</DataTableHead>
              <DataTableHead sort={sortFor("joined")}>Joined</DataTableHead>
              <DataTableHead sort={sortFor("invitedBy")}>
                Invited by
              </DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {shown.map((member) => (
              <DataTableRow
                key={member.membershipId}
                selected={selectedId === member.membershipId}
                onClick={() => setSelectedId(member.membershipId)}
              >
                <DataTableCell>
                  <Who
                    actor={{
                      kind: "person",
                      name: member.name,
                      avatarUrl: member.avatarUrl,
                    }}
                  />
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
                    <Who actor={{ kind: "person", ...member.invitedBy }} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {shown.length === 0 && (
          <EmptyState title="No members match the current filters." />
        )}
        <DataTableFooter>
          {shown.length === members.length
            ? `${members.length} members`
            : `${shown.length} of ${members.length} members`}
        </DataTableFooter>
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

/** The selected member: their facts, the role control, and Remove. */
function MemberDetail({
  member,
  customRoles,
  canChange,
  onClose,
}: {
  member: Member;
  customRoles: Array<{ _id?: Id<"orgRoles">; name: string }>;
  canChange: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const updateRole = useMutation(api.org.members.updateRole);
  const remove = useMutation(api.org.members.remove);
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = canChange && !member.isOwner;

  async function setRole(value: string): Promise<void> {
    setError(null);
    try {
      if (value === "admin" || value === "member") {
        await updateRole({
          membershipId: member.membershipId,
          role: value,
          roleId: null,
        });
      } else {
        await updateRole({
          membershipId: member.membershipId,
          role: "member",
          roleId: value as Id<"orgRoles">,
        });
      }
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }

  async function confirmRemove(): Promise<void> {
    setPending(true);
    try {
      await remove({ membershipId: member.membershipId });
      onClose();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <DetailPanel title={member.name} onClose={onClose}>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Member</dt>
        <dd>
          <Who
            actor={{
              kind: "person",
              name: member.name,
              avatarUrl: member.avatarUrl,
            }}
          />
        </dd>
        <dt className="text-muted-foreground">Email</dt>
        <dd className="truncate">{member.email}</dd>
        <dt className="text-muted-foreground">Role</dt>
        <dd>
          {editable ? (
            <Select
              items={roleItems(customRoles)}
              value={(member.roleId ?? member.role) as string}
              onValueChange={(value: string | null) =>
                value !== null && void setRole(value)
              }
            >
              <SelectTrigger size="sm" className="w-44 cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleItems(customRoles).map((item) => (
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
            <LockedValue
              reason={
                member.isOwner
                  ? "The owner's role cannot change"
                  : "No permission to change roles"
              }
            >
              {roleName(member)}
            </LockedValue>
          )}
        </dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          <StatusWord tone="ok">active</StatusWord>
        </dd>
        <dt className="text-muted-foreground">Joined</dt>
        <dd>{formatDate(member.createdAt)}</dd>
        <dt className="text-muted-foreground">Invited by</dt>
        <dd>
          {member.invitedBy ? (
            <Who actor={{ kind: "person", ...member.invitedBy }} />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </dd>
      </dl>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {editable && (
        <div className="mt-4">
          <Button
            variant="ghost"
            size="sm"
            tone="muted-destructive"
            className="cursor-pointer"
            onClick={() => setRemoving(true)}
          >
            Remove from organization
          </Button>
        </div>
      )}
      {removing && (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(false)}
          resourceName={member.name}
          resourceType="member"
          critical={false}
          onConfirm={confirmRemove}
          isDeleting={pending}
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
  customRoles: Array<{ _id?: Id<"orgRoles">; name: string }>;
  onClose: () => void;
}): React.JSX.Element {
  const add = useMutation(api.org.members.add);
  const updateRole = useMutation(api.org.members.updateRole);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!email.trim()) return;
    setPending(true);
    setError(null);
    try {
      const tier = role === "admin" ? "admin" : "member";
      const membershipId = await add({
        orgId: orgId,
        email: email.trim(),
        role: tier,
      });
      if (role !== "admin" && role !== "member") {
        await updateRole({
          membershipId: membershipId,
          role: "member",
          roleId: role as Id<"orgRoles">,
        });
      }
      onClose();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setPending(false);
    }
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
              items={roleItems(customRoles)}
              value={role}
              onValueChange={(value) => value !== null && setRole(value)}
            >
              <SelectTrigger id="invite-role" className="w-full cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleItems(customRoles).map((item) => (
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
  customRoles: Array<{ _id?: Id<"orgRoles">; name: string }>,
): Array<{ value: string; label: string }> {
  return [
    { value: "member", label: TIER_LABEL.member },
    { value: "admin", label: TIER_LABEL.admin },
    ...customRoles.flatMap((role) =>
      role._id ? [{ value: role._id, label: role.name }] : [],
    ),
  ];
}

function roleName(member: Member): string {
  return member.roleName ?? TIER_LABEL[member.role];
}
