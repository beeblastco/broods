"use client";

/**
 * Connections panel — channel integrations.
 * Real inline SVG brand logos (no CDN dependency).
 * "Add connector" dropdown → Browse connectors | Add custom connector.
 * Card click → Tool Permissions sheet.
 */
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/app/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Separator } from "@/app/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/app/components/ui/sheet";
import { Switch } from "@/app/components/ui/switch";
import { cn } from "@/app/lib/utils";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  Ban,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useState } from "react";

interface Props {
  projectId: Id<"projects">;
  environmentId: Id<"environments"> | null;
}

// ─── Proper Inline SVG Logos ─────────────────────────────────────────────────

function SlackLogo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 123 123" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9zM32.3 77.6a12.9 12.9 0 1 1 25.8 0v32.3a12.9 12.9 0 1 1-25.8 0V77.6z" fill="#E01E5A"/>
      <path d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2zM45.2 32.3a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 1 1 0-25.8h32.3z" fill="#36C5F0"/>
      <path d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97V45.2zM90.5 45.2a12.9 12.9 0 0 1-25.8 0V12.9a12.9 12.9 0 1 1 25.8 0v32.3z" fill="#2EB67D"/>
      <path d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97h12.9zM77.6 90.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 1 1 0 25.8H77.6z" fill="#ECB22E"/>
    </svg>
  );
}

function TelegramLogo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="tg" x1="120" y1="0" x2="120" y2="240" gradientUnits="userSpaceOnUse"><stop stopColor="#2AABEE"/><stop offset="1" stopColor="#229ED9"/></linearGradient></defs>
      <circle cx="120" cy="120" r="120" fill="url(#tg)"/>
      <path d="M98 175c-3.9 0-3.2-1.5-4.6-5.2L82 132.2 170 80" fill="#C8DAEA"/>
      <path d="M98 175c3 0 4.3-1.4 6-3l16-15.6-20-12" fill="#A9C9DD"/>
      <path d="M100 144.4l48.4 35.7c5.5 3 9.5 1.5 10.9-5.1l19.7-92.8c2-8.1-3.1-11.7-8.4-9.3L55 117.5c-7.9 3.2-7.8 7.6-1.4 9.5l36.4 11.4 84.4-53.2c4-2.4 7.6-1.1 4.6 1.5" fill="white"/>
    </svg>
  );
}

function DiscordLogo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 71 55" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M60.1 4.9A58.5 58.5 0 0 0 45.6.2a.2.2 0 0 0-.2.1 40.7 40.7 0 0 0-1.8 3.7 54 54 0 0 0-16.2 0A37.3 37.3 0 0 0 25.6.3a.2.2 0 0 0-.2-.1A58.4 58.4 0 0 0 10.9 5a.2.2 0 0 0-.1 0A59.7 59.7 0 0 0 .5 45.3a.3.3 0 0 0 .1.2A58.9 58.9 0 0 0 18.4 54a.2.2 0 0 0 .3-.1 42 42 0 0 0 3.6-5.9.2.2 0 0 0-.1-.3 38.7 38.7 0 0 1-5.5-2.6.2.2 0 0 1 0-.4l1.1-.9a.2.2 0 0 1 .2 0 42 42 0 0 0 35.7 0 .2.2 0 0 1 .2 0l1.1.9a.2.2 0 0 1 0 .3c-1.8 1-3.6 1.8-5.5 2.7a.2.2 0 0 0-.1.3c1.1 2 2.3 4 3.6 5.9a.2.2 0 0 0 .3.1 58.7 58.7 0 0 0 17.9-8.5.2.2 0 0 0 .1-.2c1.6-16.3-2.6-30.4-10.9-43.1a.2.2 0 0 0 0-.1zM23.7 37.2c-3.7 0-6.8-3.4-6.8-7.7s3-7.6 6.8-7.6 6.9 3.4 6.8 7.6c0 4.3-3 7.7-6.8 7.7zm25.2 0c-3.7 0-6.8-3.4-6.8-7.7s3-7.6 6.8-7.6 6.9 3.4 6.8 7.6c0 4.3-3 7.7-6.8 7.7z" fill="#5865F2"/>
    </svg>
  );
}

function GitHubLogo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M48.9 0a49 49 0 0 0-15.4 95.4c2.4.5 3.3-1.1 3.3-2.4V84.7c-13.5 2.9-16.3-6.5-16.3-6.5-2.2-5.6-5.4-7.1-5.4-7.1-4.4-3 .3-3 .3-3 4.9.4 7.4 5 7.4 5 4.3 7.4 11.3 5.3 14.1 4 .4-3.1 1.7-5.3 3-6.5-10.8-1.2-22.2-5.4-22.2-24 0-5.3 1.9-9.6 5-13a17.3 17.3 0 0 1 .5-12.8s4.1-1.3 13.4 5a46.4 46.4 0 0 1 24.4 0c9.3-6.3 13.4-5 13.4-5a17.3 17.3 0 0 1 .5 12.8c3.1 3.4 5 7.7 5 13 0 18.6-11.3 22.7-22.2 23.9 1.7 1.5 3.3 4.5 3.3 9v13.4c0 1.3.9 2.9 3.3 2.4A49 49 0 0 0 48.9 0z" fill="currentColor"/>
    </svg>
  );
}

function ZaloLogo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="48" height="48" rx="10" fill="#0068FF"/>
      <path d="M14 16h20v3.2H19.2L34 32.8V36H14v-3.2h14.8L14 19.2V16z" fill="white"/>
    </svg>
  );
}

function PancakeLogo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="48" height="48" rx="10" fill="#FF6B35"/>
      <text x="24" y="31" textAnchor="middle" fill="white" fontSize="22" fontWeight="bold" fontFamily="sans-serif">P</text>
    </svg>
  );
}

// Shared component to render the right logo given an ID
function ConnectorLogo({ id, size = 28 }: { id: string; size?: number }) {
  switch (id) {
    case "slack": return <SlackLogo size={size} />;
    case "telegram": return <TelegramLogo size={size} />;
    case "discord": return <DiscordLogo size={size} />;
    case "github": return <GitHubLogo size={size} />;
    case "zalo": return <ZaloLogo size={size} />;
    case "pancake": return <PancakeLogo size={size} />;
    default: return <div className="size-full rounded bg-muted" />;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Permission = "always" | "ask" | "deny";
type ConnectionStatus = "connected" | "disconnected";

interface Tool { name: string; permission: Permission; }
interface ToolGroup { label: string; tools: Tool[]; defaultPermission: Permission; }

interface Connection {
  id: string;
  name: string;
  description: string;
  status: ConnectionStatus;
  toolGroups: ToolGroup[];
}

// ─── Data ────────────────────────────────────────────────────────────────────

const INITIAL_CONNECTIONS: Connection[] = [
  {
    id: "slack", name: "Slack",
    description: "Custom instructions, role matrix, plugin management, and channel management.",
    status: "disconnected",
    toolGroups: [
      { label: "Read-only tools", defaultPermission: "ask", tools: [{ name: "List channels", permission: "ask" }, { name: "Read messages", permission: "ask" }, { name: "Get user info", permission: "ask" }, { name: "Get channel info", permission: "ask" }] },
      { label: "Write tools", defaultPermission: "ask", tools: [{ name: "Send message", permission: "ask" }, { name: "Create channel", permission: "ask" }, { name: "Upload file", permission: "ask" }] },
    ],
  },
  {
    id: "telegram", name: "Telegram",
    description: "Connect a Telegram bot. Each channel gets its own context, permissions, and instructions.",
    status: "disconnected",
    toolGroups: [
      { label: "Read-only tools", defaultPermission: "ask", tools: [{ name: "Get chat info", permission: "ask" }, { name: "Get messages", permission: "ask" }, { name: "Get bot info", permission: "ask" }] },
      { label: "Write tools", defaultPermission: "ask", tools: [{ name: "Send message", permission: "ask" }, { name: "Send photo", permission: "ask" }, { name: "Edit message", permission: "ask" }, { name: "Delete message", permission: "ask" }] },
    ],
  },
  {
    id: "discord", name: "Discord",
    description: "Respond to messages and slash commands through your agent harness.",
    status: "disconnected",
    toolGroups: [
      { label: "Read-only tools", defaultPermission: "ask", tools: [{ name: "Get server info", permission: "ask" }, { name: "List channels", permission: "ask" }, { name: "Read messages", permission: "ask" }, { name: "Get member info", permission: "ask" }] },
      { label: "Write tools", defaultPermission: "ask", tools: [{ name: "Send message", permission: "ask" }, { name: "Create thread", permission: "ask" }, { name: "Add reaction", permission: "ask" }] },
    ],
  },
  {
    id: "github", name: "GitHub",
    description: "Trigger agents from GitHub events — issues, pull requests, reviews, and more.",
    status: "disconnected",
    toolGroups: [
      { label: "Read-only tools", defaultPermission: "ask", tools: [{ name: "List repositories", permission: "ask" }, { name: "Get file content", permission: "ask" }, { name: "List issues", permission: "ask" }, { name: "List pull requests", permission: "ask" }, { name: "Search code", permission: "ask" }, { name: "Get commit history", permission: "ask" }] },
      { label: "Write/delete tools", defaultPermission: "ask", tools: [{ name: "Create issue", permission: "ask" }, { name: "Create pull request", permission: "ask" }, { name: "Push commit", permission: "ask" }, { name: "Create branch", permission: "ask" }] },
    ],
  },
  {
    id: "zalo", name: "Zalo",
    description: "Integrate with Zalo OA to handle messages from Vietnamese users.",
    status: "disconnected",
    toolGroups: [
      { label: "Read-only tools", defaultPermission: "ask", tools: [{ name: "Get user profile", permission: "ask" }, { name: "Get message history", permission: "ask" }, { name: "Get OA info", permission: "ask" }] },
      { label: "Write tools", defaultPermission: "ask", tools: [{ name: "Send message", permission: "ask" }, { name: "Send image", permission: "ask" }] },
    ],
  },
  {
    id: "pancake", name: "Pancake",
    description: "Manage customer conversations through your agent harness.",
    status: "disconnected",
    toolGroups: [
      { label: "Read-only tools", defaultPermission: "ask", tools: [{ name: "Get conversations", permission: "ask" }, { name: "Get contacts", permission: "ask" }, { name: "Get tags", permission: "ask" }] },
      { label: "Write tools", defaultPermission: "ask", tools: [{ name: "Send message", permission: "ask" }, { name: "Update contact", permission: "ask" }, { name: "Add tag", permission: "ask" }] },
    ],
  },
];

const DIRECTORY_CONNECTORS = [
  { id: "slack", name: "Slack", description: "Send messages, create canvases, and fetch Slack data" },
  { id: "github", name: "GitHub", description: "Access repos, issues, pull requests, and code search" },
  { id: "telegram", name: "Telegram", description: "Connect a Telegram bot to your agent harness" },
  { id: "discord", name: "Discord", description: "Respond to messages and slash commands" },
  { id: "zalo", name: "Zalo", description: "Integrate Zalo OA for Vietnamese market messaging" },
  { id: "pancake", name: "Pancake", description: "Manage customer conversations and CRM data" },
];

// ─── Permission Toggle ────────────────────────────────────────────────────────

function PermissionToggle({ value, onChange }: { value: Permission; onChange: (v: Permission) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {([
        { key: "always" as Permission, icon: <CheckCircle className="size-3.5" />, label: "Always allow", active: "bg-emerald-500/20 text-emerald-500" },
        { key: "ask" as Permission, icon: <Clock className="size-3.5" />, label: "Needs approval", active: "bg-foreground/15 text-foreground" },
        { key: "deny" as Permission, icon: <Ban className="size-3.5" />, label: "Deny", active: "bg-destructive/20 text-destructive" },
      ]).map((opt) => (
        <button
          key={opt.key}
          type="button"
          title={opt.label}
          onClick={() => onChange(opt.key)}
          className={cn("flex size-6 items-center justify-center rounded-full transition-colors cursor-pointer", value === opt.key ? opt.active : "text-muted-foreground/40 hover:text-muted-foreground")}
        >
          {opt.icon}
        </button>
      ))}
    </div>
  );
}

// ─── Tool Permissions Sheet ───────────────────────────────────────────────────

function ToolPermissionsSheet({
  connection, open, onOpenChange, onDisconnect, onConnect,
}: {
  connection: Connection | null; open: boolean; onOpenChange: (v: boolean) => void;
  onDisconnect: (id: string) => void; onConnect: (id: string) => void;
}) {
  const [groups, setGroups] = useState<ToolGroup[]>([]);
  const [openGroups, setOpenGroups] = useState<Record<number, boolean>>({ 0: true, 1: true });
  const [botToken, setBotToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");

  if (connection && groups.length === 0 && connection.toolGroups.length > 0)
    setGroups(connection.toolGroups.map((g) => ({ ...g, tools: g.tools.map((t) => ({ ...t })) })));
  if (!connection && groups.length > 0) setGroups([]);
  if (!connection) return null;

  const isConnected = connection.status === "connected";

  function updatePermission(gi: number, ti: number, perm: Permission) {
    setGroups((p) => p.map((g, i) => i === gi ? { ...g, tools: g.tools.map((t, j) => j === ti ? { ...t, permission: perm } : t) } : g));
  }
  function updateGroupDefault(gi: number, perm: Permission) {
    setGroups((p) => p.map((g, i) => i === gi ? { ...g, defaultPermission: perm, tools: g.tools.map((t) => ({ ...t, permission: perm })) } : g));
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col gap-0 p-0">
        <SheetHeader className="flex flex-row items-center gap-3 border-b border-border px-5 py-4">
          <span className="flex size-8 shrink-0 items-center justify-center"><ConnectorLogo id={connection.id} size={28} /></span>
          <SheetTitle className="flex-1 text-base font-semibold">{connection.name}</SheetTitle>
          <div className="flex shrink-0 items-center gap-2">
            {isConnected && (
              <Button variant="outline" size="sm" className="cursor-pointer text-xs"
                onClick={() => { onDisconnect(connection.id); setGroups([]); onOpenChange(false); }}>
                Disconnect
              </Button>
            )}
            <Button variant="ghost" size="icon-xs" className="cursor-pointer text-muted-foreground"><MoreHorizontal className="size-3.5" /></Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-auto">
          <div className="px-5 py-4"><p className="text-sm text-muted-foreground leading-relaxed">{connection.description}</p></div>

          {!isConnected && (
            <div className="px-5 pb-4 grid gap-3">
              <Separator />
              <p className="text-xs font-medium text-foreground">Connection settings</p>
              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">Bot token</Label>
                <Input value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="Token from developer portal" type="password" className="text-sm font-mono" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">Webhook URL</Label>
                <Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://..." className="text-sm font-mono" />
              </div>
              <Button size="sm" className="w-fit cursor-pointer" onClick={() => { onConnect(connection.id); setGroups([]); onOpenChange(false); }}>
                Connect {connection.name}
              </Button>
            </div>
          )}

          <Separator />
          <div className="px-5 py-4 space-y-4">
            <div>
              <p className="text-sm font-semibold text-foreground">Tool permissions</p>
              <p className="text-xs text-muted-foreground mt-0.5">Choose when agents are allowed to use these tools.</p>
            </div>
            <div className="space-y-4">
              {(groups.length > 0 ? groups : connection.toolGroups).map((group, gi) => (
                <Collapsible key={gi} open={openGroups[gi] !== false} onOpenChange={(v) => setOpenGroups((p) => ({ ...p, [gi]: v }))}>
                  <div className="flex items-center justify-between gap-2">
                    <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-foreground cursor-pointer">
                      <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", openGroups[gi] === false && "-rotate-90")} />
                      {group.label} <span className="text-muted-foreground">{group.tools.length}</span>
                    </CollapsibleTrigger>
                    <PermissionToggle value={group.defaultPermission} onChange={(p) => updateGroupDefault(gi, p)} />
                  </div>
                  <CollapsibleContent>
                    <div className="mt-1.5 rounded-lg border border-border divide-y divide-border">
                      {group.tools.map((tool, ti) => (
                        <div key={ti} className="flex items-center gap-3 px-3 py-2.5">
                          <span className="flex-1 text-sm text-foreground">{tool.name}</span>
                          <PermissionToggle value={tool.permission} onChange={(p) => updatePermission(gi, ti, p)} />
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </div>
        </div>

        {isConnected && (
          <div className="border-t border-border px-5 py-4 flex items-center justify-between">
            <button type="button" className="flex items-center gap-1.5 text-xs text-destructive hover:text-destructive/80 cursor-pointer"
              onClick={() => { onDisconnect(connection.id); setGroups([]); onOpenChange(false); }}>
              <Trash2 className="size-3.5" /> Disconnect
            </button>
            <Button size="sm" className="cursor-pointer" onClick={() => onOpenChange(false)}>Save changes</Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Browse Connectors Dialog ─────────────────────────────────────────────────

function BrowseConnectorsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [query, setQuery] = useState("");
  const filtered = DIRECTORY_CONNECTORS.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl p-0 gap-0 max-h-[80vh] flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-0 shrink-0">
          <DialogTitle className="text-xl font-semibold">Directory</DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar */}
          <div className="w-44 shrink-0 border-r border-border p-3 space-y-1">
            {([
              { key: "skills", label: "Skills", icon: <Search className="size-3.5" /> },
              { key: "connectors", label: "Connectors", icon: <Settings2 className="size-3.5" /> },
              { key: "plugins", label: "Plugins", icon: <Settings2 className="size-3.5" /> },
            ]).map((t) => (
              <button key={t.key} type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors cursor-pointer",
                  t.key === "connectors" ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          {/* Main */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search connectors..." className="pl-10 text-sm h-10" />
              </div>
            </div>

            <div className="flex-1 overflow-auto p-6">
              <div className="grid grid-cols-2 gap-4">
                {filtered.map((conn) => (
                  <div key={conn.id} className="rounded-xl border border-border bg-card p-5 hover:bg-accent/30 transition-colors cursor-pointer">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center">
                          <ConnectorLogo id={conn.id} size={36} />
                        </span>
                        <p className="text-sm font-semibold text-foreground">{conn.name}</p>
                      </div>
                      <button type="button" className="shrink-0 flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer transition-colors">
                        <Plus className="size-4" />
                      </button>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground leading-relaxed line-clamp-2">{conn.description}</p>
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

// ─── Add Custom Connector Dialog ──────────────────────────────────────────────

function AddCustomConnectorDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [name, setName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [oauthId, setOauthId] = useState("");
  const [oauthSecret, setOauthSecret] = useState("");
  const [showAdv, setShowAdv] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-5">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle className="text-base">Add custom connector</DialogTitle>
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Beta</span>
          </div>
          <p className="text-sm text-muted-foreground mt-1.5">Connect your agents to your data and tools. Only use connectors from developers you trust.</p>
        </DialogHeader>
        <div className="grid gap-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="text-sm" />
          <Input value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} placeholder="Remote MCP server URL" className="text-sm font-mono" />
          <button type="button" onClick={() => setShowAdv(!showAdv)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer w-fit transition-colors">
            <ChevronDown className={cn("size-3.5 transition-transform", !showAdv && "-rotate-90")} />
            Advanced settings
          </button>
          {showAdv && (
            <>
              <Input value={oauthId} onChange={(e) => setOauthId(e.target.value)} placeholder="OAuth Client ID (optional)" className="text-sm" />
              <Input value={oauthSecret} onChange={(e) => setOauthSecret(e.target.value)} placeholder="OAuth Client Secret (optional)" type="password" className="text-sm" />
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Only use connectors from developers you trust. Broods does not control which tools developers make available and cannot verify that they will work as intended or that they won&apos;t change.
        </p>
        <DialogFooter>
          <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" className="cursor-pointer" disabled={!name.trim() || !mcpUrl.trim()}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Connection Card ──────────────────────────────────────────────────────────

function ConnectionCard({ conn, onClick }: { conn: Connection; onClick: (c: Connection) => void }) {
  return (
    <div role="button" tabIndex={0} onClick={() => onClick(conn)} onKeyDown={(e) => e.key === "Enter" && onClick(conn)}
      className="group flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-4 transition-colors hover:bg-accent/40 cursor-pointer">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-background p-1">
        <ConnectorLogo id={conn.id} size={28} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{conn.name}</p>
        <p className="text-xs text-muted-foreground line-clamp-1">{conn.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {conn.status === "connected" ? (
          <div onClick={(e) => e.stopPropagation()}><Switch checked aria-label={`${conn.name} enabled`} /></div>
        ) : (
          <span className="flex items-center gap-0.5">Connect <ChevronRight className="size-3.5" /></span>
        )}
      </div>
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export function ConnectionsPanel({ environmentId }: Props) {
  const [connections, setConnections] = useState<Connection[]>(INITIAL_CONNECTIONS);
  const [selected, setSelected] = useState<Connection | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);

  if (!environmentId) {
    return (
      <Section description="Channel integrations for this environment.">
        <p className="text-sm text-muted-foreground">Select an environment to manage its connections.</p>
      </Section>
    );
  }

  function handleCardClick(conn: Connection) { setSelected(conn); setSheetOpen(true); }
  function handleConnect(id: string) {
    setConnections((p) => p.map((c) => c.id === id ? { ...c, status: "connected" } : c));
    setSelected((p) => p?.id === id ? { ...p, status: "connected" } : p);
  }
  function handleDisconnect(id: string) {
    setConnections((p) => p.map((c) => c.id === id ? { ...c, status: "disconnected" } : c));
    setSelected((p) => p?.id === id ? { ...p, status: "disconnected" } : p);
  }

  const live = selected ? connections.find((c) => c.id === selected.id) ?? null : null;

  return (
    <>
      <Section>
        <div className="grid gap-2">
          {connections.map((conn) => <ConnectionCard key={conn.id} conn={conn} onClick={handleCardClick} />)}
        </div>
      </Section>
      <ToolPermissionsSheet connection={live} open={sheetOpen} onOpenChange={setSheetOpen} onConnect={handleConnect} onDisconnect={handleDisconnect} />
      <BrowseConnectorsDialog open={browseOpen} onOpenChange={setBrowseOpen} />
      <AddCustomConnectorDialog open={customOpen} onOpenChange={setCustomOpen} />
    </>
  );
}
