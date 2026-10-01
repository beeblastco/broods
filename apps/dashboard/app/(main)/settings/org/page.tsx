"use client";

import { ORG_TABS, pickTab } from "@/app/lib/navigation";
import { api } from "@broods/convex/_generated/api";
import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { ApiAccessPanel } from "./components/ApiAccessPanel";
import { MembersPanel } from "./components/MembersPanel";
import { OrgDangerPanel } from "./components/OrgDangerPanel";
import { OrgGeneralPanel } from "./components/OrgGeneralPanel";

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
      case "danger":
        return <OrgDangerPanel org={org} />;
      default:
        return <OrgGeneralPanel org={org} />;
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-auto">
      <h1 className="sr-only">{tab.label}</h1>
      <div className="mx-auto w-full max-w-2xl px-6 pt-6 pb-12">
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
