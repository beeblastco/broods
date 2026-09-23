import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

/**
 * Two sidebars, two audiences. `docs` is for people building agents on Broods.
 * `internals` is for people working on Broods itself: contributors, self-hosters
 * and operators. Keep source paths, tables and infra out of `docs`.
 */
const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Get started",
      collapsed: false,
      items: [
        { type: "doc", id: "index", label: "Overview" },
        { type: "doc", id: "quickstart", label: "Quickstart" },
        { type: "doc", id: "concepts", label: "Concepts" },
      ],
    },
    {
      type: "category",
      label: "Build agents",
      collapsed: false,
      items: [
        { type: "doc", id: "guides/agents", label: "Agents" },
        { type: "doc", id: "guides/tools", label: "Tools and MCP" },
        {
          type: "category",
          label: "Sandboxes",
          link: { type: "doc", id: "guides/sandboxes/index" },
          items: [
            {
              type: "doc",
              id: "guides/sandboxes/persistent",
              label: "Persistent sandboxes",
            },
            {
              type: "doc",
              id: "guides/sandboxes/providers",
              label: "Providers",
            },
            {
              type: "doc",
              id: "guides/sandboxes/machine",
              label: "Your computer",
            },
          ],
        },
        { type: "doc", id: "guides/workspaces", label: "Workspaces" },
        {
          type: "doc",
          id: "guides/memory-and-sessions",
          label: "Memory and sessions",
        },
        { type: "doc", id: "guides/skills", label: "Skills" },
        { type: "doc", id: "guides/subagents", label: "Subagents" },
        { type: "doc", id: "guides/scheduling", label: "Scheduling" },
      ],
    },
    {
      type: "category",
      label: "Channels",
      link: { type: "doc", id: "channels/index" },
      items: [
        {
          type: "doc",
          id: "channels/channel-records",
          label: "Channel records",
        },
        { type: "doc", id: "channels/slack", label: "Slack" },
        { type: "doc", id: "channels/telegram", label: "Telegram" },
        { type: "doc", id: "channels/discord", label: "Discord" },
        { type: "doc", id: "channels/github", label: "GitHub" },
        { type: "doc", id: "channels/matrix", label: "Matrix" },
        { type: "doc", id: "channels/zalo", label: "Zalo" },
        { type: "doc", id: "channels/pancake", label: "Pancake" },
      ],
    },
    {
      type: "category",
      label: "Control and observe",
      collapsed: false,
      items: [
        { type: "doc", id: "guides/conversations", label: "Conversations" },
        { type: "doc", id: "guides/policies", label: "Policies" },
        { type: "doc", id: "guides/hooks", label: "Hooks" },
        { type: "doc", id: "guides/webhooks", label: "Webhooks" },
        { type: "doc", id: "guides/observability", label: "Logs and traces" },
      ],
    },
    {
      type: "category",
      label: "Ship",
      collapsed: false,
      items: [
        { type: "doc", id: "guides/deploying", label: "Deploying" },
        { type: "doc", id: "guides/security", label: "Security and access" },
      ],
    },
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: [
        { type: "doc", id: "reference/cli", label: "CLI" },
        { type: "doc", id: "reference/sdk", label: "TypeScript SDK" },
        { type: "doc", id: "reference/http-api", label: "HTTP and WebSocket" },
        { type: "doc", id: "reference/configuration", label: "Configuration" },
        { type: "link", label: "API reference", href: "/api-reference" },
      ],
    },
  ],
  internals: [
    { type: "doc", id: "internals/index", label: "Overview" },
    {
      type: "category",
      label: "Runtime",
      collapsed: false,
      items: [
        { type: "doc", id: "internals/architecture", label: "Architecture" },
        {
          type: "doc",
          id: "internals/queue-and-steer",
          label: "Queue and steer",
        },
        { type: "doc", id: "internals/subagents", label: "Subagents" },
        { type: "doc", id: "internals/channels", label: "Channels" },
        { type: "doc", id: "internals/tools-and-mcp", label: "Tools and MCP" },
        { type: "doc", id: "internals/sandboxes", label: "Sandboxes" },
        { type: "doc", id: "internals/storage", label: "Storage" },
        { type: "doc", id: "internals/security", label: "Security" },
        { type: "doc", id: "internals/observability", label: "Observability" },
      ],
    },
    {
      type: "category",
      label: "Run Broods",
      collapsed: false,
      items: [
        { type: "doc", id: "internals/self-hosting", label: "Self-hosting" },
        { type: "doc", id: "internals/operations", label: "Operations" },
        { type: "doc", id: "internals/ci-cd", label: "CI/CD" },
      ],
    },
  ],
};

export default sidebars;
