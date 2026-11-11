"use client";

import { Button } from "@/app/components/ui/button";
import { Who } from "@/app/components/Who";
import { useSubmit } from "@/app/hooks/useSubmit";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Check, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

type Invitation = FunctionReturnType<
  typeof api.org.invitations.listMine
>[number];

interface Answer {
  invitation: Invitation;
  accepted: boolean;
}

const NO_INVITATIONS: Invitation[] = [];

// Mounted above every page's content. It subscribes only while the user row says an
// invitation waits, and keeps each answer on its line until closed or the page changes.
export function InvitationNotice({
  invited,
}: {
  invited: boolean;
}): React.JSX.Element | null {
  const pending =
    useQuery(api.org.invitations.listMine, invited ? {} : "skip") ??
    NO_INVITATIONS;
  const [answers, setAnswers] = useState<Answer[]>([]);
  const pathname = usePathname();
  const [answeredOn, setAnsweredOn] = useState(pathname);
  if (answeredOn !== pathname) {
    setAnsweredOn(pathname);
    setAnswers([]);
  }
  const answered = new Set(
    answers.map((answer) => answer.invitation.invitationId),
  );
  const open = pending.filter(
    (invitation) => !answered.has(invitation.invitationId),
  );
  if (open.length === 0 && answers.length === 0) return null;

  function close(invitationId: Id<"orgInvitations">): void {
    setAnswers(
      answers.filter(
        (answer) => answer.invitation.invitationId !== invitationId,
      ),
    );
  }

  return (
    <div className="divide-y divide-border border-b border-border bg-muted text-xs">
      {answers.map((answer) => (
        <AnswerLine
          key={answer.invitation.invitationId}
          answer={answer}
          onClose={() => close(answer.invitation.invitationId)}
        />
      ))}
      {open.map((invitation) => (
        <InvitationLine
          key={invitation.invitationId}
          invitation={invitation}
          onAnswer={(accepted) =>
            setAnswers([
              ...answers,
              { invitation: invitation, accepted: accepted },
            ])
          }
        />
      ))}
    </div>
  );
}

function AnswerLine({
  answer,
  onClose,
}: {
  answer: Answer;
  onClose: () => void;
}): React.JSX.Element {
  const setActive = useMutation(api.org.orgs.setActive);
  const router = useRouter();
  const { orgId, orgName } = answer.invitation;

  async function switchOrg(): Promise<void> {
    await setActive({ orgId: orgId });
    onClose();
    router.replace("/");
  }

  return (
    <output className="flex flex-wrap items-center gap-2 px-3 py-1.5">
      {answer.accepted ? (
        <span className="flex items-center gap-1.5">
          <Check className="size-3.5 text-success" />
          <span>
            You joined <b className="font-medium">{orgName}</b>.
          </span>
        </span>
      ) : (
        <span className="text-muted-foreground">
          Declined the invitation to {orgName}.
        </span>
      )}
      <span className="ml-auto flex gap-1.5">
        {answer.accepted && (
          <Button
            variant="outline"
            size="xs"
            className="cursor-pointer"
            onClick={() => void switchOrg()}
          >
            Switch to {orgName}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          tone="muted"
          className="cursor-pointer"
          aria-label="Close"
          onClick={onClose}
        >
          <X />
        </Button>
      </span>
    </output>
  );
}

function InvitationLine({
  invitation,
  onAnswer,
}: {
  invitation: Invitation;
  onAnswer: (accepted: boolean) => void;
}): React.JSX.Element {
  const accept = useMutation(api.org.invitations.accept);
  const decline = useMutation(api.org.invitations.decline);
  const { pending, error, run } = useSubmit();
  const args = { invitationId: invitation.invitationId };

  async function answer(accepted: boolean): Promise<void> {
    if (await run(() => (accepted ? accept(args) : decline(args)))) {
      onAnswer(accepted);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
      <span className="flex flex-wrap items-center gap-1">
        {invitation.invitedBy && <Who actor={invitation.invitedBy} />}
        <span>
          invited you to <b className="font-medium">{invitation.orgName}</b> as{" "}
          {invitation.roleName ?? (
            <span className="capitalize">{invitation.role}</span>
          )}
          .
        </span>
      </span>
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
      <span className="ml-auto flex gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          tone="muted"
          className="cursor-pointer"
          disabled={pending}
          onClick={() => void answer(false)}
        >
          Decline
        </Button>
        <Button
          size="xs"
          className="cursor-pointer"
          disabled={pending}
          onClick={() => void answer(true)}
        >
          Accept
        </Button>
      </span>
    </div>
  );
}
