"use client";

/** Token usage panel — usage tracking removed; query CloudWatch for metrics. */
import { Section } from "@/app/components/Section";

export function TokensUsagePanel() {
    return (
        <Section
            title="Usage Overview"
            description="Token usage tracking is no longer stored in the application database."
        >
            <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                    Token usage and analytics are no longer stored in Convex.
                </p>
                <p className="text-xs text-muted-foreground mt-2">
                    Use CloudWatch metrics or a dedicated observability service (Axiom, Datadog) for token usage analytics.
                </p>
            </div>
        </Section>
    );
}
