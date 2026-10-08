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
const WIDE_TABS = new Set<string>([
  "members",
  "roles",
  "policies",
  "permissions",
  "api-access",
]);

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

  return (
    <div className="flex h-full min-w-0 flex-col overflow-auto">
      <h1 className="sr-only">{tab.label}</h1>
      <div
        className={cn(
          "mx-auto w-full px-6 pt-6 pb-12",
          WIDE_TABS.has(tab.id) ? "flex min-h-0 flex-1 flex-col" : "max-w-2xl",
        )}
      >
        {org === undefined ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : org === null ? (
          <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
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
