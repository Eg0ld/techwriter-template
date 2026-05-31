---
sidebar_position: 1
title: Welcome
slug: /
---

# Welcome

This is **your** documentation site. Right now it's blank — and that's the point.
It's a fresh, self-contained Docusaurus site that belongs entirely to you, to do
whatever you want with.

## What happens next

This repo ships with **techwriter.ai**, a small documentation engine that runs
inside GitHub Actions. Once you point it at a code repository to watch (in
[`.autoscribe/config.json`](https://github.com/) — set `watchedRepo` to
`owner/name`), techwriter.ai will:

1. Survey that codebase and propose a documentation structure.
2. Write the initial set of pages into this `docs/` folder.
3. Keep them in sync from then on — every time a pull request merges in the
   watched repo, it opens a docs pull request here for you to review and merge.

So these pages will gradually fill themselves in. You stay in control: nothing
goes live until you merge.

## You can edit freely

You don't have to wait for the agent. This is an ordinary Docusaurus site, so you
can write and organize Markdown yourself at any time:

- Add a new page by dropping a `.md` (or `.mdx`) file into `docs/`.
- Set its position in the sidebar with the `sidebar_position` front-matter field.
- Group pages into sections by putting them in subfolders (add a
  `_category_.json` to label and order each folder).

The sidebar is generated automatically from the folder structure, so new files
just show up.

## Run it locally

```bash
npm install
npm start        # live-reloading dev server at http://localhost:3000
npm run build    # production build (what gets deployed)
```

It's yours — rename the title, change the theme, delete this page, write your own
content. Make it your own.
