"use client";

/** Three-step first-login onboarding dialog: welcome, one-time account secret, first CLI project. */
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
import { ArrowUpRight, Check, Copy, Eye, EyeOff } from "lucide-react";
import { type ReactNode, useState } from "react";

interface Props {
  /** The one-time plaintext account secret to hand over on step two. */
  secret: string;
  /** Called when the user finishes the flow; the caller clears the secret and routes to /projects. */
  onDone: () => void;
}

const CLI_COMMAND = "mkdir broods-demo && bunx broods dev";

/** Flat-top hexagon cell — the brood-comb shape used by the step indicator. */
const HEX_CLIP =
  "polygon(25% 6.7%, 75% 6.7%, 100% 50%, 75% 93.3%, 25% 93.3%, 0% 50%)";

/** Inline `<code>` styling for prose mentions of commands and names. */
function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </code>
  );
}

/** Clipboard copy with a transient confirmation shown only after the write actually succeeds. */
function useCopy() {
  const [copied, setCopied] = useState(false);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return { copied, copy };
}

/** Honeycomb progress: one hex cell per step — filled for the current, dimmed for the done, hollow for the rest. */
function HexSteps({ step, count }: { step: number; count: number }) {
  return (
    <div
      className="flex items-center gap-1"
      aria-label={`Step ${step + 1} of ${count}`}
    >
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          style={{ clipPath: HEX_CLIP }}
          className={cn(
            "size-2.5 transition-colors duration-300",
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

/** A one-line command block with a corner copy control. */
function CommandBlock({ command }: { command: string }) {
  const { copied, copy } = useCopy();

  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-muted/50 px-3 py-2.5 pr-12 font-mono text-xs leading-relaxed text-foreground">
        <span className="select-none text-muted-foreground">$ </span>
        {command}
      </pre>
      <button
        type="button"
        title="Copy command"
        onClick={() => copy(command)}
        className="absolute right-1.5 top-1.5 flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
}

/** Small external docs link with a trailing arrow. */
function DocsLink({ href, children }: { href: string; children: ReactNode }) {
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

/**
 * Modal onboarding flow shown once after first-login provisioning. It cannot be
 * dismissed by Escape or outside clicks: step two holds the unrecoverable
 * one-time secret, so the only way out is forward.
 */
export function OnboardingDialog({ secret, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const { copied, copy } = useCopy();
  const masked = "•".repeat(Math.min(secret.length, 44));

  const titles = [
    "Welcome to Broods",
    "Save your account secret",
    "Start your first project",
  ];
  const descriptions = [
    "Your serverless agent cloud is ready.",
    "It's shown only once and can't be recovered — store it somewhere safe now.",
    "One command scaffolds a project and syncs it to your account.",
  ];

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{titles[step]}</DialogTitle>
          <DialogDescription>{descriptions[step]}</DialogDescription>
        </DialogHeader>

        <div
          key={step}
          className="min-h-36 animate-in fade-in slide-in-from-right-2 duration-200 motion-reduce:animate-none"
        >
          {step === 0 && (
            <div className="grid gap-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Broods runs agents as configuration: declare agents, workspaces,
                and crons in a <Mono>broods/</Mono> folder, and the platform
                deploys and operates them for you.
              </p>
              <p>
                This dashboard is where you watch and steer everything —
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
                  title={revealed ? "Hide secret" : "Reveal secret"}
                >
                  {revealed ? (
                    <EyeOff className="size-3.5" />
                  ) : (
                    <Eye className="size-3.5" />
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 cursor-pointer"
                  onClick={() => copy(secret)}
                >
                  {copied ? (
                    <Check className="size-3.5 mr-1" />
                  ) : (
                    <Copy className="size-3.5 mr-1" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                This secret is how you manage your account and resources through
                the API — provisioning agents, crons, and workspaces straight
                from your own code.
              </p>
              <div className="flex items-center gap-4">
                <DocsLink href="https://docs.broods.app/sdk">
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
              <CommandBlock command={CLI_COMMAND} />
              <p className="text-xs leading-relaxed text-muted-foreground">
                The CLI walks you through login and scaffolding, then keeps your
                config in sync while it runs. Once it&apos;s up,{" "}
                <Mono>broods-demo</Mono> appears on your projects page.
              </p>
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
