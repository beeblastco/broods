/**
 * Docusaurus configuration for BeeBlast documentation.
 */

import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'BeeBlast Docs',
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
          href: 'https://github.com/beeblastco/filthy-panty',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
