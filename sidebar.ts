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
              id: 'workspace/tasks',
              label: 'Tasks',
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
                  id: 'workspace/sandbox/lambda',
                  label: 'Lambda',
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
          id: 'cron-jobs',
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
      ],
    },
  ],
};

export default sidebars;
