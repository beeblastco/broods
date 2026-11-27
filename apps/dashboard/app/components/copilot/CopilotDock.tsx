"use client";

import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { chunkFailed } from "@/app/components/ChunkFailed";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { afterLoad } from "@/app/lib/prefetch";
import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ComponentProps,
  type ComponentType,
} from "react";
import type { CopilotDockPanel as Panel } from "./CopilotDockPanel";

const loadDockPanel = (): Promise<{
  default: ComponentType<ComponentProps<typeof Panel>>;
}> =>
  import("./CopilotDockPanel").then(
    (mod) => ({ default: mod.CopilotDockPanel }),
    () => chunkFailed<ComponentProps<typeof Panel>>("the agent"),
  );

const CopilotDockPanel = lazy(loadDockPanel);

// Takes its width from the page, not floating, so what the plan changes stays on screen.
// The thread loads on first open; the draft stays here, so closing the dock keeps it.
export function CopilotDock(): React.JSX.Element | null {
  const { isOpen, setOpen } = useCopilot();
  const [input, setInput] = useState("");

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- warms the chunk after the load event
  useEffect(() => afterLoad(() => void loadDockPanel()), []);
  useShortcut("copilot.open", () => setOpen(!isOpen));

  if (!isOpen) return null;

  return (
    <Suspense
      // Until the thread arrives, typing lands in the draft, not on a page shortcut.
      fallback={
        <textarea
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the user just opened the dock
          autoFocus
          aria-label="Message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="sr-only"
        />
      }
    >
      <CopilotDockPanel input={input} onInputChange={setInput} />
    </Suspense>
  );
}
