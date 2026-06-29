import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'doc',
      id: 'home',
      label: 'Home',
    },
    {
      type: 'doc',
      id: 'getting-started',
      label: 'Getting Started',
    },
    {
      type: 'doc',
      id: 'architecture',
      label: 'Architecture and Workflow',
    },
    {
      type: 'doc',
      id: 'data-security',
      label: 'Data Security',
    },
    {
      type: 'doc',
      id: 'observability',
      label: 'Observability',
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: false,
      items: [
        {
          type: 'doc',
          id: 'resources',
          label: 'Resources & Config',
        },
        {
          type: 'doc',
          id: 'sdk',
          label: 'SDK & API',
        },
      ],
    },
    {
      type: 'category',
      label: 'Features',
      collapsed: false,
      items: [
        {
          type: 'category',
          label: 'Workspace',
          collapsed: false,
          link: {
            type: 'doc',
            id: 'workspace/index',
          },
          items: [
            {
              type: 'doc',
              id: 'workspace/memory-and-session',
              label: 'Memory and Session',
            },
            {
              type: 'doc',
              id: 'workspace/storage',
              label: 'Storage',
            },
            {
              type: 'category',
              label: 'Sandbox',
              collapsed: true,
              link: {
                type: 'doc',
                id: 'workspace/sandbox/index',
              },
              items: [
                {
                  type: 'doc',
                  id: 'workspace/sandbox/index',
                  label: 'Core design',
                },
                {
                  type: 'doc',
                  id: 'workspace/sandbox/getting-started',
                  label: 'Getting Started',
                },
                {
                  type: 'doc',
                  id: 'workspace/sandbox/snapshot',
                  label: 'Snapshot',
                },
                {
                  type: 'doc',
                  id: 'workspace/sandbox/networking',
                  label: 'Networking',
                },
                {
                  type: 'doc',
                  id: 'workspace/sandbox/security',
                  label: 'Security',
                },
                {
                  type: 'doc',
                  id: 'workspace/sandbox/hook',
                  label: 'Hook',
                },
                {
                  type: 'doc',
                  id: 'workspace/sandbox/best-practice',
                  label: 'Best practice',
                },
                {
                  type: 'category',
                  label: 'Integration',
                  collapsed: true,
                  items: [
                    {
                      type: 'doc',
                      id: 'workspace/sandbox/lambda',
                      label: 'Lambda',
                    },
                    {
                      type: 'doc',
                      id: 'workspace/sandbox/daytona',
                      label: 'Daytona',
                    },
                    {
                      type: 'doc',
                      id: 'workspace/sandbox/e2b',
                      label: 'E2B',
                    },
                    {
                      type: 'doc',
                      id: 'workspace/sandbox/vercel',
                      label: 'Vercel',
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'doc',
          id: 'webhook',
          label: 'Lifecycle Webhook',
        },
        {
          type: 'doc',
          id: 'tools',
          label: 'External Tool',
        },
        {
          type: 'doc',
          id: 'skills',
          label: 'Skills',
        },
        {
          type: 'category',
          label: 'Channels',
          collapsed: true,
          link: {
            type: 'doc',
            id: 'channels/index',
          },
          items: [
            {
              type: 'doc',
              id: 'channels/telegram',
              label: 'Telegram',
            },
            {
              type: 'doc',
              id: 'channels/github',
              label: 'GitHub',
            },
            {
              type: 'doc',
              id: 'channels/slack',
              label: 'Slack',
            },
            {
              type: 'doc',
              id: 'channels/discord',
              label: 'Discord',
            },
            {
              type: 'doc',
              id: 'channels/pancake',
              label: 'Pancake',
            },
            {
              type: 'doc',
              id: 'channels/zalo',
              label: 'Zalo',
            },
          ],
        },
        {
          type: 'doc',
          id: 'sub-agents',
          label: 'Subagent',
        },
        {
          type: 'doc',
          id: 'crons',
          label: 'Cron Jobs',
        },
      ],
    },
    {
      type: 'category',
      label: 'Development',
      collapsed: false,
      items: [
        {
          type: 'doc',
          id: 'extending',
          label: 'Extending',
        },
        'deployment',
        {
          type: 'doc',
          id: 'ci-cd',
          label: 'CI/CD',
        },
        {
          type: 'doc',
          id: 'operations',
          label: 'Operations',
        },
      ],
    },
  ],
};

export default sidebars;
