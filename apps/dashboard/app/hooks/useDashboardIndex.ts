"use client";

/**
 * Everything the palette and the copilot can find, as one list of rows.
 *
 * All of it comes from queries the dashboard already subscribes to, so opening
 * the palette costs no round trip: Convex serves the cached documents and the
 * rows re-rank as they change.
 */
import { NAV_ITEMS, navHref } from "@/app/lib/navigation";
import type { SearchItem } from "@/app/lib/paletteSearch";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { usePathname } from "next/navigation";
import { useMemo } from "react";

export function useDashboardIndex(
  projectId: Id<"projects"> | null,
  stageId: Id<"stages"> | null,
): readonly SearchItem[] {
  const pathname = usePathname();
  const projectArgs = projectId ? { projectId: projectId } : "skip";
  const stageArgs =
    projectId && stageId ? { projectId: projectId, stageId: stageId } : "skip";

  const canvas = useQuery(api.canvas.getByProject, stageArgs);
  const crons = useQuery(api.agent.crons.listForProject, projectArgs);
  const envVars = useQuery(api.environmentVariables.list, stageArgs);
  const projects = useQuery(api.project.list, {});
  const stages = useQuery(api.stage.list, projectArgs);

  return useMemo(() => {
    if (!projectId) return [];
    const items: SearchItem[] = [];

    for (const item of NAV_ITEMS) {
      items.push({
        group: "Go to",
        id: `page:${item.segment}`,
        keywords: item.keywords,
        target: {
          href: navHref(projectId, item.segment, stageId),
          type: "navigate",
        },
        title: item.label,
      });
    }

    for (const node of canvas?.nodes ?? []) {
      const label =
        typeof node.data.label === "string" ? node.data.label : node.id;
      items.push({
        detail: node.type,
        group: "Nodes",
        id: `node:${node.id}`,
        keywords: [node.type],
        target: { nodeId: node.id, type: "openNode" },
        title: label,
      });
    }

    for (const cron of crons ?? []) {
      items.push({
        detail: `${cron.scheduleExpression} · ${cron.status}`,
        group: "Crons",
        id: `cron:${cron._id}`,
        keywords: ["cron", "schedule", cron.status],
        target: {
          href: navHref(projectId, "/scheduler", stageId),
          type: "navigate",
        },
        title: cron.name,
      });
    }

    for (const envVar of envVars ?? []) {
      items.push({
        detail: "env var",
        group: "Config",
        id: `env:${envVar._id}`,
        keywords: ["environment", "variable", "secret"],
        target: {
          href: navHref(projectId, "/settings", stageId),
          type: "navigate",
        },
        title: envVar.name,
      });
    }

    // Switching stage keeps you on the page you are on; only the param moves.
    for (const stage of stages ?? []) {
      items.push({
        detail: stage.kind,
        group: "Stages",
        id: `stage:${stage._id}`,
        keywords: ["stage", "environment"],
        target: { href: `${pathname}?stage=${stage._id}`, type: "navigate" },
        title: stage.name,
      });
    }

    for (const project of projects ?? []) {
      if (project._id === projectId) continue;
      items.push({
        detail: "project",
        group: "Projects",
        id: `project:${project._id}`,
        keywords: ["project", project.slug],
        target: { href: `/${project._id}`, type: "navigate" },
        title: project.name,
      });
    }

    return items;
  }, [canvas, crons, envVars, pathname, projectId, projects, stageId, stages]);
}
