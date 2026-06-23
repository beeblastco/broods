"use client";

/** One-time banner that surfaces a freshly-provisioned fp_acct_ secret with copy and dismiss controls. */
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { Check, Copy, KeyRound, X } from "lucide-react";
import { useState } from "react";

interface Props {
    /** The one-time plaintext secret to display; the banner renders nothing when empty. */
    secret: string;
    /** Called when the user dismisses the banner. */
    onDismiss: () => void;
    /** Optional extra classes for the full-width outer wrapper (vertical spacing only). */
    className?: string;
}

/** Dismissible card warning the user to save a one-time account secret before it disappears. */
export function OnboardingSecretBanner({ secret, onDismiss, className }: Props) {
    const [copied, setCopied] = useState(false);

    function copy() {
        navigator.clipboard.writeText(secret);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <div className={cn("w-full px-4", className)}>
            <div className="relative mx-auto flex max-w-2xl flex-col gap-4 rounded-xl border bg-card px-5 py-4 shadow-sm">
                <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={onDismiss}
                    className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                >
                    <X className="size-4" />
                </button>

                <div className="flex items-start gap-3 pr-7">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                        <KeyRound className="size-4 text-foreground" />
                    </div>
                    <div className="space-y-1">
                        <p className="text-sm font-semibold text-foreground">
                            Your account is ready — save your API secret
                        </p>
                        <p className="text-xs text-muted-foreground">
                            This is the only time this secret will be shown. Store it somewhere safe
                            now — it cannot be recovered, only rotated.
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <Input readOnly value={secret} className="h-9 font-mono text-xs" />
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-9 shrink-0 cursor-pointer"
                        onClick={copy}
                    >
                        {copied ? (
                            <Check className="size-3.5 mr-1" />
                        ) : (
                            <Copy className="size-3.5 mr-1" />
                        )}
                        {copied ? "Copied" : "Copy"}
                    </Button>
                </div>
            </div>
        </div>
    );
}
