"use client";

import { ORG_TABS, pickTab } from "@/app/lib/navigation";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { ApiAccessPanel } from "./components/ApiAccessPanel";
import { MembersPanel } from "./components/MembersPanel";
import { OrgDangerPanel } from "./components/OrgDangerPanel";
import { OrgGeneralPanel } from "./components/OrgGeneralPanel";
import { OrgPoliciesPanel } from "./components/OrgPoliciesPanel";
import { PermissionsPanel } from "./components/PermissionsPanel";
import { RolesPanel } from "./components/RolesPanel";

// The list tabs carry a table and a side panel, so they take the full width.
const WIDE_TABS = new Set<string>(["members", "api-access"]);

// The access lists are laid out like Monitoring: the toolbar, the table and
// the detail panel fill the page edge to edge, nothing scrolls but the table.
const FLUSH_TABS = new Set<string>(["roles", "policies", "permissions"]);

export default function OrgSettingsPage(): React.JSX.Element {
  const org = useQuery(api.org.orgs.getActive, {});
  const searchParams = useSearchParams();
  const tab = pickTab(ORG_TABS, searchParams.get("tab"));

  const renderPanel = (): React.JSX.Element | null => {
    if (!org) return null;
    switch (tab.id) {
      case "general":
        return <OrgGeneralPanel org={org} />;
      case "api-access":
        return <ApiAccessPanel org={org} />;
      case "members":
        return <MembersPanel org={org} />;
      case "roles":
        return <RolesPanel />;
      case "policies":
        return <OrgPoliciesPanel />;
      case "permissions":
        return <PermissionsPanel />;
      case "danger":
        return <OrgDangerPanel org={org} />;
      default:
        return <OrgGeneralPanel org={org} />;
    }
  };

  const flush = FLUSH_TABS.has(tab.id);
  const list = flush || WIDE_TABS.has(tab.id);

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col",
        flush ? "overflow-hidden" : "overflow-auto",
      )}
    >
      <h1 className="sr-only">{tab.label}</h1>
      <div
        className={cn(
          "mx-auto w-full",
          list ? "flex min-h-0 flex-1 flex-col" : "max-w-2xl",
          !flush && "px-6 pt-6 pb-12",
        )}
      >
        {org === undefined ? (
          <p
            className={cn(
              "text-sm text-muted-foreground",
              flush && "px-6 pt-6",
            )}
          >
            Loading...
          </p>
        ) : org === null ? (
          <div
            className={cn(
              "rounded-lg border border-border bg-card px-4 py-8 text-center",
              flush && "mx-6 mt-6",
            )}
          >
            <p className="text-sm text-muted-foreground">
              You do not have an organization yet.
            </p>
          </div>
        ) : (
          renderPanel()
        )}
      </div>
    </div>
  );
}
