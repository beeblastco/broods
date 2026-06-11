"use client";

/**
 * Tracing panel — execution traces are now queried directly from CloudWatch Logs.
 * Use the Monitoring panel to view logs, or query CloudWatch for detailed traces.
 */
import { Section } from "@/app/components/Section";

export function TracingPanel() {
    return (
        <Section
            title="Execution Traces"
            description="Trace data is now queried directly from CloudWatch Logs."
        >
            <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                    Execution traces are no longer stored in the application database.
                </p>
                <p className="text-xs text-muted-foreground mt-2">
                    Query CloudWatch Logs directly for detailed execution traces, request IDs, and error correlation.
                </p>
            </div>
        </Section>
    );
}
