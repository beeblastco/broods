"use client";

import { AllowanceUsage } from "@/app/(main)/[projectId]/dashboard/components/AllowanceUsage";
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

// The key, member and access lists are laid out like Monitoring: the toolbar, the
// table and the detail panel fill the page edge to edge, nothing scrolls but
// the table.
const FLUSH_TABS = new Set<string>([
  "api-access",
  "members",
  "roles",
  "policies",
  "permissions",
]);

// The usage tables need more than the form column, and still scroll with the page.
const WIDE_TABS = new Set<string>(["usage"]);

export default function OrgSettingsPage(): React.JSX.Element {
  const org = useQuery(api.org.orgs.getActive, {});
  const searchParams = useSearchParams();
  const tab = pickTab(ORG_TABS, searchParams.get("tab"));

  const renderPanel = (): React.JSX.Element | null => {
    if (!org) return null;
    switch (tab.id) {
      case "general":
        return <OrgGeneralPanel org={org} />;
      case "usage":
        return <AllowanceUsage view={{ scope: "all" }} />;
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

  // The states before a panel have one line or card to show and sit in the
  // narrow column whatever the tab; only the panel slot follows the tab.
  const body = (): React.JSX.Element | null => {
    if (org === undefined) {
      return (
        <p className="mx-auto w-full max-w-2xl px-6 pt-6 text-sm text-muted-foreground">
          Loading...
        </p>
      );
    }
    if (org === null) {
      return (
        <div className="mx-auto w-full max-w-2xl px-6 pt-6">
          <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              You do not have an organization yet.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div
        className={cn(
          "mx-auto w-full",
          flush
            ? "flex min-h-0 flex-1 flex-col"
            : cn(
                "px-6 pt-6 pb-12",
                WIDE_TABS.has(tab.id) ? "max-w-6xl" : "max-w-2xl",
              ),
        )}
      >
        {renderPanel()}
      </div>
    );
  };

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col",
        flush ? "overflow-hidden" : "overflow-auto",
      )}
    >
      <h1 className="sr-only">{tab.label}</h1>
      {body()}
    </div>
  );
}
