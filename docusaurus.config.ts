/**
 * Docusaurus configuration for BeeBlast documentation.
 */

import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: Config = {
  title: 'BeeBlast Developer Docs',
  favicon: 'img/favicon.ico',

  url: 'https://docs.beeblast.io',
  baseUrl: '/',

  onBrokenLinks: 'throw',
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebar.ts',
          routeBasePath: '/',
          path: 'docs',
          exclude: ['**/*.test.*', '**/_*/**'],
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      '@scalar/docusaurus',
      {
        id: 'api-reference',
        label: 'API Reference',
        route: '/api-reference',
        configuration: {
          spec: {
            content: fs.readFileSync(path.resolve(__dirname, 'docs/api-reference/openapi.yaml'), 'utf8'),
          },
        },
      },
    ],
    function generatedModulesWebpackMode() {
      return {
        name: 'generated-modules-webpack-mode',
        configureWebpack() {
          return {
            module: {
              rules: [
                {
                  test: /\.js$/,
                  include: /[\\/]\.docusaurus[\\/]/,
                  type: 'javascript/auto',
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

  themes: ['@docusaurus/theme-mermaid'],

  themeConfig: {
    mermaid: {
      theme: {
        light: 'neutral',
        dark: 'dark',
      },
    },
    navbar: {
      title: 'Docs',
      logo: {
        alt: 'BeeBlast Logo',
        src: 'img/light-full.svg',
        srcDark: 'img/dark-full.svg',
      },
      items: [
        {
          href: 'https://dasboard.beeblast.co/',
          label: 'Dashboard',
          position: 'right',
        },
        {
          href: 'https://discord.gg/F48633Uca',
          label: 'Discord',
          position: 'right',
        },
        {
          href: 'https://github.com/beeblastco/filthy-panty',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
