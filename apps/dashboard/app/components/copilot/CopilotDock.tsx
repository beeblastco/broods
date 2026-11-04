"use client";

import { BroodsMark } from "@/app/components/BroodsMark";
import { CopilotPlanCard } from "@/app/components/copilot/CopilotPlanCard";
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { Button } from "@/app/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/app/components/ui/input-group";
import { useStickToBottom } from "@/app/hooks/useStickToBottom";
import { ArrowUp } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";

// Heavy (Shiki), so it loads with the first answer, not with the page.
const Streamdown = dynamic(
  () => import("streamdown").then((m) => m.Streamdown),
  { ssr: false },
);

const EXAMPLES = [
  "go to scheduler",
  "add an agent",
  "pause nightly-digest",
] as const;

// Takes its width from the page, not floating, so what the plan changes stays on screen.
export function CopilotDock(): React.JSX.Element | null {
  const { ask, completed, isOpen, messages, proposals, setOpen } = useCopilot();

  const [input, setInput] = useState("");
  const thread = useStickToBottom<HTMLDivElement>([messages]);

  useShortcut("copilot.open", () => setOpen(!isOpen));

  if (!isOpen) return null;

  const send = (): void => {
    if (!input.trim()) return;
    ask(input);
    setInput("");
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border">
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
            {messages.map((message) =>
              message.role === "user" ? (
                <p
                  key={message.id}
                  className="ml-8 self-end whitespace-pre-wrap rounded-lg bg-muted px-2.5 py-1.5 text-xs text-foreground"
                >
                  {message.text}
                </p>
              ) : (
                <div key={message.id} className="flex items-start gap-2">
                  <BroodsMark className="mt-0.5 size-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    {message.pending && !message.text ? (
                      <p className="text-xs text-muted-foreground">
                        Thinking...
                      </p>
                    ) : (
                      <Streamdown className="min-w-0 wrap-break-word text-xs text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:whitespace-pre-wrap [&_code]:wrap-break-word [&_code]:text-xs [&_pre]:max-w-full [&_pre]:overflow-x-auto">
                        {message.text}
                      </Streamdown>
                    )}
                    {message.plan && (
                      <CopilotPlanCard
                        completed={completed}
                        messageId={message.id}
                        plan={message.plan}
                        proposal={proposals.get(message.id)}
                        stale={message.stale}
                      />
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </div>

      <div className="px-3 pb-3">
        <InputGroup variant="plain" className="rounded-lg">
          <InputGroupTextarea
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the user just opened the dock
            autoFocus
            aria-label="Message"
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
