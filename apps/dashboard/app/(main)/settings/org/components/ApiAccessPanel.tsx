"use client";

/**
 * Org API access panel: provision a filthy-panty account for the org, show
 * its accountId + base URL, and rotate the Bearer secret. The plaintext is
 * shown exactly once after provision/rotate because only the hash is stored.
 */

import { Section } from "@/app/components/Section";
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
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useState } from "react";

interface Props {
    /** The org this panel is rendering settings for. */
    org: Doc<"orgs">;
}

const MASKED_SECRET = "••••••••••••••••••••••••••••";

export function ApiAccessPanel({ org }: Props) {
    const account = useQuery(api.org.getActiveAccount, {});
    const provision = useAction(api.orgLifecycle.provision);
    const rotate = useAction(api.orgLifecycle.rotateSecret);

    const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
    const [showSecret, setShowSecret] = useState(false);
    const [rotateOpen, setRotateOpen] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    const harnessUrl = process.env.NEXT_PUBLIC_FILTHY_PANTY_HARNESS_URL ?? "(set FILTHY_PANTY_HARNESS_URL)";

    async function handleProvision() {
        setPending(true);
        setError(null);
        try {
            const result = await provision({ orgId: org._id });
            setRevealedSecret(result.secret);
            setShowSecret(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Provision failed");
        } finally {
            setPending(false);
        }
    }

    async function handleRotate() {
        setPending(true);
        setError(null);
        try {
            const result = await rotate({ orgId: org._id });
            setRevealedSecret(result.secret);
            setShowSecret(true);
            setRotateOpen(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Rotate failed");
        } finally {
            setPending(false);
        }
    }

    function copy(text: string, label: string) {
        navigator.clipboard.writeText(text);
        setCopied(label);
        setTimeout(() => setCopied(null), 1500);
    }

    if (account === undefined) {
        return (
            <Section title="API Access" description="Filthy-panty service credentials for this org.">
                <p className="text-sm text-muted-foreground">Loading...</p>
            </Section>
        );
    }

    if (account === null) {
        return (
            <Section title="API Access" description="Filthy-panty service credentials for this org.">
                <div className="rounded-lg border border-border bg-card px-4 py-6">
                    <p className="text-sm text-foreground">
                        This organization is not yet provisioned with a filthy-panty account.
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Provisioning creates the backend tenant and issues a one-time Bearer
                        secret. Save the secret — it will not be shown again.
                    </p>
                    {error && (
                        <p className="mt-2 text-xs text-destructive">{error}</p>
                    )}
                    <Button
                        size="sm"
                        className="mt-4 cursor-pointer disabled:cursor-not-allowed"
                        disabled={pending}
                        onClick={handleProvision}
                    >
                        {pending ? "Provisioning..." : "Provision filthy-panty account"}
                    </Button>
                </div>

                {revealedSecret && (
                    <NewSecretDialog
                        secret={revealedSecret}
                        onClose={() => {
                            setRevealedSecret(null);
                            setShowSecret(false);
                        }}
                    />
                )}
            </Section>
        );
    }

    return (
        <Section title="API Access" description="Filthy-panty service credentials for this org.">
            <div className="grid gap-4">
                <div className="grid gap-1">
                    <Label className="text-xs text-muted-foreground">Account ID</Label>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs">
                            {account.accountId}
                        </code>
                        <Button
                            variant="outline"
                            size="sm"
                            className="cursor-pointer"
                            onClick={() => copy(account.accountId, "accountId")}
                        >
                            <Copy className="size-3.5 mr-1" />
                            {copied === "accountId" ? "Copied" : "Copy"}
                        </Button>
                    </div>
                </div>

                <div className="grid gap-1">
                    <Label className="text-xs text-muted-foreground">Base URL</Label>
                    <code className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
                        {harnessUrl}
                    </code>
                </div>

                <div className="grid gap-1">
                    <Label className="text-xs text-muted-foreground">Bearer secret</Label>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs">
                            {revealedSecret && showSecret ? revealedSecret : MASKED_SECRET}
                        </code>
                        {revealedSecret && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="cursor-pointer"
                                onClick={() => setShowSecret((v) => !v)}
                            >
                                {showSecret ? (
                                    <EyeOff className="size-3.5" />
                                ) : (
                                    <Eye className="size-3.5" />
                                )}
                            </Button>
                        )}
                        {revealedSecret && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="cursor-pointer"
                                onClick={() => copy(revealedSecret, "secret")}
                            >
                                <Copy className="size-3.5 mr-1" />
                                {copied === "secret" ? "Copied" : "Copy"}
                            </Button>
                        )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Secrets are hashed at rest. Rotate to issue a new one — this invalidates
                        the previous secret immediately.
                    </p>
                </div>

                <div className="flex items-center justify-between border-t border-border pt-4">
                    <div>
                        <p className="text-sm font-medium text-foreground">Rotate secret</p>
                        <p className="text-xs text-muted-foreground">
                            The previous Bearer token will stop working.
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        className="cursor-pointer disabled:cursor-not-allowed"
                        disabled={pending}
                        onClick={() => setRotateOpen(true)}
                    >
                        <RefreshCw className="size-3.5 mr-1" />
                        Rotate
                    </Button>
                </div>

                {error && <p className="text-xs text-destructive">{error}</p>}
            </div>

            <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Rotate Bearer secret?</DialogTitle>
                        <DialogDescription>
                            The current Bearer token will stop working immediately. Anything
                            using it (curl scripts, integrations) must be updated.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            className="cursor-pointer"
                            onClick={() => setRotateOpen(false)}
                            disabled={pending}
                        >
                            Cancel
                        </Button>
                        <Button
                            className="cursor-pointer disabled:cursor-not-allowed"
                            onClick={handleRotate}
                            disabled={pending}
                        >
                            {pending ? "Rotating..." : "Rotate now"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {revealedSecret && (
                <NewSecretDialog
                    secret={revealedSecret}
                    onClose={() => {
                        setRevealedSecret(null);
                        setShowSecret(false);
                    }}
                />
            )}
        </Section>
    );
}

/** One-shot dialog that displays a newly-issued secret. */
function NewSecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
    const [open, setOpen] = useState(true);
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) {
                    setOpen(false);
                    onClose();
                }
            }}
        >
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Save your new Bearer secret</DialogTitle>
                    <DialogDescription>
                        Copy this token now — it will not be shown again.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 py-2">
                    <Input
                        readOnly
                        value={secret}
                        className="font-mono text-xs"
                    />
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        className="cursor-pointer"
                        onClick={() => navigator.clipboard.writeText(secret)}
                    >
                        <Copy className="size-4 mr-1" />
                        Copy
                    </Button>
                    <Button
                        className="cursor-pointer"
                        onClick={() => {
                            setOpen(false);
                            onClose();
                        }}
                    >
                        Done
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
