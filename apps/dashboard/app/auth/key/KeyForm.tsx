"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { BroodsMark } from "@/app/components/BroodsMark";
import { SecretInput } from "@/app/components/SecretInput";
import { Button } from "@/app/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/app/components/ui/collapsible";
import { Field, FieldError, FieldLabel } from "@/app/components/ui/field";

const WRONG_KEY = "That key does not match this stack.";

export function KeyForm({
  rejected,
  returnTo,
}: {
  rejected: boolean;
  returnTo: string;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const error = rejected && !pending ? WRONG_KEY : null;

  return (
    <form
      method="post"
      action="/auth/session"
      onSubmit={() => setPending(true)}
      className="flex w-full max-w-80 flex-col gap-4"
    >
      <BroodsMark className="size-6 self-start" />
      <h1 className="text-base font-semibold text-foreground">Sign in</h1>
      <input type="hidden" name="returnTo" value={returnTo} />
      <Field data-invalid={error !== null}>
        <FieldLabel htmlFor="admin-key">Admin key</FieldLabel>
        <SecretInput
          id="admin-key"
          name="key"
          noun="key"
          autoComplete="current-password"
          required={true}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? "admin-key-error" : undefined}
        />
        <FieldError id="admin-key-error">{error}</FieldError>
      </Field>
      <Button
        type="submit"
        disabled={pending}
        className={pending ? "cursor-not-allowed" : "cursor-pointer"}
      >
        Sign in
      </Button>
      <Collapsible>
        <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
          <ChevronRight className="size-3 transition-transform group-data-panel-open:rotate-90" />
          Where is my key?
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-1 pt-2 text-xs text-muted-foreground">
          <p>
            It is the stack&apos;s ADMIN_ACCOUNT_SECRET. On the local stack:
          </p>
          <code className="rounded-md bg-muted px-2 py-1 font-mono text-foreground">
            bun run local:status -- --key
          </code>
        </CollapsibleContent>
      </Collapsible>
    </form>
  );
}
