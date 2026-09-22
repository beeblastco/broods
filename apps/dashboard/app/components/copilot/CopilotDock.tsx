"use client";

/**
 * The copilot dock. Takes its width from the page rather than floating over it,
 * so what it is about to change stays on screen while you read the plan.
 */
import { CopilotPlanCard } from "@/app/components/copilot/CopilotPlanCard";
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { ShortcutKeys } from "@/app/components/ShortcutKeys";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { Button } from "@/app/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/app/components/ui/input-group";
import { ArrowUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const EXAMPLES = [
  "go to scheduler",
  "add an agent",
  "pause nightly-digest",
] as const;

export function CopilotDock(): React.JSX.Element | null {
  const { ask, completed, isOpen, messages, runStep, setOpen } = useCopilot();

  const [input, setInput] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);

  useShortcut("copilot.open", () => setOpen(!isOpen));

  useEffect(() => {
    if (isOpen) composer.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight });
  }, [messages]);

  if (!isOpen) return null;

  const send = (): void => {
    if (!input.trim()) return;
    ask(input);
    setInput("");
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs font-medium">Broods</span>
        <span className="ml-auto flex items-center gap-1">
          <ShortcutKeys id="copilot.open" bordered />
          <Button
            size="icon-xs"
            variant="ghost"
            tone="muted"
            onClick={() => setOpen(false)}
            aria-label="Close Broods"
          >
            <X />
          </Button>
        </span>
      </header>

      <div ref={thread} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Ask about this project, or tell me what to change. I move around
              on my own and show you the diff before I write anything.
            </p>
            <div className="flex flex-col items-start gap-1">
              {EXAMPLES.map((example) => (
                <Button
                  key={example}
                  size="xs"
                  variant="ghost"
                  tone="muted"
                  onClick={() => ask(example)}
                >
                  {example}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <div key={message.id} className="flex flex-col gap-1">
                <span className="text-3xs uppercase tracking-wide text-muted-foreground">
                  {message.role === "user" ? "you" : "broods"}
                </span>
                <p className="text-xs text-foreground">{message.text}</p>
                {message.plan && (
                  <CopilotPlanCard
                    completed={completed}
                    messageId={message.id}
                    onRun={(index, action) =>
                      runStep(message.id, index, action)
                    }
                    plan={message.plan}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-3 pb-3">
        <InputGroup className="rounded-lg">
          <InputGroupTextarea
            ref={composer}
            value={input}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
              setInput(event.target.value)
            }
            onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            placeholder="Ask, or describe a change..."
            rows={1}
            className="max-h-32 min-h-0 py-2 text-xs"
          />
          <InputGroupAddon align="block-end" className="pt-0">
            <InputGroupButton
              size="icon-xs"
              variant="default"
              disabled={!input.trim()}
              onClick={send}
              className="ml-auto rounded-sm"
              aria-label="Send"
            >
              <ArrowUp className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </aside>
  );
}
