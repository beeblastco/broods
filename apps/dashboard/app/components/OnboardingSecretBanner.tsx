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
    /** Optional extra classes for the outer container. */
    className?: string;
}

/** Dismissible banner warning the user to save a one-time account secret before it disappears. */
export function OnboardingSecretBanner({ secret, onDismiss, className }: Props) {
    const [copied, setCopied] = useState(false);

    function copy() {
        navigator.clipboard.writeText(secret);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <div
            className={cn(
                "relative flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3",
                className,
            )}
        >
            <button
                type="button"
                aria-label="Dismiss"
                onClick={onDismiss}
                className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            >
                <X className="size-3.5" />
            </button>

            <div className="flex items-center gap-2 pr-6">
                <KeyRound className="size-4 shrink-0 text-primary" />
                <p className="text-sm font-medium text-foreground">
                    Your account is ready — save your API secret
                </p>
            </div>

            <p className="text-xs text-muted-foreground">
                This is the only time this secret will be shown. Store it somewhere safe
                now — it cannot be recovered, only rotated.
            </p>

            <div className="flex items-center gap-2">
                <Input readOnly value={secret} className="font-mono text-xs" />
                <Button
                    variant="outline"
                    size="sm"
                    className="cursor-pointer"
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
    );
}
