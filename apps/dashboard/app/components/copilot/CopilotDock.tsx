"use client";

import { BroodsMark } from "@/app/components/BroodsMark";
import { CopilotPlanCard } from "@/app/components/copilot/CopilotPlanCard";
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { CopilotTrace } from "@/app/components/copilot/CopilotTrace";
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
import Link from "next/link";
import { useState } from "react";
import type { Components, ExtraProps } from "streamdown";

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

// A dashboard path, never `//host` or `/\\host`, which a browser reads as another origin.
const DASHBOARD_PATH = /^\/(?![/\\])/;

const MARKDOWN_COMPONENTS: Components = { a: AnswerLink };

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
    <aside className="flex w-96 shrink-0 flex-col border-l border-border">
      <div ref={thread} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
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
                  className="ml-8 self-end whitespace-pre-wrap rounded-lg bg-muted px-2.5 py-1.5 text-sm text-foreground"
                >
                  {message.text}
                </p>
              ) : (
                <div key={message.id} className="flex items-start gap-2">
                  <BroodsMark className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    {message.trace && (
                      <CopilotTrace
                        answeredAt={message.answeredAt}
                        startedAt={message.startedAt}
                        trace={message.trace}
                      />
                    )}
                    {message.text ? (
                      <Streamdown
                        components={MARKDOWN_COMPONENTS}
                        className="min-w-0 wrap-break-word text-sm text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:whitespace-pre-wrap [&_code]:wrap-break-word [&_code]:text-sm [&_pre]:max-w-full [&_pre]:overflow-x-auto"
                      >
                        {message.text}
                      </Streamdown>
                    ) : (
                      message.pending &&
                      !message.trace?.length && (
                        <p className="text-sm text-muted-foreground">
                          Thinking...
                        </p>
                      )
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
            className="max-h-32 min-h-0 py-2 text-sm"
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

// A dashboard link moves the page under the dock; any other opens beside the dashboard.
function AnswerLink({
  children,
  href,
}: React.ComponentProps<"a"> & ExtraProps): React.JSX.Element {
  const className = "wrap-anywhere font-medium text-primary underline";
  if (href && DASHBOARD_PATH.test(href)) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }

  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  );
}
