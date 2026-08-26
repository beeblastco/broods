"use client";

/** Local unauthenticated preview for checking dashboard UI without WorkOS. */
import {
  Activity,
  Bot,
  Check,
  CircleDot,
  Code2,
  Database,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  MessageSquareText,
  Play,
  Plus,
  Server,
  Settings,
  Sparkles,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";

const nodes = [
  {
    id: "runtime",
    icon: Server,
    name: "Runtime",
    detail: "gateway.dev.broods.app",
    tone: "border-cyan-400/40 bg-cyan-400/10 text-cyan-100",
  },
  {
    id: "planner",
    icon: Bot,
    name: "Planner",
    detail: "5 tools, 2 skills",
    tone: "border-emerald-400/40 bg-emerald-400/10 text-emerald-100",
  },
  {
    id: "memory",
    icon: Database,
    name: "Memory",
    detail: "Convex dev",
    tone: "border-amber-400/40 bg-amber-400/10 text-amber-100",
  },
  {
    id: "builder",
    icon: Sparkles,
    name: "Builder",
    detail: "draft_skill ready",
    tone: "border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-100",
  },
] as const;

const messages = [
  {
    role: "Builder",
    text: "I found a reusable skill shape for customer triage. Draft is ready to review.",
  },
  {
    role: "You",
    text: "Test it against refund, bug report, and enterprise lead examples.",
  },
  {
    role: "Builder",
    text: "3 checks passed. The refund case still needs a clearer escalation rule.",
  },
];

const tabs = ["Monitoring", "Tracing", "Usage", "API key"] as const;
const navItems = [
  { icon: LayoutDashboard, label: "Architecture", active: true },
  { icon: Activity, label: "Observability", active: false },
  { icon: Workflow, label: "Scheduler", active: false },
  { icon: TerminalSquare, label: "Sandbox", active: false },
  { icon: Code2, label: "Files", active: false },
] as const;

export default function LocalPreviewPage(): React.JSX.Element {
  const [activeTab, setActiveTab] =
    useState<(typeof tabs)[number]>("Monitoring");
  const [builderOpen, setBuilderOpen] = useState(true);
  const score = useMemo(
    () =>
      activeTab === "Usage"
        ? "18.4k"
        : activeTab === "Tracing"
          ? "42"
          : "99.9%",
    [activeTab],
  );

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-5">
        <Image
          src="/assets/logo/dark-broods-full.svg"
          alt="Broods"
          width={232}
          height={64}
          className="h-7 w-auto"
          priority
        />
        <div className="mx-4 h-4 w-px bg-border" />
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-200">
            Local preview
          </span>
          <span className="truncate text-muted-foreground">
            no WorkOS session required
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Settings"
          >
            <Settings className="size-4" />
          </button>
          <a
            href="/auth/sign-in?returnTo=/"
            className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium hover:bg-muted"
          >
            <KeyRound className="size-4" />
            Sign in
          </a>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
        <aside className="border-r border-border bg-muted/20 p-3">
          <nav className="flex flex-col gap-1 text-sm">
            {navItems.map(({ icon: Icon, label, active }) => (
              <button
                key={label}
                type="button"
                className={`flex h-9 items-center gap-2 rounded-md px-3 text-left ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </nav>
        </aside>

        <section className="grid min-h-0 grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
              <div>
                <h1 className="text-sm font-semibold">Manus Reference App</h1>
                <p className="text-xs text-muted-foreground">
                  dev stage · localhost preview
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs hover:bg-muted"
                >
                  <GitBranch className="size-4" />
                  dev
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <Play className="size-4" />
                  Run
                </button>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_190px]">
              <div className="relative overflow-hidden bg-[radial-gradient(circle_at_30%_20%,rgba(34,211,238,0.10),transparent_28%),radial-gradient(circle_at_78%_72%,rgba(16,185,129,0.10),transparent_30%)]">
                <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:32px_32px]" />
                <div className="relative grid h-full place-items-center p-8">
                  <div className="grid w-full max-w-4xl grid-cols-2 gap-5">
                    {nodes.map((node) => {
                      const Icon = node.icon;

                      return (
                        <div
                          key={node.id}
                          className={`rounded-lg border p-4 shadow-2xl shadow-black/20 ${node.tone}`}
                        >
                          <div className="flex items-center gap-3">
                            <div className="grid size-10 place-items-center rounded-md bg-background/70">
                              <Icon className="size-5" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold">
                                {node.name}
                              </p>
                              <p className="truncate text-xs opacity-75">
                                {node.detail}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="border-t border-border p-4">
                <div className="mb-3 flex items-center gap-1">
                  {tabs.map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                      className={`h-8 rounded-md px-3 text-xs font-medium ${
                        activeTab === tab
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <Metric label={activeTab} value={score} />
                  <Metric label="Requests" value="1,284" />
                  <Metric label="Errors" value="3" />
                </div>
              </div>
            </div>
          </div>

          <aside
            className={`min-h-0 border-l border-border bg-muted/10 ${
              builderOpen ? "flex" : "hidden"
            } flex-col`}
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
              <div className="flex items-center gap-2">
                <MessageSquareText className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">Builder</h2>
              </div>
              <button
                type="button"
                onClick={() => setBuilderOpen(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Hide
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {messages.map((message) => (
                <div
                  key={`${message.role}-${message.text}`}
                  className="text-sm"
                >
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {message.role}
                  </p>
                  <p className="rounded-lg border border-border bg-background p-3 leading-6">
                    {message.text}
                  </p>
                </div>
              ))}
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <Check className="size-4" />
                  Skill draft validated
                </div>
                <p className="text-xs leading-5 text-emerald-100/75">
                  Accept/Discard is shown here in the live app after Builder
                  returns a draft.
                </p>
              </div>
            </div>

            <div className="border-t border-border p-3">
              <div className="flex h-10 items-center rounded-md border border-border bg-background px-3 text-xs text-muted-foreground">
                Ask Builder to add a tool...
                <Plus className="ml-auto size-4" />
              </div>
            </div>
          </aside>

          {!builderOpen && (
            <button
              type="button"
              onClick={() => setBuilderOpen(true)}
              className="absolute bottom-4 right-4 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
            >
              <CircleDot className="size-4" />
              Builder
            </button>
          )}
        </section>
      </div>
    </main>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}
