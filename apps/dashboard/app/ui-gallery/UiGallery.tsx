"use client";

import {
  CanvasControls,
  FIT_VIEW_OPTIONS,
} from "@/app/components/canvas/CanvasControl";
import {
  CanvasSaveStatus,
  type CanvasSaveState,
} from "@/app/components/canvas/CanvasSaveStatus";
import { OnboardingDialog } from "@/app/components/OnboardingDialog";
import { Button } from "@/app/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { ObservabilityToolbar } from "../(main)/[projectId]/dashboard/components/ObservabilityToolbar";

const LEVEL_OPTIONS = [
  { value: "all", label: "All levels" },
  { value: "ERROR", label: "ERROR" },
  { value: "WARN", label: "WARN" },
  { value: "INFO", label: "INFO" },
  { value: "DEBUG", label: "DEBUG" },
];

const SAVE_STATES: CanvasSaveState[] = ["idle", "saving", "saved", "error"];

// Enough rows for the stand-in table to scroll, so its head really sticks.
const STAND_IN_ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Side-panel tab labels, the row a press most often wanders off. */
const PRESS_TABS = ["Details", "Config", "Settings"];

/**
 * Six cards in two rows, the shape a small stage lands in after a tidy. Sized
 * explicitly so the bounds the canvas fits are the same on every machine, and
 * chosen so the fit zoom lands between ReactFlow's 0.5 floor and our 1.5 cap.
 */
const FIT_NODES: Node[] = [0, 250, 500].flatMap((x) =>
  [0, 260].map((y) => ({
    id: `fit-${x}-${y}`,
    position: { x: x, y: y },
    width: 150,
    height: 40,
    data: { label: `${x},${y}` },
  })),
);

const subscribeNever = (): (() => void) => () => {};

export function UiGallery(): React.JSX.Element {
  const [level, setLevel] = useState("INFO");
  const [search, setSearch] = useState("");
  const [pressLevel, setPressLevel] = useState("INFO");
  const [pressTab, setPressTab] = useState(PRESS_TABS[0]);
  const [pressCount, setPressCount] = useState(0);
  const [saveState, setSaveState] = useState<CanvasSaveState>("idle");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // False in the server HTML, true once React owns the page: a spec waits on
  // it so its first interaction lands on a listener, not on static markup.
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

  return (
    <main
      className="flex flex-col gap-10 p-8"
      data-hydrated={hydrated ? "true" : undefined}
    >
      <section
        data-fixture="observability-toolbar"
        className="flex flex-col gap-2"
      >
        <h2 className="text-sm font-medium">Observability toolbar</h2>
        <ObservabilityToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search logs…"
          filterAriaLabel="Filter by log level"
          filterValue={level}
          filterOptions={LEVEL_OPTIONS}
          onFilterChange={setLevel}
          fromTime=""
          onFromTimeChange={() => {}}
          toTime=""
          onToTimeChange={() => {}}
          hasFilters={false}
          onClear={() => {}}
          onRefresh={() => {}}
          refreshDisabled={false}
          refreshSpinning={false}
          refreshTitle="Refresh"
          isError={false}
        />
        <LogTableStandIn />
      </section>

      <section data-fixture="canvas-controls" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Canvas controls</h2>
        <div className="relative h-40 w-80 rounded-lg border border-border">
          <ReactFlowProvider>
            <div className="absolute top-2 left-2">
              <CanvasControls onTidy={() => {}} />
            </div>
          </ReactFlowProvider>
          <div className="absolute bottom-2 left-2">
            <CanvasSaveStatus state={saveState} onRetry={() => {}} />
          </div>
        </div>
        <div className="flex gap-2">
          {SAVE_STATES.map((state) => (
            <Button
              key={state}
              size="sm"
              variant="outline"
              className="cursor-pointer"
              data-save-state={state}
              onClick={() => setSaveState(state)}
            >
              {state}
            </Button>
          ))}
        </div>
      </section>

      <section data-fixture="canvas-fit" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Canvas fit on open</h2>
        {/* The real ReactFlow, fitted the way the Architecture page fits on its
            first paint, so a spec can measure what the frame actually shows. */}
        <div className="h-80 w-[36rem] rounded-lg border border-border">
          <ReactFlow
            nodes={FIT_NODES}
            edges={[]}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            maxZoom={FIT_VIEW_OPTIONS.maxZoom}
          />
        </div>
      </section>

      <section data-fixture="press-drag" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Press that wanders</h2>
        {/* One of each control a press lands on, with the state it changes
            rendered next to it, so a spec can press with a few pixels of
            travel and assert the press still counted. */}
        <nav
          aria-label="Press row"
          className="flex flex-wrap items-center gap-3"
        >
          <Button size="sm" onClick={() => setPressCount(pressCount + 1)}>
            Deploy the stage
          </Button>
          <Tabs value={pressTab} onValueChange={setPressTab}>
            <TabsList variant="line">
              {PRESS_TABS.map((tab) => (
                <TabsTrigger key={tab} value={tab}>
                  {tab}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Select
            items={LEVEL_OPTIONS}
            value={pressLevel}
            onValueChange={(value) => {
              if (value !== null) {
                setPressLevel(value);
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Press filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Link
            href="/ui-gallery"
            draggable={false}
            className="cursor-pointer select-none rounded-md px-2.5 py-1.5 text-sm font-medium hover:bg-accent"
          >
            Architecture
          </Link>
        </nav>
        <p className="text-xs text-muted-foreground">
          pressed <span data-press-count>{pressCount}</span>, tab{" "}
          <span data-press-tab>{pressTab}</span>, level{" "}
          <span data-press-level>{pressLevel}</span>
        </p>
      </section>

      <section data-fixture="onboarding" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Onboarding</h2>
        <Button
          size="sm"
          variant="outline"
          className="w-fit cursor-pointer"
          onClick={() => setOnboardingOpen(true)}
        >
          Open onboarding
        </Button>
        {onboardingOpen && (
          <OnboardingDialog
            secret="fixture-account-secret-not-a-real-credential"
            onDone={() => setOnboardingOpen(false)}
          />
        )}
      </section>
    </main>
  );
}

/**
 * The piece of MonitoringPanel that broke the level select: a sticky, raised
 * table head right under the toolbar. Without page chrome like this below it,
 * a popup that fails to stack above the page still looks perfectly fine.
 */
function LogTableStandIn(): React.JSX.Element {
  return (
    <div className="flex h-50 overflow-hidden rounded-lg border border-border bg-card">
      <div className="min-w-0 flex-1 overflow-auto">
        <table className="w-full table-fixed font-mono text-xs">
          <thead className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur">
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Level</th>
              <th className="px-3 py-2 font-medium">Service</th>
              <th className="px-3 py-2 font-medium">Message</th>
            </tr>
          </thead>
          <tbody>
            {STAND_IN_ROWS.map((row) => (
              <tr key={row} className="border-b border-border/40">
                <td className="px-3 py-1.5 text-muted-foreground">08:0{row}</td>
                <td className="px-3 py-1.5">INFO</td>
                <td className="px-3 py-1.5">gateway</td>
                <td className="px-3 py-1.5">stand-in row {row}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
