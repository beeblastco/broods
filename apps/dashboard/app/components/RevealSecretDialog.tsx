"use client";

import { CopyButton } from "@/app/components/CopyButton";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import type { ReactNode } from "react";

/** A secret shown exactly once, with a copy button; `children` adds how to use it. */
export function RevealSecretDialog({
  title,
  label,
  secret,
  children,
  onClose,
}: {
  title: string;
  /** What the copy button says it copied. */
  label: string;
  secret: string;
  children?: ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Copy it now. It will not be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="flex items-center gap-1">
            <Input readOnly value={secret} className="font-mono text-xs" />
            <CopyButton value={secret} label={label} />
          </div>
          {children}
        </div>
        <DialogFooter>
          <Button size="sm" className="cursor-pointer" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
