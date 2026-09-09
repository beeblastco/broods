"use client";

import { CanvasControls } from "@/app/components/canvas/CanvasControl";
import {
  CanvasSaveStatus,
  type CanvasSaveState,
} from "@/app/components/canvas/CanvasSaveStatus";
import { OnboardingDialog } from "@/app/components/OnboardingDialog";
import { Button } from "@/app/components/ui/button";
import { ReactFlowProvider } from "@xyflow/react";
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

const subscribeNever = (): (() => void) => () => {};

export function UiGallery(): React.JSX.Element {
  const [level, setLevel] = useState("INFO");
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
          search=""
          onSearchChange={() => {}}
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
