/**
 * The dashboard tabs past Monitoring, each in a chunk of its own so the
 * default tab's first load does not carry them. The page renders them through
 * next/dynamic with these loaders, and the sidebar calls the same loader when
 * a tab link is hovered or focused, so the chunk is on its way before the click.
 */
import type { DASHBOARD_TABS } from "@/app/lib/navigation";
import type { BillingPanel } from "./components/BillingPanel";
import type {
  RuntimeKeyDialog,
  RuntimeKeyView,
} from "./components/RuntimeKeyDialog";
import type { TokensUsagePanel } from "./components/TokensUsagePanel";
import type { TracingPanel } from "./components/TracingPanel";

export const loadTracingPanel = (): Promise<typeof TracingPanel> =>
  import("./components/TracingPanel").then((mod) => mod.TracingPanel);

export const loadTokensUsagePanel = (): Promise<typeof TokensUsagePanel> =>
  import("./components/TokensUsagePanel").then((mod) => mod.TokensUsagePanel);

export const loadBillingPanel = (): Promise<typeof BillingPanel> =>
  import("./components/BillingPanel").then((mod) => mod.BillingPanel);

export const loadRuntimeKeyView = (): Promise<typeof RuntimeKeyView> =>
  import("./components/RuntimeKeyDialog").then((mod) => mod.RuntimeKeyView);

export const loadRuntimeKeyDialog = (): Promise<typeof RuntimeKeyDialog> =>
  import("./components/RuntimeKeyDialog").then((mod) => mod.RuntimeKeyDialog);

/** The split-out tabs by id; Monitoring has none, it ships with the page. */
export const DASHBOARD_PANELS: Partial<
  Record<(typeof DASHBOARD_TABS)[number]["id"], () => Promise<unknown>>
> = {
  tracing: loadTracingPanel,
  usage: loadTokensUsagePanel,
  billing: loadBillingPanel,
  "api-key": loadRuntimeKeyView,
};
