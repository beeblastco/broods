"use client";

import { ChevronRight, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { BroodsLogo } from "@/app/components/BroodsLogo";
import { Button } from "@/app/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/app/components/ui/collapsible";
import { Field, FieldError, FieldLabel } from "@/app/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/app/components/ui/input-group";

const WRONG_KEY = "That key does not match this stack.";

/**
 * Admin key form for the self-hosted sign-in. A native POST to /auth/session,
 * which checks the key and answers with a full page load; a wrong key comes
 * back here with `rejected`.
 */
export function KeyForm({
  rejected,
  returnTo,
}: {
  rejected: boolean;
  returnTo: string;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [shown, setShown] = useState(false);
  const error = rejected && !pending ? WRONG_KEY : null;

  return (
    <form
      method="post"
      action="/auth/session"
      onSubmit={() => setPending(true)}
      className="flex w-full max-w-80 flex-col gap-4"
    >
      <BroodsLogo className="h-6 w-auto self-start" />
      <h1 className="text-base font-semibold text-foreground">Sign in</h1>
      <input type="hidden" name="returnTo" value={returnTo} />
      <Field data-invalid={error !== null}>
        <FieldLabel htmlFor="admin-key">Admin key</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id="admin-key"
            name="key"
            type={shown ? "text" : "password"}
            autoComplete="current-password"
            required={true}
            aria-invalid={error !== null}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label={shown ? "Hide key" : "Show key"}
              onClick={() => setShown(!shown)}
              className="cursor-pointer"
            >
              {shown ? <EyeOff /> : <Eye />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <FieldError>{error}</FieldError>
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
