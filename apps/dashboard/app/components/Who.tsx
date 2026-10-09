"use client";

import { DitherAvatarSVG } from "@/app/components/DitherAvatar";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/app/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import type { Id } from "@broods/convex/_generated/dataModel";
import { navHref } from "@/app/lib/navigation";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

/** How many avatars a group shows before folding the rest into a count. */
const GROUP_MAX = 3;

/** A member as the backend names them; the shape every `createdBy` carries. */
export interface Person {
  name: string;
  avatarUrl?: string | null;
}

/** Anyone a cell names: a person, an agent, or the platform itself. */
export type Actor =
  | Person
  | { kind: "agent"; name: string; agentId: Id<"agents"> }
  | { kind: "platform" };

/** The platform as an actor: built-in rows and minted keys say Broods made them. */
export const PLATFORM: Actor = { kind: "platform" };

/**
 * Avatar plus name, the one shape every Created by, Invited by and Agent cell
 * uses. An agent's name links to the canvas with that agent's card open.
 */
export function Who({
  actor,
  projectId,
}: {
  actor: Actor;
  /** Where an agent name links; a cell outside a project shows it plain. */
  projectId?: Id<"projects">;
}): React.JSX.Element {
  const stage = useSearchParams().get("stage");

  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <ActorAvatar actor={actor} />
      {"kind" in actor && actor.kind === "agent" && projectId ? (
        <Link
          href={`${navHref(projectId, "", stage)}${stage ? "&" : "?"}node=${actor.agentId}`}
          onClick={(event) => event.stopPropagation()}
          className="cursor-pointer text-foreground underline-offset-3 hover:underline"
        >
          {actor.name}
        </Link>
      ) : (
        <span className="text-foreground">{actorName(actor)}</span>
      )}
    </span>
  );
}

/** Several actors as one avatar group; the names are the tooltip. */
export function WhoGroup({ actors }: { actors: Actor[] }): React.JSX.Element {
  const shown = actors.slice(0, GROUP_MAX);
  const rest = actors.length - shown.length;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<AvatarGroup className="cursor-default" />}
        aria-label={actors.map(actorName).join(", ")}
      >
        {shown.map((actor, index) => (
          <ActorAvatar key={index} actor={actor} />
        ))}
        {rest > 0 && <AvatarGroupCount>+{rest}</AvatarGroupCount>}
      </TooltipTrigger>
      <TooltipContent>{actors.map(actorName).join(", ")}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The cell avatar alone: a person's picture or initials, an agent's dither,
 * the Broods mark. The height of its text line, so a row with one stays the
 * height of a row without.
 */
export function ActorAvatar({ actor }: { actor: Actor }): React.JSX.Element {
  if ("kind" in actor && actor.kind === "agent") {
    return (
      <Avatar size="xs">
        <DitherAvatarSVG seed={actor.name} size={16} className="rounded-sm" />
      </Avatar>
    );
  }
  if ("kind" in actor) {
    return (
      <Avatar size="xs">
        <svg viewBox="0 0 64 64" aria-hidden="true" className="size-full">
          <circle
            cx="32"
            cy="32"
            r="32"
            className="fill-brand-ink dark:fill-white"
          />
        </svg>
      </Avatar>
    );
  }

  return (
    <Avatar size="xs">
      {actor.avatarUrl && <AvatarImage src={actor.avatarUrl} alt="" />}
      <AvatarFallback className="text-3xs font-medium">
        {initials(actor.name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** What a Created by cell calls the actor: the platform is Broods, anyone else their name. */
export function actorName(actor: Actor): string {
  return "kind" in actor && actor.kind === "platform" ? "Broods" : actor.name;
}

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "");

  return letters.join("") || "?";
}
