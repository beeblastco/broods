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
          type: 'doc',
          id: 'memory-and-session',
          label: 'Memory and Session',
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
          ],
        },
        {
          type: 'category',
          label: 'Sandbox',
          collapsed: true,
          link: {
            type: 'doc',
            id: 'sandbox/index',
          },
          items: [
            {
              type: 'doc',
              id: 'sandbox/daytona',
              label: 'Daytona',
            },
            {
              type: 'doc',
              id: 'sandbox/e2b',
              label: 'E2B',
            },
            {
              type: 'doc',
              id: 'sandbox/lambda',
              label: 'Lambda',
            },
          ],
        },
        {
          type: 'doc',
          id: 'sub-agents',
          label: 'Subagent',
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
