"use client";

/**
 * Members panel: list org members with role, invite by email, change roles,
 * and remove. Reads/writes via api.orgMembers; gated server-side.
 */

import { Section } from "@/app/components/Section";
import { Avatar, AvatarFallback, AvatarImage } from "@/app/components/ui/avatar";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/app/components/ui/select";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Trash2 } from "lucide-react";
import { useState } from "react";

type Role = "owner" | "admin" | "member";

interface Props {
    /** The org whose members are being managed. */
    org: Doc<"orgs">;
}

const ROLE_LABEL: Record<Role, string> = {
    owner: "Owner",
    admin: "Admin",
    member: "Member",
};

export function MembersPanel({ org }: Props) {
    const members = useQuery(api.orgMembers.list, { orgId: org._id });
    const add = useMutation(api.orgMembers.add);
    const updateRole = useMutation(api.orgMembers.updateRole).withOptimisticUpdate((localStore, args) => {
        const list = localStore.getQuery(api.orgMembers.list, { orgId: org._id });
        if (!list) {
            return;
        }

        localStore.setQuery(
            api.orgMembers.list,
            { orgId: org._id },
            list.map((m) => (m.membershipId === args.membershipId ? { ...m, role: args.role ?? m.role } : m)),
        );
    });
    const remove = useMutation(api.orgMembers.remove).withOptimisticUpdate((localStore, args) => {
        const list = localStore.getQuery(api.orgMembers.list, { orgId: org._id });
        if (!list) {
            return;
        }

        localStore.setQuery(
            api.orgMembers.list,
            { orgId: org._id },
            list.filter((m) => m.membershipId !== args.membershipId),
        );
    });

    const [inviteEmail, setInviteEmail] = useState("");
    const [inviteRole, setInviteRole] = useState<Exclude<Role, "owner">>("member");
    const [inviting, setInviting] = useState(false);
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [inviteNotice, setInviteNotice] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    async function handleInvite() {
        const email = inviteEmail.trim();
        if (!email) return;
        setInviting(true);
        setInviteError(null);
        setInviteNotice(null);
        try {
            await add({ orgId: org._id, email: email, role: inviteRole });
            setInviteEmail("");
            setInviteNotice(`Added ${email}.`);
        } catch (err) {
            setInviteError(err instanceof Error ? err.message : "Add failed");
        } finally {
            setInviting(false);
        }
    }

    async function handleRoleChange(membershipId: Id<"orgMembers">, role: Role) {
        setActionError(null);
        try {
            await updateRole({ membershipId: membershipId, role: role });
        } catch (err) {
            setActionError(err instanceof Error ? err.message : "Role change failed");
        }
    }

    async function handleRemove(membershipId: Id<"orgMembers">) {
        setActionError(null);
        try {
            await remove({ membershipId: membershipId });
        } catch (err) {
            setActionError(err instanceof Error ? err.message : "Remove failed");
        }
    }

    return (
        <div className="grid gap-10">
            <Section title="Invite member" description="Add an existing user to this organization by email.">
                <div className="grid gap-3">
                    <div className="grid gap-1">
                        <Label htmlFor="invite-email" className="text-xs text-muted-foreground">Email</Label>
                        <div className="flex items-center gap-2">
                            <Input
                                id="invite-email"
                                type="email"
                                placeholder="user@example.com"
                                value={inviteEmail}
                                onChange={(e) => setInviteEmail(e.target.value)}
                                className="flex-1"
                            />
                            <Select
                                value={inviteRole}
                                onValueChange={(v) => setInviteRole(v as Exclude<Role, "owner">)}
                            >
                                <SelectTrigger className="w-28 cursor-pointer">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="member" className="cursor-pointer">Member</SelectItem>
                                    <SelectItem value="admin" className="cursor-pointer">Admin</SelectItem>
                                </SelectContent>
                            </Select>
                            <Button
                                size="sm"
                                className="cursor-pointer disabled:cursor-not-allowed"
                                disabled={inviting || !inviteEmail.trim()}
                                onClick={handleInvite}
                            >
                                {inviting ? "Adding..." : "Add"}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            The user must have signed in at least once before they can be added.
                        </p>
                        {inviteError && <p className="text-xs text-destructive">{inviteError}</p>}
                        {inviteNotice && <p className="text-xs text-muted-foreground">{inviteNotice}</p>}
                    </div>
                </div>
            </Section>

            <Section title="Members" description="Owners can manage roles and remove members. The owner cannot be removed.">
                {members === undefined ? (
                    <p className="text-sm text-muted-foreground">Loading...</p>
                ) : members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No members yet.</p>
                ) : (
                    <div className="grid gap-2">
                        {members.map((m) => {
                            const initials = m.name.split(" ").filter(Boolean).map((s) => s[0]).slice(0, 2).join("").toUpperCase();

                            return (
                                <div
                                    key={m.membershipId}
                                    className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
                                >
                                    <Avatar size="sm">
                                        {m.avatarUrl && <AvatarImage src={m.avatarUrl} alt={m.name} />}
                                        <AvatarFallback className="bg-muted text-[10px] font-medium text-muted-foreground">
                                            {initials || "?"}
                                        </AvatarFallback>
                                    </Avatar>
                                    <div className="flex-1 min-w-0">
                                        <p className="truncate text-sm font-medium text-foreground">{m.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                                    </div>
                                    {m.isOwner ? (
                                        <Badge variant="secondary" className="text-xs uppercase">
                                            {ROLE_LABEL.owner}
                                        </Badge>
                                    ) : (
                                        <Select
                                            value={m.role}
                                            onValueChange={(v) => handleRoleChange(m.membershipId, v as Role)}
                                        >
                                            <SelectTrigger className="w-28 cursor-pointer">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="member" className="cursor-pointer">Member</SelectItem>
                                                <SelectItem value="admin" className="cursor-pointer">Admin</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    )}
                                    {!m.isOwner && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="cursor-pointer text-muted-foreground hover:text-destructive"
                                            onClick={() => handleRemove(m.membershipId)}
                                            aria-label="Remove member"
                                        >
                                            <Trash2 className="size-3.5" />
                                        </Button>
                                    )}
                                </div>
                            );
                        })}
                        {actionError && <p className="text-xs text-destructive">{actionError}</p>}
                    </div>
                )}
            </Section>
        </div>
    );
}
