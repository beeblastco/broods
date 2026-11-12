"use client";

import { BroodsMark } from "@/app/components/BroodsMark";
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
import { useRouteIntent } from "@/app/hooks/useRouteIntent";
import { navHref } from "@/app/lib/navigation";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

const GROUP_MAX = 3;

interface Person {
  name: string;
  avatarUrl?: string | null;
}

export type Actor =
  | Person
  | { kind: "agent"; name: string; agentId: Id<"agents"> }
  | { kind: "platform" };

export const PLATFORM: Actor = { kind: "platform" };

export function Who({
  actor,
  projectId,
}: {
  actor: Actor;
  projectId?: Id<"projects">;
}): React.JSX.Element {
  const stage = useSearchParams().get("stage");
  const { handlers } = useRouteIntent();
  const agent = "kind" in actor && actor.kind === "agent" ? actor : null;
  const agentHref =
    agent && projectId
      ? `${navHref(projectId, "", stage)}${stage ? "&" : "?"}node=${agent.agentId}`
      : null;
  const intent = agentHref ? handlers(agentHref) : null;

  // flex, not inline: a 16px inline box sits on the line box and lifts the row a pixel.
  return (
    <span className="flex items-center gap-1.5">
      <ActorAvatar actor={actor} />
      {agent && agentHref && intent ? (
        <Link
          href={agentHref}
          prefetch={false}
          {...intent}
          onClick={(event) => {
            event.stopPropagation();
            intent.onClick(event);
          }}
          className="cursor-pointer text-foreground underline-offset-3 hover:underline"
        >
          {agent.name}
        </Link>
      ) : (
        <span className="text-foreground">{actorName(actor)}</span>
      )}
    </span>
  );
}

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
          // oxlint-disable-next-line react/no-array-index-key -- group slots; actors carry no id
          <ActorAvatar key={index} actor={actor} />
        ))}
        {rest > 0 && <AvatarGroupCount>+{rest}</AvatarGroupCount>}
      </TooltipTrigger>
      <TooltipContent>{actors.map(actorName).join(", ")}</TooltipContent>
    </Tooltip>
  );
}

function ActorAvatar({ actor }: { actor: Actor }): React.JSX.Element {
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
        <BroodsMark className="size-full" />
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
