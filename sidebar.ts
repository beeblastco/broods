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
        'channels',
        'sandbox',
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
    {
      type: 'category',
      label: 'API Reference',
      collapsed: false,
      items: [
        {
          type: 'doc',
          id: 'direct-api',
          label: 'Direct API Guide',
        },
        {
          type: 'doc',
          id: 'account-management',
          label: 'Account Management Guide',
        },
      ],
    },
  ],
};

export default sidebars;
