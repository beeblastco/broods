"use client";

/**
 * Skills panel — full Claude Skills settings UI.
 * Full-width layout (no bordered box wrapper).
 * Left: skill list sidebar. Right: detail pane with rendered markdown + code toggle.
 * "+" dropdown: Browse skills | Create skill submenu.
 */
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Separator } from "@/app/components/ui/separator";
import { Switch } from "@/app/components/ui/switch";
import { Textarea } from "@/app/components/ui/textarea";
import { cn } from "@/app/lib/utils";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  ChevronDown,
  Code2,
  Download,
  Eye,
  FileText,
  MessageSquare,
  MoreVertical,
  Pencil,
  Plus,
  Replace,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import React, { Fragment, useMemo, useState } from "react";

interface Props {
  projectId: Id<"projects">;
  environmentId: Id<"environments"> | null;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  addedBy: string;
  lastUpdated: string;
  trigger: string;
  category: "personal" | "builtin";
  content: string;
}

// ─── Data ────────────────────────────────────────────────────────────────────

const INITIAL_SKILLS: Skill[] = [
  {
    id: "google-drive",
    name: "google-drive",
    description: "Access and manage Google Drive files, folders, and documents. Trigger on: any file or document related request.",
    enabled: true,
    addedBy: "You",
    lastUpdated: "Jun 20, 2026",
    trigger: "Auto",
    category: "personal",
    content: `---
name: google-drive
description: "Access and manage Google Drive files, folders, and documents."
trigger: on any file or document related request
---

# Google Drive — File Manager

## Drive Config

| Field | Value |
|-------|-------|
| Scope | drive.readonly, drive.file |
| Auth  | OAuth 2.0 |
| Quota | 100 req/min |

> ⚠️ To rotate credentials: go to console.cloud.google.com/credentials, then replace the value above.

## Step 1 — ALWAYS Do This First: List Recent Files

Every time this skill activates, run the following before doing anything else:

\`\`\`bash
curl -s \\
  -H "Authorization: Bearer \$TOKEN" \\
  "https://www.googleapis.com/drive/v3/files?pageSize=10&orderBy=modifiedTime%20desc"
\`\`\`

## Capabilities

- Search and retrieve files by name or content
- Read Google Docs, Sheets, and Slides
- Upload new files and create folders
- Manage file permissions and sharing
- Batch operations on multiple files`,
  },
  {
    id: "github-agent",
    name: "github-agent",
    description: "Access GitHub repositories, issues, pull requests, and run code searches. Trigger on: /github or any repository-related request.",
    enabled: false,
    addedBy: "You",
    lastUpdated: "Jun 18, 2026",
    trigger: "Slash command + auto",
    category: "personal",
    content: `---
name: github-agent
description: "Access GitHub repositories, issues, PRs, and code search."
trigger: /github or on any repository-related request
---

# GitHub Agent

## Repo Config

| Field  | Value |
|--------|-------|
| Repo   | kienphung3004/obsidian |
| Branch | \`main\` |
| Token  | \`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\` |

> ⚠️ To rotate token: generate a new PAT at github.com/settings/tokens (scope: \`repo\`), then replace the value above.

## Step 1 — ALWAYS Do This First: Fetch Vault Structure

Every time this skill activates, run the following before doing anything else:

\`\`\`bash
curl -s \\
  -H "Authorization: token github_pat_11BLDP4BY016fJ6qxX2AP3_ERdDoa3W4Qca..." \\
  "https://api.github.com/repos/kienphung3004/obsidian/git/trees/main?recursive=1" \\
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
tree = data.get('tree', [])
folders = {}
for item in tree:
    if item['type'] == 'blob' and item['path'].endswith('.md'):
        parts = item['path'].split('/')
\`\`\`

## Capabilities

- List and search repositories
- Read file content and commit history
- Create and comment on issues
- Open and review pull requests
- Search code across repositories`,
  },
  {
    id: "notion-sync",
    name: "notion-sync",
    description: "Read, create, and update Notion pages and databases. Trigger on: any note, page, or knowledge base request.",
    enabled: true,
    addedBy: "You",
    lastUpdated: "Jun 16, 2026",
    trigger: "Auto",
    category: "personal",
    content: `---
name: notion-sync
description: "Read, create, and update Notion pages and databases."
trigger: on any note, page, or knowledge base request
---

# Notion Sync

## Capabilities

- Search pages and databases by title or content
- Read and update page blocks
- Create new pages with rich content
- Query and filter database records`,
  },
  {
    id: "web-researcher",
    name: "web-researcher",
    description: "Search the web in real-time using Google Search for current events and research.",
    enabled: false,
    addedBy: "You",
    lastUpdated: "Jun 14, 2026",
    trigger: "Auto",
    category: "personal",
    content: `---
name: web-researcher
description: "Search the web in real-time for research and current events."
trigger: on any research, news, or lookup request
---

# Web Researcher

## Capabilities

- Real-time web search via Google
- News and current events lookup
- Documentation and reference search
- Result summarization`,
  },
  {
    id: "canvas-design",
    name: "canvas-design",
    description: "Create beautiful visual art in .png and .pdf documents using design philosophy.",
    enabled: true,
    addedBy: "You",
    lastUpdated: "Jun 12, 2026",
    trigger: "Auto",
    category: "personal",
    content: `---
name: canvas-design
description: "Create visual art and design documents."
trigger: on any design, art, or visual creation request
---

# Canvas Design

## Capabilities

- Generate .png and .pdf visual documents
- Apply design principles and color theory
- Create diagrams, charts, and infographics`,
  },
  {
    id: "doc-coauthoring",
    name: "doc-coauthoring",
    description: "Guide users through a structured workflow for co-authoring documentation.",
    enabled: true,
    addedBy: "You",
    lastUpdated: "Jun 10, 2026",
    trigger: "Auto",
    category: "personal",
    content: `---
name: doc-coauthoring
description: "Structured workflow for co-authoring documentation."
trigger: on any documentation or writing collaboration request
---

# Doc Co-authoring

## Capabilities

- Structured documentation workflows
- Collaborative editing suggestions
- Style and tone consistency`,
  },
  {
    id: "skill-creator",
    name: "skill-creator",
    description: "Create new skills, modify and improve existing skills, and measure skill performance.",
    enabled: true,
    addedBy: "System",
    lastUpdated: "Jun 1, 2026",
    trigger: "Auto",
    category: "personal",
    content: `---
name: skill-creator
description: "Create new skills, modify existing ones, and measure performance."
trigger: on any skill creation or modification request
---

# Skill Creator

Use when users want to create a new skill or improve an existing one.`,
  },
  {
    id: "schedule",
    name: "schedule",
    description: "Schedule recurring tasks and one-time reminders.",
    enabled: true,
    addedBy: "System",
    lastUpdated: "Jun 1, 2026",
    trigger: "Auto",
    category: "builtin",
    content: `Built-in skill: schedule\nManage cron jobs and scheduled tasks.`,
  },
  {
    id: "setup-cowork",
    name: "setup-cowork",
    description: "Set up collaborative workspaces for multi-agent coordination.",
    enabled: true,
    addedBy: "System",
    lastUpdated: "Jun 1, 2026",
    trigger: "Auto",
    category: "builtin",
    content: `Built-in skill: setup-cowork\nConfigure multi-agent collaboration.`,
  },
  {
    id: "context",
    name: "context",
    description: "Manage conversation context, memory, and agent state.",
    enabled: true,
    addedBy: "System",
    lastUpdated: "Jun 1, 2026",
    trigger: "Auto",
    category: "builtin",
    content: `Built-in skill: context\nManage agent memory and state.`,
  },
  {
    id: "design",
    name: "design",
    description: "Generate designs, mockups, and visual assets.",
    enabled: true,
    addedBy: "System",
    lastUpdated: "Jun 1, 2026",
    trigger: "Auto",
    category: "builtin",
    content: `Built-in skill: design\nCreate visual designs and mockups.`,
  },
];

// Directory skills for Browse dialog
const DIRECTORY_SKILLS = [
  { name: "/canvas-design", author: "Broods", downloads: "1.3M", description: "Create beautiful visual art in .png and .pdf documents using design philosophy." },
  { name: "/doc-coauthoring", author: "Broods", downloads: "567K", description: "Guide users through a structured workflow for co-authoring documentation." },
  { name: "/skill-creator", author: "Broods", downloads: "109.2K", description: "Create new skills, modify and improve existing skills, and measure skill performance." },
  { name: "/web-artifacts-builder", author: "Broods", downloads: "803.1K", description: "Suite of tools for creating elaborate, multi-component HTML artifacts using modern frontend web tech." },
  { name: "/mcp-builder", author: "Broods", downloads: "659.8K", description: "Guide for creating high-quality MCP servers that enable LLMs to interact with external tools." },
  { name: "/theme-factory", author: "Broods", downloads: "641.2K", description: "Toolkit for styling artifacts with a theme. Slides, docs, reportings, HTML landing pages, etc." },
  { name: "/brand-guidelines", author: "Broods", downloads: "584.7K", description: "Applies your brand's official colors and typography to artifacts." },
  { name: "/internal-comms", author: "Broods", downloads: "438.7K", description: "Resources to help write all kinds of internal communications." },
];

// ─── Simple Markdown Renderer ─────────────────────────────────────────────────

function RenderedMarkdown({ content }: { content: string }) {
  const elements = useMemo(() => {
    const lines = content.split("\n");
    const result: React.ReactNode[] = [];
    let i = 0;
    let key = 0;

    while (i < lines.length) {
      const line = lines[i];

      // --- frontmatter
      if (line.trim() === "---") {
        // Skip frontmatter block
        i++;
        while (i < lines.length && lines[i].trim() !== "---") i++;
        i++; // skip closing ---
        continue;
      }

      // Empty line
      if (line.trim() === "") {
        i++;
        continue;
      }

      // Code block
      if (line.trim().startsWith("```")) {
        const lang = line.trim().replace(/^```/, "").trim();
        i++;
        const codeLines: string[] = [];
        while (i < lines.length && !lines[i].trim().startsWith("```")) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing ```
        result.push(
          <div key={key++} className="my-3 rounded-lg border border-border bg-[#1a1a1a] overflow-hidden">
            {lang && (
              <div className="flex items-center justify-between px-4 py-1.5 border-b border-border/50 bg-[#111]">
                <span className="text-[10px] text-muted-foreground font-mono">{lang}</span>
                <button type="button" className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                  <FileText className="size-3" />
                </button>
              </div>
            )}
            <pre className="px-4 py-3 text-xs font-mono leading-relaxed overflow-x-auto">
              {codeLines.map((cl, ci) => {
                // Basic syntax highlighting for bash/python
                let highlighted = cl;
                if (lang === "bash") {
                  highlighted = cl
                    .replace(/^(\s*)(curl|python3|import|from|for|if|data|tree|folders|item|parts|echo|cat|grep)(\b)/g, "$1$2$3");
                }
                return (
                  <div key={ci} className="flex">
                    <span className="text-green-400/70">{highlighted.replace(/\\$/g, " \\")}</span>
                  </div>
                );
              })}
            </pre>
          </div>,
        );
        continue;
      }

      // Table
      if (line.includes("|") && lines[i + 1]?.includes("---")) {
        const tableLines: string[] = [];
        while (i < lines.length && lines[i].includes("|")) {
          tableLines.push(lines[i]);
          i++;
        }
        const headers = tableLines[0].split("|").map((h) => h.trim()).filter(Boolean);
        const rows = tableLines.slice(2).map((r) => r.split("|").map((c) => c.trim()).filter(Boolean));
        result.push(
          <div key={key++} className="my-3 rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  {headers.map((h, hi) => (
                    <th key={hi} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri} className="border-b border-border last:border-0">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-4 py-2 text-sm text-foreground">
                        {cell.startsWith("`") && cell.endsWith("`") ? (
                          <code className="rounded bg-accent/50 px-1.5 py-0.5 font-mono text-xs text-emerald-400">{cell.slice(1, -1)}</code>
                        ) : cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }

      // Blockquote / warning
      if (line.startsWith(">")) {
        const text = line.replace(/^>\s*/, "");
        const isWarning = text.includes("⚠️");
        result.push(
          <div key={key++} className={cn("my-3 rounded-lg border px-4 py-3 text-sm", isWarning ? "border-yellow-500/30 bg-yellow-500/5 text-yellow-200" : "border-border bg-muted/20 text-muted-foreground")}>
            {text}
          </div>,
        );
        i++;
        continue;
      }

      // Heading
      if (line.startsWith("# ")) {
        result.push(<h1 key={key++} className="text-xl font-bold text-foreground mt-6 mb-2">{line.replace(/^#\s+/, "")}</h1>);
        i++;
        continue;
      }
      if (line.startsWith("## ")) {
        result.push(<h2 key={key++} className="text-base font-semibold text-foreground mt-5 mb-2">{line.replace(/^##\s+/, "")}</h2>);
        i++;
        continue;
      }
      if (line.startsWith("### ")) {
        result.push(<h3 key={key++} className="text-sm font-semibold text-foreground mt-4 mb-1">{line.replace(/^###\s+/, "")}</h3>);
        i++;
        continue;
      }

      // List item
      if (line.match(/^\s*-\s/)) {
        const listItems: string[] = [];
        while (i < lines.length && lines[i].match(/^\s*-\s/)) {
          listItems.push(lines[i].replace(/^\s*-\s/, ""));
          i++;
        }
        result.push(
          <ul key={key++} className="my-2 space-y-1 pl-4">
            {listItems.map((item, li) => (
              <li key={li} className="flex items-start gap-2 text-sm text-foreground">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" />
                {item}
              </li>
            ))}
          </ul>,
        );
        continue;
      }

      // Regular paragraph
      result.push(
        <p key={key++} className="my-2 text-sm text-foreground leading-relaxed">
          {line.split(/(`[^`]+`)/).map((part, pi) =>
            part.startsWith("`") && part.endsWith("`") ? (
              <code key={pi} className="rounded bg-accent/50 px-1.5 py-0.5 font-mono text-xs text-emerald-400">{part.slice(1, -1)}</code>
            ) : (
              <Fragment key={pi}>{part}</Fragment>
            ),
          )}
        </p>,
      );
      i++;
    }

    return result;
  }, [content]);

  return <div>{elements}</div>;
}

// ─── Code View with Line Numbers ──────────────────────────────────────────────

function CodeView({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="rounded-lg border border-border bg-[#1a1a1a] overflow-hidden">
      <pre className="overflow-auto max-h-[600px]">
        <table className="w-full text-xs font-mono leading-relaxed">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-white/5">
                <td className="select-none px-3 py-0 text-right text-muted-foreground/40 w-10 align-top">{i + 1}</td>
                <td className="px-3 py-0 text-foreground whitespace-pre-wrap">
                  {/* Basic highlighting */}
                  {line.startsWith("#") ? (
                    <span className="text-emerald-400">{line}</span>
                  ) : line.startsWith(">") ? (
                    <span className="text-yellow-400">{line}</span>
                  ) : line.startsWith("```") ? (
                    <span className="text-sky-400">{line}</span>
                  ) : line.startsWith("|") ? (
                    <span className="text-foreground">{line}</span>
                  ) : line.startsWith("---") ? (
                    <span className="text-muted-foreground">{line}</span>
                  ) : line.startsWith("  ") ? (
                    <span className="text-green-400">{line}</span>
                  ) : (
                    line
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </pre>
    </div>
  );
}

// ─── Browse Skills Directory Dialog ───────────────────────────────────────────

function BrowseSkillsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"skills" | "connectors" | "plugins">("skills");
  const filtered = DIRECTORY_SKILLS.filter((s) =>
    s.name.toLowerCase().includes(query.toLowerCase()) || s.description.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl p-0 gap-0 max-h-[80vh] flex flex-col">
        <DialogHeader className="px-6 pt-5 pb-0 shrink-0">
          <DialogTitle className="text-lg font-semibold">Directory</DialogTitle>
        </DialogHeader>
        <div className="flex flex-1 overflow-hidden">
          <div className="w-44 shrink-0 border-r border-border p-3 space-y-1">
            {([
              { key: "skills" as const, label: "Skills", icon: <FileText className="size-3.5" /> },
              { key: "connectors" as const, label: "Connectors", icon: <Settings2 className="size-3.5" /> },
              { key: "plugins" as const, label: "Plugins", icon: <Settings2 className="size-3.5" /> },
            ]).map((t) => (
              <button key={t.key} type="button" onClick={() => setTab(t.key)}
                className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm cursor-pointer transition-colors",
                  tab === t.key ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent/50")}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills..." className="pl-9 text-sm h-9" />
              </div>
              <span className="rounded-full bg-foreground/10 px-3 py-1 text-xs font-medium text-foreground">Broods</span>
            </div>
            <div className="flex-1 overflow-auto p-5">
              <div className="grid grid-cols-2 gap-3">
                {filtered.map((skill) => (
                  <div key={skill.name} className="rounded-xl border border-border bg-card p-4 hover:bg-accent/30 transition-colors cursor-pointer">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground">{skill.name}</p>
                        <p className="text-xs text-muted-foreground">{skill.author} • ↓ {skill.downloads}</p>
                      </div>
                      <button type="button" className="shrink-0 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer">
                        <Plus className="size-4" />
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground leading-relaxed line-clamp-2">{skill.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Write Skill Instructions Dialog ──────────────────────────────────────────

function WriteSkillDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg gap-5">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Write skill instructions</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label className="text-sm font-medium text-foreground">Skill name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="weekly-status-report" className="text-sm" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-sm font-medium text-foreground">Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Generate weekly status reports from recent work. Use when asked for updates or progress summaries." rows={3} className="text-sm resize-none" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-sm font-medium text-foreground">Instructions</Label>
            <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)}
              placeholder="Summarize my recent work in three sections: wins, blockers, and next steps. Keep the tone professional but not stiff..." rows={6} className="text-sm resize-none" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" className="cursor-pointer" disabled={!name.trim()}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function PluginsPanel({ environmentId }: Props) {
  const [skills, setSkills] = useState<Skill[]>(INITIAL_SKILLS);
  const [selectedId, setSelectedId] = useState<string>(INITIAL_SKILLS[0]?.id ?? "");
  const [viewMode, setViewMode] = useState<"rendered" | "code">("rendered");
  const [browseOpen, setBrowseOpen] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);

  if (!environmentId) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        Select an environment to manage its skills.
      </p>
    );
  }

  const personalSkills = skills.filter((s) => s.category === "personal");
  const builtinSkills = skills.filter((s) => s.category === "builtin");
  const selected = skills.find((s) => s.id === selectedId) ?? null;

  function toggleSkill(id: string) {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  }

  return (
    <>
      {/* Full-width two-pane layout */}
      <div className="flex min-h-0 flex-1" style={{ minHeight: 580 }}>
        {/* ── Left sidebar ── */}
        <div className="w-60 shrink-0 border-r border-border flex flex-col bg-card/30">
          {/* Sidebar header: Skills Q + */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-sm font-semibold text-foreground">Skills</span>
            <div className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon-xs" className="cursor-pointer text-muted-foreground hover:text-foreground">
                <Search className="size-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" className="cursor-pointer text-muted-foreground hover:text-foreground">
                    <Plus className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem className="cursor-pointer text-sm gap-2" onClick={() => setBrowseOpen(true)}>
                    <FileText className="size-3.5 text-muted-foreground" /> Browse skills
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="cursor-pointer text-sm gap-2">
                      <Plus className="size-3.5 text-muted-foreground" /> Create skill
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-48">
                      <DropdownMenuItem className="cursor-pointer text-sm gap-2">
                        <Sparkles className="size-3.5 text-muted-foreground" /> Create with AI
                      </DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer text-sm gap-2" onClick={() => setWriteOpen(true)}>
                        <Pencil className="size-3.5 text-muted-foreground" /> Write skill instructions
                      </DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer text-sm gap-2">
                        <Upload className="size-3.5 text-muted-foreground" /> Upload a skill
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Skill list */}
          <div className="flex-1 overflow-auto py-2">
            {/* Personal skills section */}
            <div className="px-4 pt-2 pb-1.5">
              <p className="text-[9px] uppercase tracking-widest text-muted-foreground/60 font-semibold flex items-center gap-1">
                <ChevronDown className="size-3" /> Personal skills
              </p>
            </div>
            {personalSkills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => { setSelectedId(skill.id); setViewMode("rendered"); }}
                className={cn(
                  "flex w-full items-center px-4 py-2 text-left text-sm cursor-pointer transition-colors",
                  selectedId === skill.id
                    ? "bg-accent text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/40",
                )}
              >
                <span className="truncate">{skill.name}</span>
              </button>
            ))}

            {/* Built-in skills section */}
            <div className="px-4 pt-4 pb-1.5">
              <p className="text-[9px] uppercase tracking-widest text-muted-foreground/60 font-semibold flex items-center gap-1">
                <ChevronDown className="size-3" /> Built-in skills
              </p>
            </div>
            {builtinSkills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => { setSelectedId(skill.id); setViewMode("rendered"); }}
                className={cn(
                  "flex w-full items-center px-4 py-2 text-left text-sm cursor-pointer transition-colors",
                  selectedId === skill.id
                    ? "bg-accent text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/40",
                )}
              >
                <span className="truncate">{skill.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ── Right detail pane ── */}
        {selected ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Detail header */}
            <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-3">
              <h3 className="text-base font-semibold text-foreground">{selected.name}</h3>
              <div className="flex items-center gap-2">
                <div onClick={(e) => e.stopPropagation()}>
                  <Switch checked={selected.enabled} onCheckedChange={() => toggleSkill(selected.id)} aria-label={`Toggle ${selected.name}`} />
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-xs" className="cursor-pointer text-muted-foreground hover:text-foreground">
                      <MoreVertical className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem className="cursor-pointer text-sm gap-2">
                      <MessageSquare className="size-3.5 text-muted-foreground" /> Try in chat
                    </DropdownMenuItem>
                    <DropdownMenuItem className="cursor-pointer text-sm gap-2">
                      <Pencil className="size-3.5 text-muted-foreground" /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem className="cursor-pointer text-sm gap-2">
                      <Sparkles className="size-3.5 text-muted-foreground" /> Edit with AI
                    </DropdownMenuItem>
                    <DropdownMenuItem className="cursor-pointer text-sm gap-2">
                      <Replace className="size-3.5 text-muted-foreground" /> Replace
                    </DropdownMenuItem>
                    <DropdownMenuItem className="cursor-pointer text-sm gap-2">
                      <Download className="size-3.5 text-muted-foreground" /> Download
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="cursor-pointer text-sm gap-2 text-destructive focus:text-destructive">
                      <Trash2 className="size-3.5" /> Uninstall
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Detail body */}
            <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
              {/* Metadata row */}
              <div className="flex items-center gap-6 text-xs">
                <div><span className="text-muted-foreground">Added by</span>{" "}<span className="text-foreground">{selected.addedBy}</span></div>
                <div><span className="text-muted-foreground">Last updated</span>{" "}<span className="text-foreground">{selected.lastUpdated}</span></div>
                <div><span className="text-muted-foreground">Trigger</span>{" "}<span className="text-foreground">{selected.trigger}</span></div>
              </div>

              {/* Description */}
              <div>
                <p className="text-xs text-muted-foreground mb-1">Description ⓘ</p>
                <p className="text-sm text-foreground leading-relaxed">{selected.description}</p>
              </div>

              <Separator />

              {/* Content area with view toggle */}
              <div>
                {/* View toggle buttons */}
                <div className="flex items-center justify-end gap-1 mb-3">
                  <button
                    type="button"
                    onClick={() => setViewMode("rendered")}
                    title="Rendered view"
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md transition-colors cursor-pointer",
                      viewMode === "rendered"
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                    )}
                  >
                    <Eye className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("code")}
                    title="Code view"
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md transition-colors cursor-pointer",
                      viewMode === "code"
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                    )}
                  >
                    <Code2 className="size-3.5" />
                  </button>
                </div>

                {viewMode === "rendered" ? (
                  <RenderedMarkdown content={selected.content} />
                ) : (
                  <CodeView content={selected.content} />
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Select a skill to view its details.</p>
          </div>
        )}
      </div>

      <BrowseSkillsDialog open={browseOpen} onOpenChange={setBrowseOpen} />
      <WriteSkillDialog open={writeOpen} onOpenChange={setWriteOpen} />
    </>
  );
}
