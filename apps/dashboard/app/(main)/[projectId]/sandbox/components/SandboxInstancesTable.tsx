"use client";

/**
 * Renders the live persistent sandbox instances for the active org. A search +
 * status toolbar filters the list, results paginate client-side, and each row
 * shows the instance's provider/status/size/image and a suspend↔resume toggle;
 * clicking a row opens the detail sheet (snapshot + terminate live there).
 * Suspending is confirmed first and locks the toggle until the instance settles.
 */

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Switch } from "@/app/components/ui/switch";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useAction } from "convex/react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { SandboxInstanceSheet } from "./SandboxInstanceSheet";
import {
  formatSpecs,
  instanceStatusBadge,
  relativeTime,
  useNow,
} from "./sandboxFormat";

interface Props {
  /** Sandbox instance rows from Convex. */
  instances: Array<Doc<"sandboxInstances">>;
  /** Current project route id, used to build trace deep links. */
  projectId: Id<"projects">;
}

/** Status filter values; "all" disables the status predicate. */
const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "suspending", label: "Suspending" },
  { value: "suspended", label: "Suspended" },
  { value: "terminating", label: "Terminating" },
  { value: "error", label: "Error" },
];

const PAGE_SIZE = 8;

export function SandboxInstancesTable({
  instances,
  projectId,
}: Props): React.JSX.Element {
  const suspend = useAction(api.sandbox.public.suspendSandbox);
  const resume = useAction(api.sandbox.public.resumeSandbox);
  const refresh = useAction(api.sandbox.public.refreshSandbox);
  const searchParams = useSearchParams();
  const now = useNow();

  const [selected, setSelected] = useState<Doc<"sandboxInstances"> | null>(
    null,
  );
  const [confirming, setConfirming] = useState<Doc<"sandboxInstances"> | null>(
    null,
  );
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const refreshedPages = useRef(new Set<string>());

  // Filter by name/externalId/provider substring + status, then paginate. The
  // live query returns the whole (small) list, so filtering client-side is fine.
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return instances.filter((instance) => {
      if (status !== "all" && instance.status !== status) return false;
      if (!needle) return true;

      return (
        instance.name.toLowerCase().includes(needle) ||
        instance.externalId.toLowerCase().includes(needle) ||
        instance.provider.toLowerCase().includes(needle) ||
        (instance.conversationKey?.toLowerCase().includes(needle) ?? false) ||
        (instance.lastUsedTraceId?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [instances, search, status]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE,
  );
  const hasFilters = search.trim() !== "" || status !== "all";
  const refreshKey = pageRows
    .filter(controllable)
    .map((instance) => `${instance.sandboxConfigId}:${instance.reservationKey}`)
    .join("|");

  // Resuming is cheap and reversible, so it runs straight from the toggle; suspending
  // discards the instance's live state and goes through `confirming` first.
  async function toggle(
    instance: Doc<"sandboxInstances">,
    nextRunning: boolean,
  ) {
    if (!controllable(instance)) return;
    setPendingId(instance._id);
    setError(null);
    try {
      const args = {
        sandboxId: instance.sandboxConfigId,
        reservationKey: instance.reservationKey,
      };
      await (nextRunning ? resume(args) : suspend(args));
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lifecycle action failed");
    } finally {
      setPendingId(null);
    }
  }

  async function refreshVisible() {
    const targets = pageRows.filter(controllable);
    if (targets.length === 0) return;
    setRefreshing(true);
    setError(null);
    try {
      await Promise.all(
        targets.map((instance) =>
          refresh({
            sandboxId: instance.sandboxConfigId,
            reservationKey: instance.reservationKey,
          }),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!refreshKey || refreshedPages.current.has(refreshKey)) return;
    refreshedPages.current.add(refreshKey);
    void refreshVisible();
  }, [refreshKey]);

  function traceHref(traceId: string): string {
    const next = new URLSearchParams();
    const stage = searchParams.get("stage");
    if (stage) next.set("stage", stage);
    next.set("tab", "tracing");
    next.set("trace", traceId);

    return `/${projectId}/dashboard?${next.toString()}`;
  }

  /** Resets pagination whenever a filter changes so results stay visible. */
  function setSearchAndReset(value: string) {
    setSearch(value);
    setPage(0);
  }

  function setStatusAndReset(value: string) {
    setStatus(value);
    setPage(0);
  }

  if (instances.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-10 text-center">
        <p className="text-sm text-foreground">No running sandbox instances.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Run an agent against a sandbox and it appears here live. Per-call
          instances last the length of the call, reserved ones until suspended.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-50 flex-1">
          <Search className="absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={search}
            onChange={(event) => setSearchAndReset(event.target.value)}
            placeholder="Search name, id, provider…"
            className="h-8 pl-8 text-xs"
          />
        </div>

        <Select
          items={STATUS_FILTERS}
          value={status}
          onValueChange={(value) => {
            if (value !== null) {
              setStatusAndReset(value);
            }
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="Filter by status"
            className="w-36 cursor-pointer text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                className="cursor-pointer text-xs"
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={refreshVisible}
          disabled={refreshing || !pageRows.some(controllable)}
          className="cursor-pointer disabled:cursor-not-allowed"
        >
          <RefreshCw
            className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
          />
          Refresh visible
        </Button>

        {hasFilters && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => {
              setSearch("");
              setStatus("all");
              setPage(0);
            }}
            aria-label="Clear filters"
            title="Clear filters"
            className="cursor-pointer text-muted-foreground"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-230 text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Name</th>
              <th className="px-4 py-2 text-left font-medium">Provider</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="px-4 py-2 text-left font-medium">Size</th>
              <th className="px-4 py-2 text-left font-medium">Image</th>
              <th className="px-4 py-2 text-left font-medium">Trace</th>
              <th className="px-4 py-2 text-left font-medium">Created</th>
              <th className="px-4 py-2 text-left font-medium">Last used</th>
              <th className="px-4 py-2 text-right font-medium">Running</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((instance) => {
              const running = instance.status === "running";
              const toggleable =
                controllable(instance) &&
                (instance.status === "running" ||
                  instance.status === "suspended") &&
                pendingId !== instance._id;

              return (
                <tr
                  key={instance._id}
                  className="cursor-pointer border-t border-border hover:bg-muted/30"
                  onClick={() => setSelected(instance)}
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-foreground">
                      {instance.name}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {instance.externalId}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {instance.ephemeral
                      ? `${instance.provider} · per-call`
                      : instance.provider}
                  </td>
                  <td className="px-4 py-2.5">
                    {instanceStatusBadge(instance.status)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {formatSpecs(instance.specs)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                    {instance.snapshotId ?? "—"}
                  </td>
                  <td
                    className="px-4 py-2.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {instance.lastUsedTraceId || instance.createdByTraceId ? (
                      <Button
                        nativeButton={false}
                        render={
                          <Link
                            href={traceHref(
                              instance.lastUsedTraceId ??
                                instance.createdByTraceId!,
                            )}
                          />
                        }
                        variant="outline"
                        size="xs"
                        className="cursor-pointer"
                      >
                        <ExternalLink className="size-3" />
                        Trace
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {relativeTime(instance.createdAt, now)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {relativeTime(instance.lastUsedAt, now)}
                  </td>
                  <td
                    className="px-4 py-2.5 text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Switch
                      checked={running}
                      disabled={!toggleable}
                      onCheckedChange={(next) =>
                        next ? toggle(instance, true) : setConfirming(instance)
                      }
                      aria-label={running ? "Suspend" : "Resume"}
                    />
                  </td>
                </tr>
              );
            })}
            {pageRows.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-10 text-center text-xs text-muted-foreground"
                >
                  No instances match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {safePage * PAGE_SIZE + 1}–
            {Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of{" "}
            {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => setPage(safePage - 1)}
              disabled={safePage === 0}
              aria-label="Previous page"
              className="cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span>
              {safePage + 1} / {pageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => setPage(safePage + 1)}
              disabled={safePage >= pageCount - 1}
              aria-label="Next page"
              className="cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {!instances.some(controllable) && (
        <p className="mt-2 text-xs text-muted-foreground">
          Per-call instances, and instances reserved before the registry linked
          their config, can be viewed but not controlled here.
        </p>
      )}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && pendingId === null) setConfirming(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Suspend {confirming?.name}?</DialogTitle>
            <DialogDescription>
              Suspending frees the sandbox&apos;s compute. Running processes are
              stopped and any in-flight agent turn or background job on this
              instance is dropped, and it comes back reset. Files on the
              workspace disk are kept, and you can resume once it has fully
              suspended.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              variant="ghost"
              className="cursor-pointer disabled:cursor-not-allowed"
              disabled={pendingId !== null}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="cursor-pointer disabled:cursor-not-allowed"
              disabled={pendingId !== null}
              onClick={() => confirming && toggle(confirming, false)}
            >
              {pendingId === confirming?._id ? "Suspending…" : "Suspend"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selected && (
        <SandboxInstanceSheet
          instance={selected}
          projectId={projectId}
          now={now}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

/** Lifecycle actions apply only to reserved, non-ephemeral instances. */
function controllable(
  instance: Doc<"sandboxInstances">,
): instance is Doc<"sandboxInstances"> & {
  sandboxConfigId: Id<"sandboxConfigs">;
} {
  return Boolean(instance.sandboxConfigId) && instance.ephemeral !== true;
}
