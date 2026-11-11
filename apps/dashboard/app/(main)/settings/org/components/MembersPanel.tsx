"use client";

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/app/components/DataTable";
import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { DangerZone, DeleteZone } from "@/app/components/DangerZone";
import {
  type ControlRow,
  type DetailRow,
  DetailRows,
} from "@/app/components/DetailSections";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState, LockedValue } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { StatusWord } from "@/app/components/StatusDot";
import { FilterButton, Toolbar } from "@/app/components/Toolbar";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
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
import { type OrgSeats, useOrgSeats } from "@/app/hooks/useOrgSeats";
import { usePermissions } from "@/app/hooks/usePermissions";
import { useSubmit } from "@/app/hooks/useSubmit";
import { formatDay } from "@/app/lib/allowance";
import { formatDate } from "@/app/lib/formatTime";
import { tabHref } from "@/app/lib/navigation";
import { perMonth, PRO_OFFER } from "@/app/lib/pricing";
import { parseQuery } from "@/app/lib/queryTokens";
import type { SortKey } from "@/app/lib/tableState";
import { parseAsId } from "@/app/lib/urlState";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { clientErrorData } from "@broods/convex/model/clientError";
import { proQuantity } from "@broods/convex/model/orgBilling";
import type { FunctionReturnType } from "convex/server";
import { useAction, useMutation, useQuery } from "convex/react";
import { ArrowUpRight, ChevronDown, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryState } from "nuqs";
import { useState } from "react";

type Member = FunctionReturnType<typeof api.org.members.list>[number];
type Invitation = FunctionReturnType<typeof api.org.invitations.list>[number];
type Role = FunctionReturnType<typeof api.access.listRoles>[number];
type Tier = Member["role"];
type Column = "name" | "email" | "role" | "joined" | "invitedBy";
type Field = (typeof QUERY_FIELDS)[number];

type InviteStep = "invite" | "seat" | "upgrade" | "billing" | "ask";

type RolePick =
  | { tier: "admin" | "member"; roleId?: undefined }
  | { tier: "member"; roleId: Id<"orgRoles"> };

interface RoleOption {
  value: string;
  label: string;
  description: string;
  pick: RolePick;
}

const QUERY_FIELDS = ["role"] as const;

const TABLE_MIN_WIDTH = 640;

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
  const invitations = useQuery(
    api.org.invitations.list,
    canChange ? { orgId: org._id } : "skip",
  );
  const me = useQuery(api.user.getCurrent);
  const roles = useQuery(api.access.listRoles, {});
  const [selectedId, setSelectedId] = useQueryState("sel", MEMBER_ID);
  const [inviting, setInviting] = useState(false);
  const seats = useOrgSeats();
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
  const options = roleOptions(roles ?? []);
  const search = parseQuery(list.query, QUERY_FIELDS);
  const pending = (invitations ?? []).filter(
    (invitation) =>
      invitation.email.includes(search.text) &&
      (search.fields.length === 0 ||
        search.fields.some(({ field, value }) =>
          matchesField(invitation, field, value),
        )),
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
        {seats?.enforced && seats.isOwner && (
          <Badge variant="outline">
            {seats.billing && !seats.paid
              ? "Seats on hold until Stripe has the payment"
              : `${seats.developers} of ${seats.seats} developer seats used`}
          </Badge>
        )}
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
              org={org}
              member={selected}
              self={selected.userId === me?._id}
              options={options}
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
        {pending.length > 0 && (
          <PendingInvitations org={org} invitations={pending} />
        )}
      </DetailSplit>
      {inviting && (
        <InviteDialog
          org={org}
          seats={seats}
          options={options}
          onClose={() => setInviting(false)}
        />
      )}
    </div>
  );
}

function MemberPanel({
  org,
  member,
  self,
  options,
  canChange,
  onClose,
}: {
  org: Doc<"orgs">;
  member: Member;
  self: boolean;
  options: RoleOption[];
  canChange: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const updateRole = useMutation(api.org.members.updateRole);
  const remove = useMutation(api.org.members.remove);
  const leave = useMutation(api.org.members.leave);
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const { pending, error, run } = useSubmit();
  const editable = canChange && !member.isOwner;
  const facts: Array<DetailRow | ControlRow> = [
    { key: "email", label: "Email", value: member.email },
    {
      key: "role",
      label: "Role",
      control: editable ? (
        <RolePicker
          member={member}
          options={options}
          pending={pending}
          onPick={pickRole}
        />
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
      ),
    },
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

  function pickRole(pick: RolePick): void {
    void run(() =>
      updateRole({
        membershipId: member.membershipId,
        role: pick.tier,
        roleId: pick.roleId,
      }),
    );
  }

  async function confirmLeave(): Promise<void> {
    if (await run(() => leave({ orgId: org._id }))) router.replace("/");
  }

  return (
    <DetailPanel
      title={self ? `${member.name} (you)` : member.name}
      onClose={onClose}
    >
      <DetailRows rows={facts} />
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {self && (
        <DangerZone
          description={
            member.isOwner
              ? "The owner cannot leave. Delete the organization in Danger Zone instead."
              : "You lose access to its projects. An admin can invite you again."
          }
        >
          <Button
            variant="destructive"
            size="sm"
            className={member.isOwner ? "cursor-not-allowed" : "cursor-pointer"}
            disabled={member.isOwner}
            title={member.isOwner ? "The owner cannot leave" : undefined}
            onClick={() => setLeaving(true)}
          >
            Leave {org.name}
          </Button>
        </DangerZone>
      )}
      {leaving && (
        <ConfirmDialog
          title={`Leave ${org.name}?`}
          description="You lose access to its projects right away. An admin can invite you again."
          verb="Leave"
          pending={pending}
          error={error}
          onConfirm={() => void confirmLeave()}
          onClose={() => setLeaving(false)}
        />
      )}
      {editable && !self && (
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

function PendingInvitations({
  org,
  invitations,
}: {
  org: Doc<"orgs">;
  invitations: Invitation[];
}): React.JSX.Element {
  const revoke = useMutation(api.org.invitations.revoke);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const { pending, error, run, reset } = useSubmit();

  async function confirmRevoke(invitation: Invitation): Promise<void> {
    const done = await run(() =>
      revoke({ invitationId: invitation.invitationId }),
    );
    if (done) setRevoking(null);
  }

  return (
    <>
      <h3 className="flex items-center gap-2 border-t border-border px-3 pt-2.5 pb-1.5 text-xs font-medium">
        Pending invitations
        <span className="text-muted-foreground">{invitations.length}</span>
      </h3>
      <DataTable>
        <DataTableHeader>
          <tr>
            <DataTableHead>Email</DataTableHead>
            <DataTableHead>Role</DataTableHead>
            <DataTableHead>Status</DataTableHead>
            <DataTableHead>Invited by</DataTableHead>
            <DataTableHead>Sent</DataTableHead>
            <DataTableHead align="right">
              <span className="sr-only">Actions</span>
            </DataTableHead>
          </tr>
        </DataTableHeader>
        <DataTableBody>
          {invitations.map((invitation) => (
            <DataTableRow key={invitation.invitationId}>
              <DataTableCell>{invitation.email}</DataTableCell>
              <DataTableCell>{roleName(invitation)}</DataTableCell>
              <DataTableCell>
                {invitation.hasAccount ? (
                  <StatusWord tone="warn">waiting</StatusWord>
                ) : (
                  <StatusWord tone="ended">
                    <span
                      title="They see it after they sign in with this email."
                      className="cursor-help underline decoration-dotted underline-offset-3"
                    >
                      no account yet
                    </span>
                  </StatusWord>
                )}
              </DataTableCell>
              <DataTableCell>
                {invitation.invitedBy ? (
                  <Who actor={invitation.invitedBy} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </DataTableCell>
              <DataTableCell muted>
                {formatDate(invitation.createdAt)}
              </DataTableCell>
              <DataTableCell align="right">
                <Button
                  variant="ghost"
                  size="xs"
                  tone="destructive"
                  className="cursor-pointer"
                  onClick={() => {
                    reset();
                    setRevoking(invitation);
                  }}
                >
                  Revoke
                </Button>
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
      {revoking && (
        <ConfirmDialog
          title="Revoke invitation"
          description={`${revoking.email} can no longer join ${org.name} with it. You can invite them again.`}
          verb="Revoke"
          pending={pending}
          error={error}
          onConfirm={() => void confirmRevoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
    </>
  );
}

function RolePicker({
  member,
  options,
  pending,
  onPick,
}: {
  member: Member;
  options: RoleOption[];
  pending: boolean;
  onPick: (pick: RolePick) => void;
}): React.JSX.Element {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const current = member.roleId ?? member.role;
  const tiers = options.filter((option) => option.pick.roleId === undefined);
  const custom = options.filter((option) => option.pick.roleId !== undefined);

  function item(option: RoleOption): React.JSX.Element {
    return (
      <RoleItem
        key={option.value}
        option={option}
        active={option.value === current}
        onPick={onPick}
      />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            tone="muted"
            className="cursor-pointer justify-self-start"
            disabled={pending}
          />
        }
      >
        {roleName(member)}
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel variant="muted">
            Role for {member.name}
          </DropdownMenuLabel>
          {tiers.map(item)}
        </DropdownMenuGroup>
        {custom.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel variant="muted">
                Custom roles
              </DropdownMenuLabel>
              {custom.map(item)}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          render={<Link href={tabHref(pathname, "roles", search)} />}
        >
          Manage roles
          <ArrowUpRight className="ml-auto" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RoleItem({
  option,
  active,
  onPick,
}: {
  option: RoleOption;
  active: boolean;
  onPick: (pick: RolePick) => void;
}): React.JSX.Element {
  return (
    <DropdownMenuItem
      data-active={active}
      onClick={() => !active && onPick(option.pick)}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{option.label}</span>
        {option.description && (
          <span className="truncate text-2xs text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
    </DropdownMenuItem>
  );
}

function InviteDialog({
  org,
  seats,
  options,
  onClose,
}: {
  org: Doc<"orgs">;
  seats: OrgSeats | undefined;
  options: RoleOption[];
  onClose: () => void;
}): React.JSX.Element {
  const create = useMutation(api.org.invitations.create);
  const addSeat = useAction(api.stripe.addSeat);
  const createCheckoutSession = useAction(api.stripe.createCheckoutSession);
  const createPortalSession = useAction(api.stripe.createPortalSession);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [refused, setRefused] = useState(false);
  const { pending, error, run } = useSubmit();
  const step = inviteStep(seats, refused);

  async function submit(): Promise<void> {
    const pick = options.find((option) => option.value === role)?.pick;
    if (!email.trim() || !pick) return;
    const invite = (): Promise<Id<"orgInvitations">> =>
      create({
        orgId: org._id,
        email: email.trim(),
        role: pick.tier,
        roleId: pick.roleId,
      });
    let seatTaken = false;
    // Invite first, so a refused invite or a seat freed meanwhile costs nothing.
    const done = await run(async () => {
      try {
        await invite();
      } catch (err) {
        if (clientErrorData(err)?.code !== "payment_required") throw err;
        if (step !== "seat") {
          seatTaken = true;

          return;
        }
        await addSeat({});
        await invite();
      }
    });
    if (seatTaken) setRefused(true);
    else if (done) onClose();
  }

  async function openStripe(): Promise<void> {
    await run(async () => {
      const back = window.location.href;
      const { url } =
        step === "billing"
          ? await createPortalSession({ returnUrl: back })
          : await createCheckoutSession({ successUrl: back, cancelUrl: back });
      window.location.href = url;
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            They join when they accept. No email is sent, so tell them.
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
          {step !== "upgrade" && step !== "billing" && (
            <div className="grid gap-1">
              <Label htmlFor="invite-role" variant="muted" className="text-xs">
                Role
              </Label>
              <Select
                items={options}
                value={role}
                onValueChange={(value) => value !== null && setRole(value)}
              >
                <SelectTrigger
                  id="invite-role"
                  className="w-full cursor-pointer"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      className="cursor-pointer"
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {seats && step !== "invite" && (
            <SeatNotice seats={seats} step={step} />
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
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
          {step === "upgrade" || step === "billing" ? (
            <Button
              size="sm"
              className="cursor-pointer"
              onClick={openStripe}
              disabled={pending}
            >
              <ArrowUpRight />
              {pending
                ? "Loading…"
                : step === "billing"
                  ? "Manage billing"
                  : `Upgrade · ${perMonth(proQuantity(seats?.developers ?? 0))}`}
            </Button>
          ) : (
            <Button
              size="sm"
              className="cursor-pointer"
              onClick={submit}
              disabled={pending || !email.trim()}
            >
              {step === "seat"
                ? pending
                  ? "Paying…"
                  : "Pay for seat and invite"
                : pending
                  ? "Inviting…"
                  : "Invite"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SeatNotice({
  seats,
  step,
}: {
  seats: OrgSeats;
  step: Exclude<InviteStep, "invite">;
}): React.JSX.Element {
  return (
    <div
      className="grid gap-1 rounded-md bg-muted px-3 py-2.5 text-xs"
      data-testid="invite-seat-notice"
    >
      <p className="font-medium text-foreground">
        {step === "upgrade"
          ? "You are on Hobby, which has no developer seats."
          : step === "billing"
            ? "Your last payment did not go through."
            : "Every developer seat is taken."}
      </p>
      {step === "seat" && seats.billing && (
        <>
          <p className="flex justify-between gap-4 text-foreground">
            <span>
              {seats.seatsToAdd === 1
                ? "1 more seat"
                : `${seats.seatsToAdd} more seats`}
            </span>
            <span>{perMonth(seats.seatsToAdd)}</span>
          </p>
          <p className="text-muted-foreground">
            Charged now to the card on file, prorated to{" "}
            {formatDay(seats.billing.currentPeriodEnd * 1000)}, and usable in
            any of your orgs. If the payment fails, nobody is invited. A
            developer already in another of your orgs joins free.
          </p>
        </>
      )}
      {step === "upgrade" && (
        <p className="text-muted-foreground">
          {PRO_OFFER} Upgrade opens Stripe Checkout
          {seats.developers > 0
            ? ` for all ${seats.developers} developers: ${perMonth(proQuantity(seats.developers))}`
            : ""}
          . Back here, invite them again.
        </p>
      )}
      {step === "billing" && (
        <p className="text-muted-foreground">
          Your seats come back once Stripe has the payment. Update the card in
          Manage billing, then invite them again.
        </p>
      )}
      {step === "ask" && (
        <p className="text-muted-foreground">
          Ask {seats.ownerName}, the owner, to add a developer seat in Billing.
          Someone already on one of their seats joins free. You are never
          charged.
        </p>
      )}
    </div>
  );
}

// Only the owner sees the seats; anyone else learns from the invite's 402.
function inviteStep(seats: OrgSeats | undefined, refused: boolean): InviteStep {
  if (!seats) return "invite";
  if (!seats.isOwner) return refused ? "ask" : "invite";
  const full = refused || (seats.enforced && seats.developers >= seats.seats);
  if (!full) return "invite";
  if (!seats.billing) return "upgrade";

  return seats.paid ? "seat" : "billing";
}

function matchesField(
  row: Member | Invitation,
  _field: Field,
  value: string,
): boolean {
  return roleName(row).toLowerCase() === value;
}

function roleName(row: Member | Invitation): string {
  return row.roleName ?? TIER_LABEL[row.role];
}

function roleOptions(roles: Role[]): RoleOption[] {
  return roles.flatMap((role): RoleOption[] => {
    if (role.kind === "custom") {
      return [
        {
          value: role._id,
          label: role.name,
          description: role.description,
          pick: { tier: "member", roleId: role._id },
        },
      ];
    }
    if (role.tier === "owner") return [];

    return [
      {
        value: role.tier,
        label: role.name,
        description: role.description,
        pick: { tier: role.tier },
      },
    ];
  });
}

function searchText(member: Member): string {
  return `${member.name} ${member.email}`;
}
