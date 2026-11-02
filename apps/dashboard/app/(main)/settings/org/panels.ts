// Org tab chunks, loaded by the page's next/dynamic and preloaded by the sidebar on hover.
import type { AllowanceUsage } from "@/app/(main)/[projectId]/dashboard/components/AllowanceUsage";
import type { ORG_TABS } from "@/app/lib/navigation";
import type { ApiAccessPanel } from "./components/ApiAccessPanel";
import type { MembersPanel } from "./components/MembersPanel";
import type { OrgDangerPanel } from "./components/OrgDangerPanel";
import type { OrgPoliciesPanel } from "./components/OrgPoliciesPanel";
import type { PermissionsPanel } from "./components/PermissionsPanel";
import type { RolesPanel } from "./components/RolesPanel";

export const loadAllowanceUsage = (): Promise<typeof AllowanceUsage> =>
  import("@/app/(main)/[projectId]/dashboard/components/AllowanceUsage").then(
    (mod) => mod.AllowanceUsage,
  );

export const loadMembersPanel = (): Promise<typeof MembersPanel> =>
  import("./components/MembersPanel").then((mod) => mod.MembersPanel);

export const loadRolesPanel = (): Promise<typeof RolesPanel> =>
  import("./components/RolesPanel").then((mod) => mod.RolesPanel);

export const loadOrgPoliciesPanel = (): Promise<typeof OrgPoliciesPanel> =>
  import("./components/OrgPoliciesPanel").then((mod) => mod.OrgPoliciesPanel);

export const loadPermissionsPanel = (): Promise<typeof PermissionsPanel> =>
  import("./components/PermissionsPanel").then((mod) => mod.PermissionsPanel);

export const loadApiAccessPanel = (): Promise<typeof ApiAccessPanel> =>
  import("./components/ApiAccessPanel").then((mod) => mod.ApiAccessPanel);

export const loadOrgDangerPanel = (): Promise<typeof OrgDangerPanel> =>
  import("./components/OrgDangerPanel").then((mod) => mod.OrgDangerPanel);

export const ORG_PANELS: Partial<
  Record<(typeof ORG_TABS)[number]["id"], () => Promise<unknown>>
> = {
  usage: loadAllowanceUsage,
  members: loadMembersPanel,
  roles: loadRolesPanel,
  policies: loadOrgPoliciesPanel,
  permissions: loadPermissionsPanel,
  "api-access": loadApiAccessPanel,
  danger: loadOrgDangerPanel,
};
