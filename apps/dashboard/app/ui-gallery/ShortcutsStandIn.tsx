"use client";

/**
 * The keyboard surfaces, with fixtures where Convex and the router would be.
 *
 * Everything below the seam is the real thing: the dispatcher in
 * `ShortcutProvider`, the palette's ranking, `planFromQuery`, the plan card and
 * its tiers. Only the rows and the hands are stubbed, and every action the page
 * takes is written to `[data-ran]` for a spec to read back.
 */
import { CommandPalette } from "@/app/components/CommandPalette";
import { CopilotDock } from "@/app/components/copilot/CopilotDock";
import {
  CopilotStateProvider,
  type CopilotMessage,
  type CopilotState,
} from "@/app/components/copilot/CopilotProvider";
import { ShortcutOverlay } from "@/app/components/ShortcutOverlay";
import {
  useShortcut,
  useShortcutRegistry,
} from "@/app/components/ShortcutProvider";
import { Input } from "@/app/components/ui/input";
import {
  actionTier,
  planRunsUnattended,
  type CopilotAction,
} from "@/app/lib/copilotActions";
import { itemAction, planFromQuery } from "@/app/lib/copilotIntent";
import type { SearchItem } from "@/app/lib/paletteSearch";
import { useState, useSyncExternalStore } from "react";

const ITEMS: readonly SearchItem[] = [
  {
    group: "Go to",
    id: "page:/scheduler",
    keywords: ["cron", "jobs"],
    target: { href: "/p/scheduler", type: "navigate" },
    title: "Scheduler",
  },
  {
    group: "Go to",
    id: "page:/dashboard",
    keywords: ["traces", "logs"],
    target: { href: "/p/dashboard", type: "navigate" },
    title: "Dashboard",
  },
  {
    detail: "agent",
    group: "Nodes",
    id: "node:7",
    target: { nodeId: "7", type: "openNode" },
    title: "triage",
  },
  {
    detail: "mcp",
    group: "Nodes",
    id: "node:9",
    target: { nodeId: "9", type: "openNode" },
    title: "linear-mcp",
  },
  {
    detail: "0 9 * * * · active",
    group: "Crons",
    id: "cron:c1",
    target: { href: "/p/scheduler", type: "navigate" },
    title: "nightly-digest",
  },
  {
    detail: "env var",
    group: "Config",
    id: "env:e1",
    target: { href: "/p/settings", type: "navigate" },
    title: "MAX_RETRIES",
  },
  {
    detail: "production",
    group: "Stages",
    id: "stage:s2",
    target: { href: "/p?stage=s2", type: "navigate" },
    title: "production",
  },
];

const CRONS = [{ id: "c1", name: "nightly-digest", status: "active" as const }];

/** How an action reads in `[data-ran]`, short enough for an exact assertion. */
function describe(action: CopilotAction): string {
  switch (action.type) {
    case "navigate":
      return `navigate ${action.href}`;
    case "openNode":
      return `openNode ${action.nodeId}`;
    case "command":
      return `command ${action.commandId}`;
    case "setCronStatus":
      return `setCronStatus ${action.cronId} ${action.status}`;
    case "setEnvVar":
      return `setEnvVar ${action.name}=${action.value}`;
    case "blocked":
      return "blocked";
  }
}

export function ShortcutsStandIn(): React.JSX.Element {
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  return (
    <main
      className="flex h-screen flex-col"
      data-hydrated={hydrated ? "true" : undefined}
    >
      <Surfaces />
    </main>
  );
}

/**
 * Stands in for the canvas: claims the bindings a real canvas claims, so the
 * palette lists them and the copilot is allowed to plan them. Unmount it and
 * both should forget they exist.
 */
function CanvasBindings({ onRun }: { onRun: (entry: string) => void }): null {
  useShortcut("canvas.addAgent", () => onRun("command canvas.addAgent"));
  useShortcut("canvas.tidy", () => onRun("command canvas.tidy"));
  useShortcut("canvas.fitView", () => onRun("command canvas.fitView"));
  // Bare `enter` and bare `+`: the two that collide with typing and with the
  // press that activates a focused control.
  useShortcut("canvas.rename", () => onRun("command canvas.rename"));
  useShortcut("canvas.zoomIn", () => onRun("command canvas.zoomIn"));

  return null;
}

function Surfaces(): React.JSX.Element {
  const [ran, setRan] = useState<readonly string[]>([]);
  const [messages, setMessages] = useState<readonly CopilotMessage[]>([]);
  const [completed, setCompleted] = useState<ReadonlySet<string>>(new Set());
  const [isOpen, setOpen] = useState(false);
  const [liveCanvas, setLiveCanvas] = useState(true);

  const { activeIds } = useShortcutRegistry();

  const record = (entry: string): void => setRan((prev) => [...prev, entry]);
  const run = (action: CopilotAction): void => record(describe(action));

  const ask = (query: string): void => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const askedAt = String(messages.length);
    const plan = planFromQuery(trimmed, {
      crons: CRONS,
      envNames: ["MAX_RETRIES"],
      items: ITEMS,
      liveCommands: activeIds,
    });

    const unattended = plan !== null && planRunsUnattended(plan);
    if (unattended) {
      for (const action of plan.actions) run(action);
    }

    setMessages((prev) => [
      ...prev,
      { id: `${askedAt}:you`, role: "user", text: trimmed },
      {
        id: `${askedAt}:broods`,
        plan: plan ?? undefined,
        role: "broods",
        text: plan?.summary ?? "I can only run what I can resolve here.",
      },
    ]);
    if (unattended) {
      setCompleted((prev) => {
        const next = new Set(prev);
        plan.actions.forEach((_, index) =>
          next.add(`${askedAt}:broods:${index}`),
        );

        return next;
      });
    }
  };

  // Rebuilt every render on purpose: these close over the state they read, and
  // a fixture has nothing to gain from a stable identity.
  const copilot: CopilotState = {
    ask: ask,
    completed: completed,
    isOpen: isOpen,
    messages: messages,
    runAction: run,
    runStep: (messageId, index, action) => {
      if (actionTier(action) === "blocked") return;
      run(action);
      setCompleted((prev) => new Set(prev).add(`${messageId}:${index}`));
    },
    setOpen: setOpen,
  };

  return (
    <CopilotStateProvider value={copilot}>
      {liveCanvas && <CanvasBindings onRun={record} />}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-8">
          <section data-fixture="palette" className="flex items-center gap-3">
            <CommandPalette
              items={ITEMS}
              onAsk={(query) => {
                setOpen(true);
                ask(query);
              }}
              onSelect={(item) => run(itemAction(item))}
            />
            <button
              type="button"
              data-drop-canvas
              className="cursor-pointer rounded-md border border-border px-2 py-1 text-xs"
              onClick={() => setLiveCanvas(false)}
            >
              Unmount canvas bindings
            </button>
          </section>

          <section data-fixture="editable" className="max-w-xs">
            <Input placeholder="A text field, where a bare letter is typing" />
          </section>

          {/* Every action the surfaces took, oldest first. */}
          <ol data-ran className="font-mono text-2xs text-muted-foreground">
            {ran.map((entry, index) => (
              <li key={`${entry}-${index}`} data-ran-entry>
                {entry}
              </li>
            ))}
          </ol>
        </div>

        <CopilotDock />
      </div>
      <ShortcutOverlay />
    </CopilotStateProvider>
  );
}
