import {
  Box,
  Building2,
  CalendarClock,
  FolderOpen,
  LayoutDashboard,
  Network,
  Plug,
  Settings,
  UserRound,
  type LucideIcon,
} from "lucide-react";

export const SIDEBAR_COOKIE = "sidebar_state";

export interface NavTab {
  danger?: boolean;
  id: string;
  label: string;
}

export interface NavItem {
  icon: LucideIcon;
  keywords: readonly string[];
  label: string;
  segment: string;
  tabs: readonly NavTab[];
}

export const DASHBOARD_TABS = [
  { id: "monitoring", label: "Monitoring" },
  { id: "tracing", label: "Tracing" },
  { id: "usage", label: "Usage" },
  { id: "billing", label: "Billing & Plan" },
  { id: "api-key", label: "Runtime key" },
] as const;

export const SANDBOX_TABS = [
  { id: "instances", label: "Instances" },
  { id: "snapshots", label: "Snapshots" },
  { id: "security", label: "Security" },
  { id: "networking", label: "Networking" },
] as const;

export const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "variables", label: "Environment variables" },
  { id: "keys", label: "Keys" },
  { id: "webhooks", label: "Webhooks" },
  { id: "policies", label: "Policies" },
  { danger: true, id: "danger", label: "Danger Zone" },
] as const;

export const ORG_TABS = [
  { id: "general", label: "General" },
  { id: "usage", label: "Usage" },
  { id: "members", label: "Members" },
  { id: "roles", label: "Roles" },
  { id: "policies", label: "Policies" },
  { id: "permissions", label: "Permissions" },
  { id: "api-access", label: "API access" },
  { danger: true, id: "danger", label: "Danger Zone" },
] as const;

export const ACCOUNT_TABS = [
  { id: "profile", label: "Profile" },
  { danger: true, id: "danger", label: "Danger Zone" },
] as const;

export const NAV_ITEMS: readonly NavItem[] = [
  {
    icon: Network,
    keywords: ["canvas", "nodes", "agents", "graph", "architecture"],
    label: "Architecture",
    segment: "",
    tabs: [],
  },
  {
    icon: LayoutDashboard,
    keywords: ["observability", "traces", "logs", "usage", "tokens", "billing"],
    label: "Dashboard",
    segment: "/dashboard",
    tabs: DASHBOARD_TABS,
  },
  {
    icon: CalendarClock,
    keywords: ["cron", "crons", "schedule", "jobs"],
    label: "Scheduler",
    segment: "/scheduler",
    tabs: [],
  },
  {
    icon: Box,
    keywords: ["sandbox", "machines", "snapshots", "instances", "terminal"],
    label: "Sandbox",
    segment: "/sandbox",
    tabs: SANDBOX_TABS,
  },
  {
    icon: Settings,
    keywords: ["env", "variables", "webhooks", "keys", "policies", "settings"],
    label: "Settings",
    segment: "/settings",
    tabs: SETTINGS_TABS,
  },
];

export const ACCOUNT_NAV_ITEMS: readonly NavItem[] = [
  {
    icon: FolderOpen,
    keywords: ["projects"],
    label: "Projects",
    segment: "/projects",
    tabs: [],
  },
  {
    icon: Plug,
    keywords: ["connections", "chatgpt", "oauth"],
    label: "Connections",
    segment: "/settings/connections",
    tabs: [],
  },
  {
    icon: Building2,
    keywords: ["organization", "members", "api access"],
    label: "Organization",
    segment: "/settings/org",
    tabs: ORG_TABS,
  },
  {
    icon: UserRound,
    keywords: ["account", "profile"],
    label: "Account",
    segment: "/settings/account",
    tabs: ACCOUNT_TABS,
  },
];

export function activeNavItem(
  items: readonly NavItem[],
  pathname: string,
  base: string,
): NavItem {
  const match = items.find(
    (item) =>
      item.segment !== "" && pathname.startsWith(`${base}${item.segment}`),
  );

  return match ?? items[0];
}

// Carries the stage param so the next page does not refetch under a new key.
export function navHref(
  projectId: string,
  segment: string,
  stageId: string | null,
): string {
  return `/${projectId}${segment}${stageId ? `?stage=${stageId}` : ""}`;
}

export function pickTab<T extends readonly NavTab[]>(
  tabs: T,
  value: string | null,
): T[number] {
  return tabs.find((tab) => tab.id === value) ?? tabs[0];
}

export function stepNavItem(
  items: readonly NavItem[],
  current: NavItem,
  offset: number,
): NavItem {
  const index = items.indexOf(current);
  const next = (index + offset + items.length) % items.length;

  return items[next];
}

// Only `?stage=` carries over, so one tab's search, range or selection never leaks into another.
export function tabHref(
  path: string,
  tabId: string,
  search: string,
  params: Record<string, string> = {},
): string {
  const stage = new URLSearchParams(search).get("stage");
  const next = new URLSearchParams(stage ? { stage: stage } : {});
  next.set("tab", tabId);
  for (const [key, value] of Object.entries(params)) next.set(key, value);

  return `${path}?${next.toString()}`;
}
