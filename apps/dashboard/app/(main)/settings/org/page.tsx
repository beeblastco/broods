"use client";

import { ORG_TABS, pickTab } from "@/app/lib/navigation";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import { useQuery } from "convex/react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { OrgGeneralPanel } from "./components/OrgGeneralPanel";
import {
  loadAllowanceUsage,
  loadApiAccessPanel,
  loadMembersPanel,
  loadOrgDangerPanel,
  loadOrgPoliciesPanel,
  loadPermissionsPanel,
  loadRolesPanel,
  ORG_PANELS,
} from "./panels";

function ColumnLoading(): React.JSX.Element {
  return <p className="text-sm text-muted-foreground">Loading…</p>;
}

function FlushLoading(): React.JSX.Element {
  return <p className="px-6 pt-6 text-sm text-muted-foreground">Loading…</p>;
}

// `loading` gives each its own Suspense boundary, else it suspends to the route's loading.tsx.
// The options stay inline at each call: Turbopack reads them statically.
const AllowanceUsage = dynamic(loadAllowanceUsage, { loading: ColumnLoading });
const MembersPanel = dynamic(loadMembersPanel, { loading: FlushLoading });
const RolesPanel = dynamic(loadRolesPanel, { loading: FlushLoading });
const OrgPoliciesPanel = dynamic(loadOrgPoliciesPanel, {
  loading: FlushLoading,
});
const PermissionsPanel = dynamic(loadPermissionsPanel, {
  loading: FlushLoading,
});
const ApiAccessPanel = dynamic(loadApiAccessPanel, { loading: FlushLoading });
const OrgDangerPanel = dynamic(loadOrgDangerPanel, { loading: ColumnLoading });

const FLUSH_TABS = new Set<string>([
  "api-access",
  "members",
  "roles",
  "policies",
  "permissions",
]);

export default function OrgSettingsPage(): React.JSX.Element {
  const org = useQuery(api.org.orgs.getActive, {});
  const searchParams = useSearchParams();
  const tab = pickTab(ORG_TABS, searchParams.get("tab"));

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- warms the tab chunk with the query
  useEffect(() => {
    void ORG_PANELS[tab.id]?.();
  }, [tab]);

  const renderPanel = (): React.JSX.Element | null => {
    if (!org) return null;
    switch (tab.id) {
      case "general":
        return <OrgGeneralPanel org={org} />;
      case "usage":
        // Keyed so an org switch resets the held month.
        return <AllowanceUsage key={org._id} view={{ scope: "all" }} />;
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
          flush ? "flex min-h-0 flex-1 flex-col" : "px-6 pt-6 pb-12",
          !flush && (tab.id === "usage" ? "max-w-6xl" : "max-w-2xl"),
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
