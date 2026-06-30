"use client";

/**
 * Audit Logs panel: scheduled tasks (cron jobs), memories (file system), and event logs.
 * UI-only scaffold — wire to backend queries when implemented.
 */
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { Separator } from "@/app/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { cn } from "@/app/lib/utils";
import type { Id } from "@broods/convex/_generated/dataModel";
import { ChevronRight, Clock, FileText, FolderOpen, RefreshCw, Zap } from "lucide-react";
import { useState } from "react";

interface Props {
  projectId: Id<"projects">;
  environmentId: Id<"environments"> | null;
}

// --- Mock data ---
const MOCK_SCHEDULED_TASKS = [
  { id: "1", name: "Daily summary digest", schedule: "0 9 * * *", status: "active", lastRun: "2h ago", nextRun: "22h" },
  { id: "2", name: "Weekly report generator", schedule: "0 8 * * 1", status: "active", lastRun: "5d ago", nextRun: "2d" },
  { id: "3", name: "Nightly data sync", schedule: "0 2 * * *", status: "paused", lastRun: "1d ago", nextRun: "—" },
];

const MOCK_MEMORIES = [
  { id: "1", name: "slack-channel-context/", type: "folder", size: "12 files", updated: "3h ago" },
  { id: "2", name: "telegram-conversations/", type: "folder", size: "48 files", updated: "1h ago" },
  { id: "3", name: "project-knowledge.md", type: "file", size: "4.2 KB", updated: "Yesterday" },
  { id: "4", name: "team-preferences.json", type: "file", size: "1.1 KB", updated: "2d ago" },
];

const MOCK_EVENTS = [
  { id: "1", level: "info", message: "Agent 'summarizer' completed task", agent: "summarizer", ts: "2m ago" },
  { id: "2", level: "info", message: "Webhook delivered to https://api.example.com/hook", agent: "notifier", ts: "8m ago" },
  { id: "3", level: "warn", message: "Tool call retried (attempt 2/3): google-search", agent: "researcher", ts: "15m ago" },
  { id: "4", level: "error", message: "Rate limit hit on anthropic provider", agent: "summarizer", ts: "1h ago" },
  { id: "5", level: "info", message: "Cron 'daily-digest' triggered agent run", agent: "summarizer", ts: "2h ago" },
];

function ScheduledTasksView() {
  if (MOCK_SCHEDULED_TASKS.length === 0) {
    return <p className="text-sm text-muted-foreground">No scheduled tasks yet.</p>;
  }

  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {MOCK_SCHEDULED_TASKS.map((task) => (
        <div key={task.id} className="flex items-center gap-4 px-4 py-3">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md",
              task.status === "active"
                ? "bg-foreground/8 text-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            <Zap className="size-3.5" />
          </span>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{task.name}</p>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <code className="font-mono">{task.schedule}</code>
              <span className="flex items-center gap-1">
                <RefreshCw className="size-3" /> {task.lastRun}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="size-3" /> {task.nextRun}
              </span>
            </div>
          </div>

          <span
            className={cn(
              "text-xs",
              task.status === "active" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {task.status === "active" ? "Active" : "Paused"}
          </span>
        </div>
      ))}
    </div>
  );
}

function MemoriesView() {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">
        Memories are file system records managed per channel. Click a folder to browse its contents.
      </p>
      <div className="divide-y divide-border rounded-lg border border-border">
        {MOCK_MEMORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setExpanded(expanded === item.id ? null : item.id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 cursor-pointer"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              {item.type === "folder" ? (
                <FolderOpen className="size-3.5" />
              ) : (
                <FileText className="size-3.5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs text-foreground">{item.name}</p>
              <p className="text-xs text-muted-foreground">{item.size} · {item.updated}</p>
            </div>
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                expanded === item.id && "rotate-90",
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

function EventLogsView() {
  const levelClass: Record<string, string> = {
    info: "text-muted-foreground",
    warn: "text-amber-500",
    error: "text-destructive",
  };

  return (
    <div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {MOCK_EVENTS.map((ev) => (
          <div key={ev.id} className="flex items-start gap-3 px-4 py-2.5">
            <span className={cn("mt-px shrink-0 font-mono text-[10px] uppercase tracking-wide w-8", levelClass[ev.level])}>
              {ev.level}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-foreground">{ev.message}</p>
              <p className="text-[10px] text-muted-foreground">
                agent: <span className="font-mono">{ev.agent}</span>
              </p>
            </div>
            <span className="shrink-0 text-[10px] text-muted-foreground">{ev.ts}</span>
          </div>
        ))}
      </div>
      <Button variant="ghost" size="sm" className="mt-2 cursor-pointer text-xs text-muted-foreground">
        Load more
      </Button>
    </div>
  );
}

/** Audit Logs panel with shadcn Tabs: Scheduled Tasks, Memories, Event Logs. */
export function AuditLogsPanel({ environmentId }: Props) {
  if (!environmentId) {
    return (
      <Section description="Audit logs and memory for this environment.">
        <p className="text-sm text-muted-foreground">
          Select an environment to view its audit logs.
        </p>
      </Section>
    );
  }

  return (
    <Section>
      <div>
        <h3 className="text-sm font-semibold text-foreground">Audit Logs</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Scheduled tasks, agent memories, and a stream of recent events for this environment.
        </p>
      </div>

      <Separator />

      <Tabs defaultValue="scheduled">
        <TabsList className="h-8">
          <TabsTrigger value="scheduled" className="text-xs">Scheduled Tasks</TabsTrigger>
          <TabsTrigger value="memories" className="text-xs">Memories</TabsTrigger>
          <TabsTrigger value="events" className="text-xs">Event Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="scheduled" className="mt-4">
          <ScheduledTasksView />
        </TabsContent>
        <TabsContent value="memories" className="mt-4">
          <MemoriesView />
        </TabsContent>
        <TabsContent value="events" className="mt-4">
          <EventLogsView />
        </TabsContent>
      </Tabs>
    </Section>
  );
}
