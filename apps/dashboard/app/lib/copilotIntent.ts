/**
 * The copilot's fast path: asks it can answer from what is already on screen,
 * turned into a plan without a model round trip. "go to scheduler", "open
 * triage", "pause nightly-digest", "add an agent", "set MAX_RETRIES to 8".
 *
 * Anything it cannot place returns null and goes to the transport. Pure, so the
 * rules are tested rather than guessed at.
 */
import {
  NODE_TEMPLATES,
  NODE_TYPE_SHORTCUTS,
} from "@/app/components/canvas/nodeTemplates";
import type { CopilotAction, CopilotPlan } from "@/app/lib/copilotActions";
import { rankItems, type SearchItem } from "@/app/lib/paletteSearch";
import type { ShortcutId } from "@/app/lib/shortcuts";

/** Verbs that only ever mean "take me there", stripped before the name lookup. */
const NAVIGATION_VERBS =
  /^(go to|goto|open|show me|show|jump to|take me to)\s+/i;

/** Asks the copilot refuses to plan at all, with the word that triggered the refusal. */
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
  /** Bindings the current page has claimed. A command it cannot run is never offered. */
  liveCommands: ReadonlySet<string>;
}

/** A plan for the ask, or null when it needs a model to answer. */
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

/**
 * The one action a matched row stands for. The palette runs its rows through
 * this too, so a row means the same thing wherever you press it.
 */
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
  // Looked up rather than cast: `find` is what narrows the matched word to a
  // card type the canvas actually has.
  const addedType = NODE_TEMPLATES.find(
    (template) => template.type === added?.[1].toLowerCase(),
  )?.type;
  const commandId = addedType
    ? NODE_TYPE_SHORTCUTS[addedType]
    : CANVAS_VERB_COMMANDS[
        /\b(tidy|fit)\b/i.exec(query)?.[1].toLowerCase() ?? ""
      ];

  if (!commandId || !context.liveCommands.has(commandId)) return null;

  const label = added
    ? `Add a ${added[1].toLowerCase()} to the canvas`
    : "Tidy the canvas";

  return {
    actions: [{ commandId: commandId, label: label, type: "command" }],
    summary: label,
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

/** Falls back to the palette's own ranking, so a name means the same thing in both. */
function planLookup(
  query: string,
  context: CopilotContext,
): CopilotPlan | null {
  const stripped = query.replace(NAVIGATION_VERBS, "").trim();
  const wasNavigation = stripped !== query;
  const best = rankItems(context.items, stripped)
    .flatMap((group) => group.items)
    .at(0);

  // A bare word that matches nothing, or a sentence with no verb we know, is a
  // question rather than a command.
  if (!best || (!wasNavigation && stripped.includes(" "))) return null;

  const action = itemAction(best);

  return { actions: [action], summary: action.label };
}
