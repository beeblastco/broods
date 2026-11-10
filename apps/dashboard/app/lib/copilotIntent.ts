// The copilot's fast path: asks answerable from what is on screen, planned without a model.
import {
  NODE_TEMPLATES,
  NODE_TYPE_SHORTCUTS,
} from "@/app/components/canvas/nodeTemplates";
import { itemAction, type CopilotPlan } from "@/app/lib/copilotActions";
import { rankItems, type SearchItem } from "@/app/lib/paletteSearch";
import { SHORTCUTS, type ShortcutId } from "@/app/lib/shortcuts";

const NAVIGATION_VERBS =
  /^(go to|goto|open|show me|show|jump to|take me to)\s+/i;

const BLOCKED_VERBS =
  /\b(deploy|promote|delete|destroy|drop|rotate|revoke|uninstall)\b/i;

// A skill needs a source picked on the canvas, so the dock does not add one.
const ATTACHED_TYPES = ["sandbox", "workspace"] as const;

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
  /** Labels of nodes code owns; the canvas cannot wire them. */
  lockedNodes?: ReadonlySet<string>;
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
    planAddMcp(trimmed, context) ??
    planAddNode(trimmed, context) ??
    planConnect(trimmed, context) ??
    planCronStatus(trimmed, context) ??
    planCommand(trimmed, context) ??
    planLookup(trimmed, context)
  );
}

// `add mcp <name> at <url> [to <agent>]`: a server with its address, wired to an agent.
function planAddMcp(
  query: string,
  context: CopilotContext,
): CopilotPlan | null {
  const match =
    /^add\s+(?:an?\s+)?mcp(?:\s+server)?\s+([\w-]+)\s+at\s+(https:\/\/\S+?)(?:\s+(?:to|for|on)\s+(.+))?$/i.exec(
      query,
    );
  if (!match) return null;
  const agent = match[3] ? findNode(context, match[3]) : undefined;
  if (match[3] && agent?.detail !== "agent") {
    return {
      actions: [
        {
          label: `Add MCP ${match[1]} to ${match[3]}`,
          reason: `${match[3]} is not an agent on this canvas.`,
          type: "blocked",
        },
      ],
      summary: `${match[3]} is not an agent.`,
    };
  }
  if (agent && context.lockedNodes?.has(agent.title)) {
    return lockedPlan(agent.title, `Add MCP ${match[1]} to ${agent.title}`);
  }

  return {
    actions: [
      {
        ...(agent ? { agent: agent.title } : {}),
        change: {
          after: match[2],
          before: "not on the canvas",
          field: match[1],
        },
        label: `Add MCP ${match[1]}${agent ? ` to ${agent.title}` : ""}`,
        name: match[1],
        type: "addMcp",
        url: match[2],
      },
    ],
    summary: `Adds ${match[1]} and checks its tools.`,
  };
}

// `add <sandbox|workspace> to <agent>`: a new node that lands wired to that agent.
function planAddNode(
  query: string,
  context: CopilotContext,
): CopilotPlan | null {
  const match =
    /^add\s+(?:an?\s+|another\s+|a\s+new\s+)?(sandbox|workspace)(?:\s+node)?\s+(?:to|for|on)\s+(.+)$/i.exec(
      query,
    );
  const nodeType = ATTACHED_TYPES.find(
    (type) => type === match?.[1].toLowerCase(),
  );
  if (!match || !nodeType) return null;
  const label = `Add a ${nodeType} to ${match[2]}`;
  const agent = findNode(context, match[2]);
  if (agent?.detail !== "agent") {
    return {
      actions: [
        {
          label: label,
          reason: `${match[2]} is not an agent on this canvas.`,
          type: "blocked",
        },
      ],
      summary: `${match[2]} is not an agent.`,
    };
  }
  if (context.lockedNodes?.has(agent.title)) {
    return lockedPlan(agent.title, `Add a ${nodeType} to ${agent.title}`);
  }

  return {
    actions: [
      {
        agent: agent.title,
        label: `Add a ${nodeType} to ${agent.title}`,
        nodeType: nodeType,
        type: "addNode",
      },
    ],
    summary: `Adds a ${nodeType} wired to ${agent.title}.`,
  };
}

// `connect <a> to <b>`: the agent end is always the source, as a drag would draw it.
function planConnect(
  query: string,
  context: CopilotContext,
): CopilotPlan | null {
  const match = /^connect\s+(.+?)\s+(?:to|with)\s+(.+)$/i.exec(query);
  if (!match) return null;
  const first = findNode(context, match[1]);
  const second = findNode(context, match[2]);
  if (!first || !second || first === second) return null;
  const [source, target] =
    second.detail === "agent" && first.detail !== "agent"
      ? [second, first]
      : [first, second];
  const locked = [source, target].find((node) =>
    context.lockedNodes?.has(node.title),
  );
  if (locked) {
    return lockedPlan(
      locked.title,
      `Connect ${source.title} to ${target.title}`,
    );
  }

  return {
    actions: [
      {
        label: `Connect ${source.title} to ${target.title}`,
        source: source.title,
        target: target.title,
        type: "connectNodes",
      },
    ],
    summary: `Connect ${source.title} to ${target.title}.`,
  };
}

function lockedPlan(node: string, label: string): CopilotPlan {
  return {
    actions: [
      {
        label: label,
        reason: `${node} is defined in code, so the canvas cannot change it. Change its broods/ files.`,
        type: "blocked",
      },
    ],
    summary: `${node} is defined in code.`,
  };
}

function findNode(
  context: CopilotContext,
  name: string,
): SearchItem | undefined {
  const wanted = name
    .trim()
    .replace(/^(the|an?)\s+/i, "")
    .toLowerCase();

  return context.items.find(
    (item) => item.group === "Nodes" && item.title.toLowerCase() === wanted,
  );
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
