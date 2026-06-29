"use client";

/**
 * Renders the live instances' non-secret policy posture for the Security and
 * Networking views. The policy (tool-approval mode / egress mode) is configured on
 * the sandbox config and mirrored onto each instance row by broods; this view is
 * read-only — edit the policy on the sandbox config (architecture canvas / CLI).
 */

import type { Doc } from "@broods/convex/_generated/dataModel";
import { egressBadge, instanceStatusBadge, permissionModeBadge } from "./sandboxFormat";

interface Props {
    /** Sandbox instance rows from Convex. */
    instances: Array<Doc<"sandboxInstances">>;
    /** Which policy dimension to surface. */
    dimension: "security" | "networking";
}

const COPY = {
    security: {
        column: "Permission mode",
        note: "Tool-approval policy enforced per sandbox (edit applies, ask prompts, bypass skips checks). Set it on the sandbox config.",
    },
    networking: {
        column: "Egress",
        note: "Outbound network policy per sandbox (deny-all blocks egress, restricted allowlists, allow-all opens the internet). Set it on the sandbox config.",
    },
} as const;

export function SandboxPolicyTable({ instances, dimension }: Props) {
    const copy = COPY[dimension];

    if (instances.length === 0) {
        return (
            <div className="rounded-lg border border-border bg-card px-4 py-10 text-center">
                <p className="text-sm text-foreground">No running sandbox instances.</p>
                <p className="mt-1 text-xs text-muted-foreground">{copy.note}</p>
            </div>
        );
    }

    return (
        <>
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
                <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                            <th className="px-4 py-2 text-left font-medium">Name</th>
                            <th className="px-4 py-2 text-left font-medium">Provider</th>
                            <th className="px-4 py-2 text-left font-medium">Status</th>
                            <th className="px-4 py-2 text-left font-medium">{copy.column}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {instances.map((instance) => (
                            <tr key={instance._id} className="border-t border-border">
                                <td className="px-4 py-2.5">
                                    <div className="font-medium text-foreground">{instance.name}</div>
                                    <div className="font-mono text-xs text-muted-foreground">{instance.externalId}</div>
                                </td>
                                <td className="px-4 py-2.5 text-xs">{instance.provider}</td>
                                <td className="px-4 py-2.5">{instanceStatusBadge(instance.status)}</td>
                                <td className="px-4 py-2.5">
                                    {dimension === "security"
                                        ? permissionModeBadge(instance.permissionMode)
                                        : egressBadge(instance.egress)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <p className="mt-2 text-xs text-muted-foreground">{copy.note}</p>
        </>
    );
}
