/**
 * The project settings tabs past General, each in a chunk of its own so the
 * default tab's first load does not carry them. The page renders them through
 * next/dynamic with these loaders, and the sidebar calls the same loader when
 * a tab link is hovered or focused, so the chunk is on its way before the click.
 */
import type { SETTINGS_TABS } from "@/app/lib/navigation";
import type { DangerPanel } from "./components/DangerPanel";
import type { EnvironmentVariablesPanel } from "./components/EnvironmentVariablesPanel";
import type { KeysPanel } from "./components/KeysPanel";
import type { PoliciesPanel } from "./components/PoliciesPanel";
import type { WebhooksPanel } from "./components/WebhooksPanel";

export const loadEnvironmentVariablesPanel = (): Promise<
  typeof EnvironmentVariablesPanel
> =>
  import("./components/EnvironmentVariablesPanel").then(
    (mod) => mod.EnvironmentVariablesPanel,
  );

export const loadKeysPanel = (): Promise<typeof KeysPanel> =>
  import("./components/KeysPanel").then((mod) => mod.KeysPanel);

export const loadWebhooksPanel = (): Promise<typeof WebhooksPanel> =>
  import("./components/WebhooksPanel").then((mod) => mod.WebhooksPanel);

export const loadPoliciesPanel = (): Promise<typeof PoliciesPanel> =>
  import("./components/PoliciesPanel").then((mod) => mod.PoliciesPanel);

export const loadDangerPanel = (): Promise<typeof DangerPanel> =>
  import("./components/DangerPanel").then((mod) => mod.DangerPanel);

/** The split-out tabs by id; General has none, it ships with the page. */
export const SETTINGS_PANELS: Partial<
  Record<(typeof SETTINGS_TABS)[number]["id"], () => Promise<unknown>>
> = {
  variables: loadEnvironmentVariablesPanel,
  keys: loadKeysPanel,
  webhooks: loadWebhooksPanel,
  policies: loadPoliciesPanel,
  danger: loadDangerPanel,
};
