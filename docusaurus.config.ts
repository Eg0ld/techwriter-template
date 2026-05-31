import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This file runs in Node.js — don't use client-side code here (browser APIs, JSX…).
//
// This is YOUR documentation site. It ships blank: a single docs instance served
// at the site root. Autoscribe fills `docs/` over time by watching the repo you
// configure in `.autoscribe/config.json`, and you are free to edit any page by
// hand. Everything here is meant to be edited — start by setting the four
// deployment values below.

// ── Deployment values — EDIT THESE ───────────────────────────────────────────
// These four must match where the site is hosted (GitHub Pages by default).
// The "make it your own" scaffolder / the pages-deploy workflow can fill them in
// for you, but they are safe, obvious placeholders so the site builds as-is.
//
//   For a project page at https://<org>.github.io/<repo>/ use:
//     url:  'https://<org>.github.io'
//     baseUrl: '/<repo>/'
//   For a user/org page at https://<org>.github.io/ use:
//     url:  'https://<org>.github.io'
//     baseUrl: '/'
//
// Env vars (set by CI) win when present, so a deploy can override without a code
// change; otherwise the literal placeholders are used.
const url = process.env.SITE_URL ?? 'https://example.github.io'; // TODO: your GitHub Pages origin
const baseUrl = process.env.BASE_URL ?? '/'; // TODO: '/<repo>/' for a project page
const organizationName = process.env.GH_ORG ?? 'your-org'; // TODO: your GitHub org/user
const projectName = process.env.GH_REPO ?? 'my-docs'; // TODO: this repo's name

const config: Config = {
  title: 'My Documentation',
  tagline: 'Documentation for my project.',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
  },

  url,
  baseUrl,
  organizationName,
  projectName,

  // Start lenient so a blank/in-progress site never fails to build. Tighten to
  // 'throw' once you have real content and want broken links to fail CI.
  onBrokenLinks: 'warn',
  onBrokenAnchors: 'ignore',

  markdown: {
    // 'detect' = parse .md as (lenient) CommonMark and .mdx as MDX. This lets
    // generated/hand-written .md pages contain raw '{', '<', '$' without MDX
    // trying to interpret them as JSX.
    format: 'detect',
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
          // Single docs instance served at the site root ('/').
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          // Point this at this repo so each page gets an "Edit this page" link.
          editUrl: `https://github.com/${organizationName}/${projectName}/tree/main/`,
        },
        // No blog — this is a docs site. Flip to an options object to enable one.
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      // Default Docusaurus theme; respect the visitor's OS preference, with a
      // toggle available. Set respectPrefersColorScheme: false to force a mode.
      defaultMode: 'light',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'My Documentation',
      logo: {
        alt: 'My Documentation',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          href: `https://github.com/${organizationName}/${projectName}`,
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Welcome', to: '/'},
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: `https://github.com/${organizationName}/${projectName}`,
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} ${organizationName}. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
