// The copilot's fast path: asks answerable from what is on screen, planned without a model.
import {
  NODE_TEMPLATES,
  NODE_TYPE_SHORTCUTS,
} from "@/app/components/canvas/nodeTemplates";
import type { CopilotAction, CopilotPlan } from "@/app/lib/copilotActions";
import { rankItems, type SearchItem } from "@/app/lib/paletteSearch";
import { SHORTCUTS, type ShortcutId } from "@/app/lib/shortcuts";

const NAVIGATION_VERBS =
  /^(go to|goto|open|show me|show|jump to|take me to)\s+/i;

const BLOCKED_VERBS =
  /\b(deploy|promote|delete|destroy|drop|rotate|revoke|uninstall)\b/i;

const CANVAS_VERB_COMMANDS: Record<string, ShortcutId> = {
  fit: "canvas.fitView",
  tidy: "canvas.tidy",
};

export interface CopilotCron {
  id: string;
  name: string;
  status: "active" | "paused";
}

export interface CopilotContext {
  crons: readonly CopilotCron[];
  envNames: readonly string[];
  items: readonly SearchItem[];
  liveCommands: ReadonlySet<string>;
}

export function planFromQuery(
  query: string,
  context: CopilotContext,
): CopilotPlan | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const blocked = BLOCKED_VERBS.exec(trimmed);
  if (blocked) {
    return {
      actions: [
        {
          label: `Cannot ${blocked[1].toLowerCase()} from here`,
          reason:
            "Deploys, deletions and key rotations stay in your hands. I can take you to the page that does it.",
          type: "blocked",
        },
      ],
      summary: `I will not ${blocked[1].toLowerCase()} anything on my own.`,
    };
  }

  return (
    planEnvVar(trimmed, context) ??
    planCronStatus(trimmed, context) ??
    planCommand(trimmed, context) ??
    planLookup(trimmed, context)
  );
}

export function itemAction(item: SearchItem): CopilotAction {
  switch (item.target.type) {
    case "navigate":
      return {
        href: item.target.href,
        label: `Go to ${item.title}`,
        type: "navigate",
      };
    case "openNode":
      return {
        label: `Open ${item.title}`,
        nodeId: item.target.nodeId,
        type: "openNode",
      };
    case "command":
      return {
        commandId: item.target.commandId,
        label: item.title,
        type: "command",
      };
  }
}

function planCommand(
  query: string,
  context: CopilotContext,
): CopilotPlan | null {
  const added =
    /\badd\s+(?:an?\s+)?(agent|sandbox|workspace|skill|mcp)\b/i.exec(query);
  const addedType = NODE_TEMPLATES.find(
    (template) => template.type === added?.[1].toLowerCase(),
  )?.type;
  const commandId = addedType
    ? NODE_TYPE_SHORTCUTS[addedType]
    : CANVAS_VERB_COMMANDS[
        /\b(tidy|fit)\b/i.exec(query)?.[1].toLowerCase() ?? ""
      ];

  if (!commandId || !context.liveCommands.has(commandId)) return null;

  const command = SHORTCUTS.find((shortcut) => shortcut.id === commandId);
  if (!command) return null;

  return {
    actions: [{ commandId: commandId, label: command.label, type: "command" }],
    summary: command.label,
  };
}

function planCronStatus(
  query: string,
  context: CopilotContext,
): CopilotPlan | null {
  const match = /^(pause|disable|resume|enable|unpause)\s+(.+)$/i.exec(query);
  if (!match) return null;

  const wantsPause = /^(pause|disable)$/i.test(match[1]);
  const name = match[2].replace(/\bcron\b/gi, "").trim();
  const cron = context.crons.find((entry) =>
    entry.name.toLowerCase().includes(name.toLowerCase()),
  );
  if (!cron) return null;

  const status = wantsPause ? "paused" : "active";
  if (cron.status === status) {
    return {
      actions: [],
      summary: `${cron.name} is already ${status}.`,
    };
  }

  return {
    actions: [
      {
        change: { after: status, before: cron.status, field: "status" },
        cronId: cron.id,
        label: `${wantsPause ? "Pause" : "Resume"} ${cron.name}`,
        status: status,
        type: "setCronStatus",
      },
    ],
    summary: `${wantsPause ? "Pausing" : "Resuming"} ${cron.name}. It stops after the current run finishes.`,
  };
}

function planEnvVar(
  query: string,
  context: CopilotContext,
): CopilotPlan | null {
  const match = /^set\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\bto\b)\s*(.+)$/i.exec(
    query,
  );
  if (!match) return null;

  const name = match[1].toUpperCase();
  const value = match[2].trim().replace(/^["']|["']$/g, "");
  const exists = context.envNames.includes(name);

  return {
    actions: [
      {
        change: {
          after: value,
          before: exists ? "set, hidden" : "not set",
          field: name,
        },
        label: `Set ${name} on this stage`,
        name: name,
        type: "setEnvVar",
        value: value,
      },
    ],
    summary: `${name} applies to this stage only. Running agents pick it up on their next start.`,
  };
}

function planLookup(
  query: string,
  context: CopilotContext,
): CopilotPlan | null {
  const stripped = query.replace(NAVIGATION_VERBS, "").trim();
  const wasNavigation = stripped !== query;
  const best = rankItems(context.items, stripped)
    .flatMap((group) => group.items)
    .at(0);

  // A sentence with no verb we know is a question for the model, not a command.
  if (!best || (!wasNavigation && stripped.includes(" "))) return null;

  const action = itemAction(best);

  return { actions: [action], summary: action.label };
}
