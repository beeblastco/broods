"use client";

import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { afterLoad } from "@/app/lib/prefetch";
import { lazy, Suspense, useEffect, useState } from "react";

const loadDockPanel = (): Promise<typeof import("./CopilotDockPanel")> =>
  import("./CopilotDockPanel");

const CopilotDockPanel = lazy(() =>
  loadDockPanel().then((mod) => ({ default: mod.CopilotDockPanel })),
);

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
