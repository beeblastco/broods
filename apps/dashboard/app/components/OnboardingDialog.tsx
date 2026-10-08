"use client";

/** Three-step first-login onboarding dialog: welcome, one-time account key, first CLI project. */
import { CopyButton } from "@/app/components/CopyButton";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { ArrowUpRight, Eye, EyeOff } from "lucide-react";
import { type ReactNode, useState } from "react";

// The starter agent reads env("OPENAI_API_KEY"); `broods dev` pushes it from
// .env.local, as in the docs quickstart.
const CLI_COMMANDS = [
  "npm install -g broods && mkdir broods-demo && cd broods-demo",
  `echo 'OPENAI_API_KEY="sk-..."' >> .env.local`,
  "broods dev",
];

interface Props {
  /** The one-time plaintext account key to hand over on step two. */
  secret: string;
  /** Called when the user finishes the flow; the caller clears the secret and routes to /projects. */
  onDone: () => void;
}

/**
 * Modal onboarding flow shown once after first-login provisioning. It cannot be
 * dismissed by Escape or outside clicks: step two holds the unrecoverable
 * one-time secret, so the only way out is forward.
 */
export function OnboardingDialog({ secret, onDone }: Props): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const masked = "•".repeat(Math.min(secret.length, 44));

  const titles = [
    "Welcome to Broods",
    "Save your account key",
    "Start your first project",
  ];
  const descriptions = [
    "Your account is ready.",
    "It's shown only once and can't be recovered. Store it somewhere safe now.",
    "One command scaffolds a project and syncs it to your account.",
  ];

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(_open, eventDetails) => eventDetails.cancel()}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{titles[step]}</DialogTitle>
          <DialogDescription>{descriptions[step]}</DialogDescription>
        </DialogHeader>

        <div
          key={step}
          className="min-h-36 min-w-0 animate-in fade-in slide-in-from-right-2 duration-200 motion-reduce:animate-none"
        >
          {step === 0 && (
            <div className="grid gap-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Broods runs agents as configuration: declare agents, workspaces,
                and crons in a <Mono>broods/</Mono> folder, and the platform
                deploys and operates them for you.
              </p>
              <p>
                This dashboard is where you watch and steer everything:
                architecture, runs, sandboxes, and schedules. Two quick things
                first.
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="grid gap-3">
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={revealed ? secret : masked}
                  className="h-9 font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 cursor-pointer"
                  onClick={() => setRevealed((value) => !value)}
                  title={revealed ? "Hide key" : "Reveal key"}
                >
                  {revealed ? (
                    <EyeOff className="size-3.5" />
                  ) : (
                    <Eye className="size-3.5" />
                  )}
                </Button>
                <CopyButton value={secret} label="key" />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                This key authenticates the API, so you can create agents, crons,
                and workspaces from your own code.
              </p>
              <div className="flex items-center gap-4">
                <DocsLink href="https://docs.broods.app/reference/sdk">
                  Use it from the SDK
                </DocsLink>
                <DocsLink href="https://docs.broods.app/api-reference">
                  API reference
                </DocsLink>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="grid gap-3">
              <CommandBlock commands={CLI_COMMANDS} />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Put your OpenAI key in place of <Mono>sk-...</Mono>. On Bun,
                swap the first step for <Mono>bun add -g broods</Mono>. The CLI
                walks you through login and scaffolding, then keeps your config
                in sync while it runs. Once it&apos;s up,{" "}
                <Mono>broods-demo</Mono> appears on your projects page.
              </p>
              <DocsLink href="https://docs.broods.app/quickstart">
                Full quickstart
              </DocsLink>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-1">
          <HexSteps step={step} count={3} />
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="cursor-pointer"
                onClick={() => setStep(step - 1)}
              >
                Back
              </Button>
            )}
            {step < 2 ? (
              <Button
                size="sm"
                className="cursor-pointer"
                onClick={() => setStep(step + 1)}
              >
                Continue
              </Button>
            ) : (
              <Button size="sm" className="cursor-pointer" onClick={onDone}>
                Done
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A shell command block, one prompt per line, with a corner control that copies them all. */
function CommandBlock({ commands }: { commands: string[] }): React.JSX.Element {
  return (
    // min-w-0: as a grid item this would otherwise grow to the command's
    // intrinsic width and push the whole card past its edge.
    <div className="relative min-w-0">
      <pre className="overflow-x-auto rounded-md border bg-muted/50 px-3 py-2.5 pr-12 font-mono text-xs leading-relaxed text-foreground">
        {commands.map((command) => (
          <div key={command}>
            <span className="select-none text-muted-foreground">$ </span>
            {command}
          </div>
        ))}
      </pre>
      <div className="absolute right-1.5 top-1.5">
        <CopyButton value={commands.join("\n")} label="commands" />
      </div>
    </div>
  );
}

function DocsLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex cursor-pointer items-center gap-0.5 text-xs font-medium text-foreground underline decoration-muted-foreground/60 underline-offset-4 transition-colors hover:decoration-foreground"
    >
      {children}
      <ArrowUpRight className="size-3" />
    </a>
  );
}

/** Honeycomb progress: one hex cell per step, filled for the current, dimmed for the done, hollow for the rest. */
function HexSteps({
  step,
  count,
}: {
  step: number;
  count: number;
}): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-1"
      aria-label={`Step ${step + 1} of ${count}`}
    >
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={cn(
            "clip-hex size-2.5 transition-colors duration-300",
            index === step
              ? "bg-foreground"
              : index < step
                ? "bg-foreground/35"
                : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

/** Inline `<code>` styling for prose mentions of commands and names. */
function Mono({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
      {children}
    </code>
  );
}
