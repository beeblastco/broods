"use client";

/**
 * Renames in place and links that go on the press, with nothing behind them.
 *
 * The field, the canvas card and the project card are the real components;
 * every rename they commit lands in `[data-renamed]`. The links are the real
 * `useRouteIntent` handlers pointed back at this page, so `?opened=` says which
 * one was followed and `[data-opened]` reads it back.
 */
import {
  CANVAS_EDGE_TYPES,
  CANVAS_NODE_TYPES,
} from "@/app/components/canvas/Canvas";
import { FIT_VIEW_OPTIONS } from "@/app/components/canvas/CanvasControl";
import {
  CanvasFramesProvider,
  type CanvasFramesValue,
} from "@/app/components/canvas/CanvasFramesContext";
import { InfraAnalysisProvider } from "@/app/components/canvas/InfraAnalysisContext";
import { ProjectCard } from "@/app/components/ProjectCard";
import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { InlineEdit } from "@/app/components/ui/inline-edit";
import { Input } from "@/app/components/ui/input";
import { useHydrated } from "@/app/hooks/useHydrated";
import { useRouteIntent } from "@/app/hooks/useRouteIntent";
import { analyzeCanvasInfra } from "@/app/lib/canvasRuntimeRefs";
import {
  applyNodeChanges,
  Background,
  ReactFlow,
  type Node,
} from "@xyflow/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

const PAGE = "/ui-gallery?tab=inline-edit";

const CARD_NODES: Node[] = [
  {
    data: { label: "triage" },
    id: "triage",
    position: { x: 0, y: 0 },
    type: "agent",
  },
];

const CARD_ANALYSIS = analyzeCanvasInfra(CARD_NODES, []);

export function InlineEditStandIn(): React.JSX.Element {
  const hydrated = useHydrated();
  const [renamed, setRenamed] = useState<readonly string[]>([]);
  const record = (entry: string): void =>
    setRenamed((current) => [...current, entry]);

  return (
    <main
      className="flex flex-col gap-10 p-8"
      data-hydrated={hydrated ? "true" : undefined}
    >
      <section data-fixture="inline-edit" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Inline edit</h2>
        <NameField onRename={(name) => record(`field ${name}`)} />
        <Input aria-label="Somewhere else" className="w-48" />
      </section>

      <section data-fixture="inline-edit-card" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Canvas card</h2>
        <CardCanvas onRename={(name) => record(`card ${name}`)} />
      </section>

      <section
        data-fixture="inline-edit-project"
        className="grid max-w-3xl grid-cols-3 gap-4"
      >
        <ProjectCardStandIn
          initialName="alpha"
          href={`${PAGE}&opened=alpha`}
          canWrite={true}
          onRename={(name) => {
            record(`project ${name}`);

            return Promise.resolve();
          }}
        />
        <ProjectCardStandIn
          initialName="beta"
          href={`${PAGE}&opened=beta`}
          canWrite={true}
          onRename={() => Promise.reject(new Error("Name already taken."))}
        />
        <ProjectCardStandIn
          initialName="gamma"
          href={`${PAGE}&opened=gamma`}
          canWrite={false}
          onRename={() => Promise.resolve()}
        />
      </section>

      <section data-fixture="press-links" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Links that go on the press</h2>
        <PressLinks />
      </section>

      <ol data-renamed className="font-mono text-2xs text-muted-foreground">
        {renamed.map((entry, index) => (
          <li key={`${entry}-${index}`} data-renamed-entry>
            {entry}
          </li>
        ))}
      </ol>
    </main>
  );
}

/** A heading that renames from the button beside it, as a panel title would. */
function NameField({
  onRename,
}: {
  onRename: (name: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState("Support bot");
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex w-72 items-center gap-2 text-sm font-medium">
      {editing ? (
        <InlineEdit
          value={name}
          label="Agent name"
          onCommit={(next) => {
            setEditing(false);
            setName(next);
            onRename(next);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <span data-name className="min-w-0 flex-1 truncate">
          {name}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        className="cursor-pointer"
        onClick={() => setEditing(true)}
      >
        Rename
      </Button>
    </div>
  );
}

/** One writable agent card on a real canvas, renamed by a double-click of its name. */
function CardCanvas({
  onRename,
}: {
  onRename: (name: string) => void;
}): React.JSX.Element {
  const [nodes, setNodes] = useState<Node[]>(CARD_NODES);
  const frames = useMemo(
    (): CanvasFramesValue => ({
      agentBadges: {},
      canWrite: true,
      expandedMemberId: null,
      machineConnections: [],
      mcpServers: new Map(),
      mountTargetsOf: () => [],
      onRenameNode: (nodeId, label) => {
        setNodes((current) =>
          current.map((node) =>
            node.id === nodeId
              ? { ...node, data: { ...node.data, label: label } }
              : node,
          ),
        );
        onRename(label);
      },
      onSetWorkspaceMount: () => undefined,
      onToggleFrame: () => undefined,
      sandboxOrderNumbers: new Map(),
      workspaceOnlySandboxIds: new Set(),
    }),
    [onRename],
  );

  return (
    <InfraAnalysisProvider value={CARD_ANALYSIS}>
      <CanvasFramesProvider value={frames}>
        <div className="h-60 w-xl rounded-lg border border-border">
          <ReactFlow
            nodes={nodes}
            edges={[]}
            nodeTypes={CANVAS_NODE_TYPES}
            edgeTypes={CANVAS_EDGE_TYPES}
            colorMode="dark"
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            maxZoom={1}
            onNodesChange={(changes) =>
              setNodes((current) => applyNodeChanges(changes, current))
            }
            proOptions={{ hideAttribution: true }}
          >
            <Background bgColor="#000" />
          </ReactFlow>
        </div>
      </CanvasFramesProvider>
    </InfraAnalysisProvider>
  );
}

/** A project card whose rename sticks the way the optimistic update makes it. */
function ProjectCardStandIn({
  initialName,
  href,
  canWrite,
  onRename,
}: {
  initialName: string;
  href: string;
  canWrite: boolean;
  onRename: (name: string) => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState(initialName);

  return (
    <ProjectCard
      name={name}
      description={`The ${initialName} project`}
      href={href}
      canWrite={canWrite}
      onRename={(next) => {
        setName(next);

        return onRename(next).catch((error: unknown) => {
          setName(initialName);
          throw error;
        });
      }}
    />
  );
}

/**
 * A link, a button and a menu item on the shared handlers, and a current link
 * that resets.
 */
function PressLinks(): React.JSX.Element {
  const { handlers } = useRouteIntent();
  const opened = useSearchParams().get("opened");
  const linkHref = `${PAGE}&opened=link`;
  const buttonHref = `${PAGE}&opened=button`;
  const menuHref = `${PAGE}&opened=menu`;

  return (
    <nav aria-label="Press links" className="flex items-center gap-4 text-sm">
      <Link
        href={linkHref}
        prefetch={false}
        {...handlers(linkHref)}
        draggable={false}
      >
        Open by link
      </Link>
      <Button
        variant="outline"
        size="sm"
        className="cursor-pointer"
        {...handlers(buttonHref)}
      >
        Open by button
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="cursor-pointer">
              Projects
            </Button>
          }
        />
        <DropdownMenuContent>
          <DropdownMenuItem className="cursor-pointer" {...handlers(menuHref)}>
            Open by menu
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Link
        href={PAGE}
        prefetch={false}
        {...handlers(PAGE, true)}
        draggable={false}
      >
        Reset
      </Link>
      <span data-opened className="font-mono text-xs">
        {opened ?? "none"}
      </span>
    </nav>
  );
}
