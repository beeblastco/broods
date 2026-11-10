"use client";

import { Button } from "@/app/components/ui/button";
import { useTimeoutFlag } from "@/app/hooks/useTimeoutFlag";
import { cn } from "@/app/lib/utils";
import { Check, Copy, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

const COPIED_MS = 1500;

interface Props {
  value: string;
  label: string;
}

interface RowProps {
  value: string;
  /** Sets the display (`flex`, `grid …`) and padding; the row has none of its own. */
  className: string;
  children: ReactNode;
}

export function CopyButton({ value, label }: Props): React.JSX.Element {
  const { copied, copy } = useCopied(value);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      tone="muted"
      aria-label={`Copy ${label}`}
      className="cursor-pointer"
      onClick={copy}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

export function CopyTextButton({
  value,
  label,
  title,
  className,
  children,
}: {
  value: string;
  label: string;
  title: string;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  const { copied, failed, copy } = useCopied(value);

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      title={failed ? "The browser refused the copy" : title}
      aria-label={label}
      onClick={copy}
      className={cn("cursor-pointer", className)}
    >
      {copied ? (
        <Check className="text-success" />
      ) : failed ? (
        <X className="text-destructive" />
      ) : (
        <Copy />
      )}
      {children}
    </Button>
  );
}

export function CopyRow({
  value,
  className,
  children,
}: RowProps): React.JSX.Element {
  const { copied, copy } = useCopied(value);

  return (
    <button
      type="button"
      title={value}
      onClick={copy}
      className={cn(
        "group/copy min-w-0 max-w-full cursor-pointer items-center gap-2 rounded text-left transition-colors hover:bg-accent/40",
        className,
      )}
    >
      {children}
      {copied ? (
        <Check className="size-3 shrink-0 text-success" />
      ) : (
        <Copy className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100" />
      )}
    </button>
  );
}

function useCopied(value: string): {
  copied: boolean;
  failed: boolean;
  copy: (event: MouseEvent<HTMLElement>) => void;
} {
  // A new object per copy, so a second copy of the same value restarts the timer.
  const [copiedWrite, setCopiedWrite] = useState<{ value: string } | null>(
    null,
  );
  const copied = useTimeoutFlag(copiedWrite, COPIED_MS);
  const [failedValue, setFailedValue] = useState<string | null>(null);
  const attempt = useRef(0);
  // A write still in flight for the old value must not mark the new one copied or failed.
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- clipboard write in flight
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [value],
  );

  function copy(event: MouseEvent<HTMLElement>): void {
    const currentAttempt = ++attempt.current;
    setFailedValue(null);
    if (
      !window.isSecureContext ||
      !document.hasFocus() ||
      !event.isTrusted ||
      (navigator.userActivation !== undefined &&
        !navigator.userActivation.isActive) ||
      !navigator.clipboard
    ) {
      setCopiedWrite(null);
      setFailedValue(value);
      return;
    }
    // Copy only on the user's click: never in the background, never read or clear the clipboard.
    void navigator.clipboard.writeText(value).then(
      () => {
        if (currentAttempt !== attempt.current) return;
        setCopiedWrite({ value: value });
      },
      () => {
        if (currentAttempt !== attempt.current) return;
        setCopiedWrite(null);
        setFailedValue(value);
      },
    );
  }

  return {
    copied: copied?.value === value,
    failed: failedValue === value,
    copy: copy,
  };
}
