"use client";

/**
 * Billing & Plan panel — displays the user's current subscription and
 * provides Stripe Checkout / Customer Portal flows for upgrades.
 */
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Section } from "@/app/components/Section";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { AlertTriangle, ArrowUpRight, CreditCard, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { ConfiguredPlanTier, PlanTier } from "@/app/lib/pricing";
import { isMaxPlan, PLAN_CONFIGS, resolvePlan } from "@/app/lib/pricing";
import { toErrorMessage } from "@/app/lib/errors";

interface Props {
    projectId: Id<"projects">;
}

/** Convert a Unix epoch (seconds) to a readable date string. */
function formatPeriodEnd(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toLocaleDateString([], {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
}

export function BillingPanel({ projectId }: Props) {
    const [checkoutLoading, setCheckoutLoading] = useState(false);
    const [portalLoading, setPortalLoading] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    const currentUser = useQuery(api.user.getCurrent);
    const billingInfo = useQuery(api.stripe.getBillingInfo);
    const createCheckoutSession = useAction(api.stripe.createCheckoutSession);
    const createPortalSession = useAction(api.stripe.createPortalSession);

    const userPlan: ConfiguredPlanTier = resolvePlan(currentUser?.plan as PlanTier | undefined);
    const planConfig = PLAN_CONFIGS[userPlan];
    const onMaxPlan = isMaxPlan(userPlan);

    const isSubscribed =
        billingInfo?.status === "active" ||
        billingInfo?.status === "trialing";

    async function handleUpgrade() {
        setCheckoutLoading(true);
        setActionError(null);
        try {
            const origin = window.location.origin;
            const returnPath = `/${projectId}/dashboard?tab=billing`;
            const { url } = await createCheckoutSession({
                successUrl: `${origin}${returnPath}&success=true`,
                cancelUrl: `${origin}${returnPath}`,
            });
            window.location.href = url;
        } catch (err) {
            setActionError(toErrorMessage(err));
            setCheckoutLoading(false);
        }
    }

    async function handlePortal() {
        setPortalLoading(true);
        setActionError(null);
        try {
            const origin = window.location.origin;
            const { url } = await createPortalSession({
                returnUrl: `${origin}/${projectId}/dashboard?tab=billing`,
            });
            window.location.href = url;
        } catch (err) {
            setActionError(toErrorMessage(err));
            setPortalLoading(false);
        }
    }

    const RATE_LIMITS: Array<{ label: string; current: number; limit: number; unit: string }> = userPlan === "pro"
        ? [
            { label: "Requests per minute", current: 0, limit: 500, unit: "rpm" },
            { label: "Tokens per minute", current: 0, limit: 200000, unit: "tpm" },
            { label: "Concurrent agents", current: 0, limit: 100, unit: "agents" },
        ]
        : [
            { label: "Requests per minute", current: 0, limit: 60, unit: "rpm" },
            { label: "Tokens per minute", current: 0, limit: 40000, unit: "tpm" },
            { label: "Concurrent agents", current: 0, limit: 5, unit: "agents" },
        ];

    return (
        <div className="grid gap-8">
            {/* Current plan */}
            <Section title="Current Plan" description="Your active subscription and included resources.">
                <div className="rounded-lg border border-border bg-card">
                    <div className="flex items-center justify-between border-b border-border px-4 py-3">
                        <div>
                            <p className="text-sm font-medium text-foreground">{planConfig.label} Plan</p>
                            <p className="text-xs text-muted-foreground">
                                {isSubscribed ? "Monthly billing via Stripe" : "Free tier"}
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <Badge className={planConfig.badgeClass}>{planConfig.label}</Badge>
                            {isSubscribed && <Badge variant="success">Active</Badge>}
                        </div>
                    </div>

                    {billingInfo?.currentPeriodEnd && (
                        <div className="flex items-center justify-between border-b border-border px-4 py-3">
                            <span className="text-xs text-muted-foreground">
                                {billingInfo.cancelAtPeriodEnd ? "Cancels on" : "Renews on"}
                            </span>
                            <span className="text-sm text-foreground">
                                {formatPeriodEnd(billingInfo.currentPeriodEnd)}
                            </span>
                        </div>
                    )}

                    <div className="flex items-center justify-between px-4 py-3">
                        <span className="text-xs text-muted-foreground">Status</span>
                        <span className="text-sm text-foreground capitalize">
                            {billingInfo?.status ?? "Free"}
                        </span>
                    </div>
                </div>

                {actionError && (
                    <p className="text-sm text-destructive">{actionError}</p>
                )}

                <div className="flex items-center gap-2 justify-end">
                    {isSubscribed && (
                        <Button
                            size="sm"
                            variant="outline"
                            className="cursor-pointer gap-1.5"
                            onClick={handlePortal}
                            disabled={portalLoading}
                        >
                            <CreditCard className="size-3.5" />
                            {portalLoading ? "Loading…" : "Manage Billing"}
                        </Button>
                    )}
                    {!onMaxPlan && (
                        <Button
                            size="sm"
                            className="cursor-pointer gap-1.5"
                            onClick={handleUpgrade}
                            disabled={checkoutLoading}
                        >
                            <ArrowUpRight className="size-3.5" />
                            {checkoutLoading ? "Loading…" : "Upgrade to Pro"}
                        </Button>
                    )}
                </div>
            </Section>

            {/* Plan limits */}
            <Section title="Plan Limits" description="Resource limits for your current plan tier.">
                <div className="grid gap-3">
                    {RATE_LIMITS.map((limit) => {
                        const pct = limit.limit > 0 ? Math.round((limit.current / limit.limit) * 100) : 0;
                        const isWarning = pct >= 80;
                        return (
                            <div key={limit.label} className="rounded-lg border border-border bg-card px-4 py-3">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-sm text-foreground">{limit.label}</span>
                                    <span className="text-sm font-mono text-muted-foreground">
                                        {limit.current.toLocaleString()} / {limit.limit.toLocaleString()} {limit.unit}
                                    </span>
                                </div>
                                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                                    <div
                                        className={`h-full rounded-full ${isWarning ? "bg-amber-500" : "bg-primary"}`}
                                        style={{ width: `${Math.max(pct, 1)}%` }}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            </Section>

            {/* Upgrade prompt for free users */}
            {!onMaxPlan && (
                <Section title="Upgrade to Pro" description="Unlock higher limits and priority support.">
                    <div className="rounded-lg border border-border bg-card p-4">
                        <div className="grid gap-2 mb-4">
                            {[
                                "500 rpm (vs 60 rpm on Hobby)",
                                "200k tokens per minute",
                                "Up to 100 concurrent agents",
                                "Priority support",
                            ].map((feature) => (
                                <div key={feature} className="flex items-center gap-2">
                                    <div className="size-1.5 rounded-full bg-primary shrink-0" />
                                    <span className="text-sm text-foreground">{feature}</span>
                                </div>
                            ))}
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                size="sm"
                                className="cursor-pointer gap-1.5"
                                onClick={handleUpgrade}
                                disabled={checkoutLoading}
                            >
                                <ArrowUpRight className="size-3.5" />
                                {checkoutLoading ? "Loading…" : "Upgrade Now"}
                            </Button>
                            <Button size="sm" variant="ghost" className="cursor-pointer gap-1.5" asChild>
                                <a href="https://beeblast.co/pricing" target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="size-3.5" />
                                    View pricing
                                </a>
                            </Button>
                        </div>
                    </div>
                </Section>
            )}

            {/* Warning for approaching limits (placeholder — hook up real usage when tracked) */}
            {false && (
                <Section title="Usage Alerts" description="Notifications about usage thresholds.">
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                        <div className="flex items-start gap-3">
                            <AlertTriangle className="size-4 text-amber-500 mt-0.5 shrink-0" />
                            <div>
                                <p className="text-sm font-medium text-foreground">Approaching token limit</p>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                    Your token usage is approaching the monthly limit. Consider upgrading.
                                </p>
                            </div>
                        </div>
                    </div>
                </Section>
            )}
        </div>
    );
}
