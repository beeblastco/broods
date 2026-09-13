"use client";

import { Button } from "@/app/components/ui/button";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** How long the check mark stays before the copy icon returns. */
const COPIED_MS = 1500;

interface Props {
  /** The text written to the clipboard. */
  value: string;
  /** What the button copies, for the accessible name. */
  label: string;
}

/** Icon button that copies `value` and shows a check mark for a moment. */
export function CopyButton({ value, label }: Props): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  function handleCopy(): void {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={`Copy ${label}`}
      className="cursor-pointer text-muted-foreground"
      onClick={handleCopy}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
