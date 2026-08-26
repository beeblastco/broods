"use client";

/**
 * Skills tab (ticket 16 — honest read-only shell; ticket 17 adds the library
 * management). Shows exactly what the agent's `skills.allowed` really
 * contains, cross-referenced against the account's actual skill library, and
 * flags entries that don't resolve to a real skill.
 */

import {
  readAgentBranch,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { matchesSkillRef } from "@/app/lib/skillRefs";
import { api } from "@broods/convex/_generated/api";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { AlertTriangle, BookOpen } from "lucide-react";
import { useMemo } from "react";

interface SkillsBranch extends Record<string, unknown> {
  enabled?: boolean;
  allowed?: string[];
}

export function AgentSkillsTab({
  agentConfig,
}: {
  agentConfig: Doc<"agentConfigs"> | null | undefined;
}): React.JSX.Element {
  const librarySkills = useQuery(api.skillsLibraryPublic.list, {});

  const allowed = useMemo(() => {
    const branch = readAgentBranch<SkillsBranch>(
      agentConfig as FlatAgentConfig | undefined,
      "skills",
    );

    return Array.isArray(branch.allowed) ? branch.allowed : [];
  }, [agentConfig]);

  const rows = useMemo(
    () =>
      allowed.map((ref) => {
        const skill = (librarySkills ?? []).find((entry) =>
          matchesSkillRef(ref, entry.name),
        );

        return { ref: ref, skill: skill ?? null };
      }),
    [allowed, librarySkills],
  );

  if (agentConfig === undefined || librarySkills === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-xs text-muted-foreground">Loading skills…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Skills this agent has on
        </span>
        <p className="text-[11px] text-muted-foreground">
          Skills are instructions the agent can load to do a job your way.
        </p>
      </div>

      {rows.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-4">
          <p className="text-xs text-muted-foreground">
            No skills yet. Soon you&apos;ll be able to create skills here — or
            simply ask the agent to learn something in the Agent tab — and
            they&apos;ll show up in this list.
          </p>
        </div>
      )}

      {rows.map(({ ref, skill }) => (
        <div
          key={ref}
          className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5"
        >
          {skill ? (
            <BookOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          )}
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-xs font-medium text-foreground">
              {skill?.name ?? ref}
            </span>
            {skill?.description && (
              <span className="text-[11px] text-muted-foreground">
                {skill.description}
              </span>
            )}
            {!skill && (
              <span className="text-[11px] text-amber-600 dark:text-amber-400">
                This name doesn&apos;t match any skill in your library.
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
