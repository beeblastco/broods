import type * as Preset from "@docusaurus/preset-classic";
import type { Config, LoadContext, Plugin } from "@docusaurus/types";
import scalarDocusaurus, { type ScalarOptions } from "@scalar/docusaurus";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_REFERENCE: ScalarOptions = {
  label: "API Reference",
  route: "/api-reference",
  // The navbar has its own "API" item; Scalar would add a second link to the page.
  showNavLink: false,
  configuration: {
    spec: {
      content: fs.readFileSync(
        path.resolve(__dirname, "docs/api-reference/openapi.yaml"),
        "utf8",
      ),
    },
  },
};

// Scalar's plugin minus the 1 MB render-blocking script it puts on every page.
function apiReferencePlugin(context: LoadContext): Plugin {
  const plugin = scalarDocusaurus(context, API_REFERENCE);

  return {
    name: plugin.name,
    contentLoaded: async function ({ actions }) {
      await plugin.contentLoaded?.({
        content: (await plugin.loadContent?.()) ?? {},
        actions: {
          ...actions,
          addRoute: (route) =>
            actions.addRoute({
              ...route,
              component: path.resolve(
                __dirname,
                "src/components/ApiReference.tsx",
              ),
            }),
        },
      });
    },
  };
}

const LEGACY_REDIRECTS: { from: string; to: string }[] = [
  { from: "/getting-started", to: "/quickstart" },
  { from: "/cli", to: "/reference/cli" },
  { from: "/sdk", to: "/reference/sdk" },
  { from: "/resources", to: "/reference/configuration" },
  { from: "/architecture", to: "/internals/architecture" },
  { from: "/architecture/queue-and-steer", to: "/internals/queue-and-steer" },
  { from: "/data-security", to: "/guides/security" },
  { from: "/roles", to: "/guides/security" },
  { from: "/observability", to: "/guides/observability" },
  { from: "/deployment", to: "/internals/self-hosting" },
  { from: "/operations", to: "/internals/operations" },
  { from: "/ci-cd", to: "/internals/ci-cd" },
  { from: "/extending", to: "/internals/" },
  { from: "/hooks", to: "/guides/hooks" },
  { from: "/webhook", to: "/guides/webhooks" },
  { from: "/tools", to: "/guides/tools" },
  { from: "/skills", to: "/guides/skills" },
  { from: "/sub-agents", to: "/guides/subagents" },
  { from: "/crons", to: "/guides/scheduling" },
  { from: "/workspace", to: "/guides/workspaces" },
  { from: "/workspace/storage", to: "/guides/workspaces" },
  { from: "/workspace/memory-and-session", to: "/guides/memory-and-sessions" },
  { from: "/workspace/sandbox", to: "/guides/sandboxes/" },
  { from: "/workspace/sandbox/getting-started", to: "/guides/sandboxes/" },
  { from: "/workspace/sandbox/snapshot", to: "/guides/sandboxes/" },
  { from: "/workspace/sandbox/networking", to: "/guides/sandboxes/" },
  { from: "/workspace/sandbox/security", to: "/guides/sandboxes/" },
  { from: "/workspace/sandbox/hook", to: "/guides/sandboxes/persistent" },
  {
    from: "/workspace/sandbox/best-practice",
    to: "/guides/sandboxes/persistent",
  },
  { from: "/workspace/sandbox/lambda", to: "/guides/sandboxes/providers" },
  { from: "/workspace/sandbox/daytona", to: "/guides/sandboxes/providers" },
  { from: "/workspace/sandbox/e2b", to: "/guides/sandboxes/providers" },
  { from: "/workspace/sandbox/vercel", to: "/guides/sandboxes/providers" },
  { from: "/workspace/sandbox/machine", to: "/guides/sandboxes/machine" },
  { from: "/guides/cloudflare-mcp", to: "/guides/tools" },
  { from: "/guides/cloudflare-browser", to: "/guides/sandboxes/browsing" },
  { from: "/guides/sandboxes/cloudflare", to: "/guides/sandboxes/providers" },
  { from: "/guides/dashboard-links", to: "/guides/observability" },
];

const presetOptions: Preset.Options = {
  docs: {
    sidebarPath: "./sidebar.ts",
    routeBasePath: "/",
    path: "docs",
    exclude: ["**/*.test.*", "**/_*/**"],
  },
};

const themeConfig: Preset.ThemeConfig = {
  navbar: {
    logo: {
      alt: "Broods Logo",
      src: "img/logo.svg",
    },
    items: [
      {
        type: "docSidebar",
        sidebarId: "docs",
        label: "Docs",
        position: "left",
      },
      {
        to: "/api-reference",
        label: "API",
        position: "left",
      },
      {
        type: "docSidebar",
        sidebarId: "internals",
        label: "Internals",
        position: "left",
      },
      {
        href: "https://dashboard.broods.app/",
        label: "Dashboard",
        position: "right",
      },
      {
        href: "https://discord.gg/F48633Uca",
        label: "Discord",
        position: "right",
      },
      {
        href: "https://github.com/beeblastco/broods",
        label: "GitHub",
        position: "right",
      },
    ],
  },
};

const config: Config = {
  title: "Broods Docs",
  favicon: "img/broods-favicon.ico",

  url: "https://docs.broods.app",
  baseUrl: "/",

  onBrokenLinks: "throw",
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [["classic", presetOptions]],

  plugins: [
    [
      "@docusaurus/plugin-client-redirects",
      {
        redirects: LEGACY_REDIRECTS,
      },
    ],
    apiReferencePlugin,
    function generatedModulesWebpackMode() {
      return {
        name: "generated-modules-webpack-mode",
        configureWebpack: function () {
          return {
            module: {
              rules: [
                {
                  test: /\.js$/,
                  include: /[\\/]\.docusaurus[\\/]/,
                  type: "javascript/auto",
                },
                {
                  test: /\.js$/,
                  resolve: {
                    fullySpecified: false,
                  },
                },
              ],
            },
          };
        },
      };
    },
  ],

  themeConfig: themeConfig,
};

export default config;
