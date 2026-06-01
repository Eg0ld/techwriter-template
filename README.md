# Autoscribe — tenant docs repo

> **This is your own, self-contained project.** This repository is a complete,
> **blank** [Docusaurus](https://docusaurus.io/) starter that ships with the
> Autoscribe engine wired in. The **"Make it your own"** flow creates a *fresh
> repository from this template* in **your** account — it does **not** fork the
> techwriter.ai showcase or point back at it. From the moment it's created, you own
> everything in it: the docs, the config, the theme, the history. The showcase
> you came from is just one example of what this template grows into.

This repository is a **self-building documentation site**. It is a
[Docusaurus](https://docusaurus.io/) knowledge base whose content is written
and kept in sync by an LLM (Claude Code) that watches a separate **code
repository** and turns its merged pull requests into documentation updates.

## What's in the box

Two halves that work together, side by side in this one repo:

1. **A blank Docusaurus site** (the part you see). A minimal, neutral,
   ready-to-build Docusaurus 3.10 + TypeScript starter:

   ```
   package.json            # Docusaurus deps + build scripts (name: "my-docs")
   docusaurus.config.ts    # neutral branding; EDIT the four deploy values up top
   sidebars.ts             # auto-generated from the docs/ folder tree
   tsconfig.json           # extends @docusaurus/tsconfig
   docs/intro.md           # the only page so far — a friendly "Welcome" placeholder
   src/css/custom.css      # light, neutral tweaks on the default Infima theme
   static/                 # favicon, logo, .nojekyll — edit/replace freely
   .gitignore
   ```

   It builds and runs as-is (`npm install && npm start`), and it's **yours to do
   whatever you want with** — rename it, restyle it, delete the placeholder page,
   write pages by hand. Nothing here is special or off-limits.

2. **The Autoscribe engine** (the part that fills it in). The `.github/workflows`
   and `.autoscribe/` directories below. You tell it which code repo to watch in
   [`.autoscribe/config.json`](#configuring-autoscribeconfigjson), and over time
   it writes pages into the blank `docs/` folder and keeps them in sync — opening
   pull requests you review and merge. **You can always edit the Markdown
   yourself too;** the agent and your own edits coexist in the same `docs/` tree.

The two halves are independent: the site builds and deploys even before
Autoscribe has written anything, and you can hand-author the whole thing and
never run the agent if you prefer.

You — the repo owner — never have to write the docs by hand. You review and
merge pull requests. Everything else is GitHub-native:

- **Content** = Markdown/MDX under `docs/` (git is the source of truth).
- **The agent** = Claude Code, running inside **GitHub Actions**.
- **Compute/API key** = your own `ANTHROPIC_API_KEY`, stored as an encrypted
  **repo secret**. The platform never holds it.
- **The review surface** = a **GitHub Pull Request**. No custom review UI.
- **Hosting** = **GitHub Pages**, redeployed automatically on merge.
- **State** = a single committed `.autoscribe/state.json` + git history.

There is no database, no server to run, and no third-party account beyond
GitHub and your Anthropic key. If you ever want to leave, the entire
project — content, config, run history — is already in this repo.

---

## How it fits together

```
                  ┌──────────────────────────────────────────────┐
                  │           WATCHED repo  (your code)           │
                  │   e.g. github.com/<you>/<your-code-repo>      │
                  └──────────────────────────────────────────────┘
                                      │
                       a PR is merged into the default branch
                                      │
                                      ▼
                   ┌─────────────────────────────────────┐
                   │  repository_dispatch  (or cron poll) │   ← cross-repo trigger
                   └─────────────────────────────────────┘
                                      │
                                      ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                    THIS repo  (your docs site)                         │
   │                                                                        │
   │  .github/workflows/autoscribe-sync.yml   ──runs Claude Code──┐         │
   │                                                              │         │
   │   1. read the merged PR's diff                               │         │
   │   2. classify the doc gap (NO_GAP fast-path is cheap)        │         │
   │   3. if a gap: edit docs/**.md(x), update sidebars/_category │         │
   │   4. editorial pass (house style)                            │         │
   │   5. commit to the rolling branch  autoscribe/updates        │         │
   │   6. open or update the standing Draft PR                    │         │
   │   7. append a run-log entry to .autoscribe/state.json        │         │
   │                                                              ▼         │
   │            ┌───────────────────────────────────────────────────────┐  │
   │            │  Draft PR  "📚 Docs updates"  (autoscribe/updates → main)│ │
   │            │  accumulates across many watched-repo PRs              │  │
   │            └───────────────────────────────────────────────────────┘  │
   │                                      │                                 │
   │                  human reviews · clicks "Ready for review" · Merge     │
   │                                      │                                 │
   │                                      ▼                                 │
   │  .github/workflows/pages-deploy.yml   ──build & deploy──┐              │
   └─────────────────────────────────────────────────────────┼────────────┘
                                                             ▼
                                          ┌──────────────────────────────┐
                                          │  GitHub Pages (live site)     │
                                          │  https://<you>.github.io/...  │
                                          └──────────────────────────────┘
```

One-line version:

> **watched PR merged → dispatch → `autoscribe-sync` Action → Draft PR → human merge → `pages-deploy` → live site.**

---

## The three workflows

All three live in `.github/workflows/` and all three run Claude Code (except
`pages-deploy`, which is a plain Docusaurus build).

### 1. `autoscribe-init.yml` — first build

**Trigger:** manual (`workflow_dispatch`), normally fired once during onboarding.

**What it does:** Claude Code shallow-clones the watched repo, surveys it
(languages, structure, READMEs, public API surface, entry points), proposes a
documentation information architecture, then fans out — capped in **waves** to
control spend — writing one section of Markdown per part of the codebase. An
**editorial pass** unifies voice, front-matter, and cross-links. It commits the
whole `docs/` tree plus `sidebars.ts`/`_category_.json` files to a branch and
opens a PR titled **"📚 Initial documentation"** for you to review and merge.

Defaults to a stronger model for this one-time broad pass.

### 2. `autoscribe-sync.yml` — ongoing per-PR sync

**Trigger:** `repository_dispatch` (event type `watched-pr-merged`) sent by the
platform's GitHub App when a PR merges in the watched repo. A scheduled `cron`
poll is the zero-backend fallback — it walks the watched repo's newly-merged PRs
since the cursor stored in `.autoscribe/state.json`.

**What it does, per merged PR:**

1. **Fetch** the PR diff, changed files, and title.
2. **Classify the gap.** Claude decides whether the change actually affects the
   docs and, if so, what kind of gap it is:

   | gap type           | meaning                                                        |
   |--------------------|----------------------------------------------------------------|
   | `NO_GAP`           | tests/CI/internal refactor/already documented → stop, cheap    |
   | `MISSING_CONTENT`  | a public surface changed and no page covers the new behaviour  |
   | `OUTDATED_CONTENT` | an existing page contradicts the new behaviour                 |
   | `NEW_PAGE`         | a whole new topic with no parent page                          |
   | `STRUCTURAL`       | the sidebar / IA needs reorganising                            |
   | `STYLE`            | copy-editing only                                              |

   `NO_GAP` is the **common, cheap path** — most PRs cost roughly one small
   model call and never touch the docs.
3. **Locate** the affected pages by searching `docs/` locally.
4. **Edit or create** the Markdown. A new page also updates the sidebar
   (`sidebars.ts` is autogenerated from the folder tree + `_category_.json`, so
   "updating the sidebar" usually means placing the file in the right folder
   with the right `sidebar_position` front-matter).
5. **Editorial pass** for house style on the changed prose.
6. **Commit** to the rolling `autoscribe/updates` branch and open/append the
   standing Draft PR (see below).
7. **Record** the result (PR processed, gap type, files touched, cost, errors)
   in `.autoscribe/state.json` and advance the cursor.

### 3. `pages-deploy.yml` — publish

**Trigger:** `push` to the default branch (i.e. the moment a docs PR merges).

**What it does:** runs `npm ci && npm run build` and deploys the static
Docusaurus output to GitHub Pages. No Claude involved. This is what makes the
site go live a minute or two after you click **Merge**.

---

## The GitHub-native drafting model

The reference pipeline this was ported from accumulated in-progress edits in a
SQLite **`drafts` table** and reviewed them in a bespoke inline-diff web app.
Autoscribe **replaces both with native GitHub primitives**:

- **One rolling branch — `autoscribe/updates`.** `autoscribe-sync` never opens a
  fresh PR per watched-repo PR. It pushes onto this single long-lived branch.
- **One standing Draft Pull Request** (`autoscribe/updates` → default branch),
  kept in **Draft** state. Each merged watched-repo PR adds commits to it, so
  the draft **accumulates work across many source PRs** — exactly the
  "drafts converge across PRs" behaviour of the reference's drafts table, but
  visible, diffable, and commentable in git.
- **The PR _is_ the review UI.** GitHub's native diff, line comments,
  suggestions, and approvals replace the custom hunk-review front end. Nothing
  to host.
- **You decide when to publish.** When the accumulated docs look good, mark the
  Draft PR **"Ready for review"** and **Merge** it. `pages-deploy` redeploys.
  Autoscribe then opens a fresh empty Draft PR for the next batch.

Mapping from the reference's tables to GitHub:

| Reference (SQLite)     | Autoscribe (GitHub-native)                          |
|------------------------|-----------------------------------------------------|
| `drafts` table         | the `autoscribe/updates` branch + standing Draft PR |
| `suggestions` / `hunks`| the PR diff itself                                  |
| review decisions       | PR review + merge                                   |
| `prs` queue / cursor   | `.autoscribe/state.json`                            |
| `runLogs`              | `.autoscribe/state.json` + git history              |

> **Tip:** treat the Draft PR like an editor's desk. Leave line comments on
> anything Autoscribe got wrong before merging — your comments are visible to
> the next sync run, which can address them.

---

## Where the API key lives

Your `ANTHROPIC_API_KEY` is stored as an **encrypted GitHub Actions repo
secret** on *this* docs repo. It is:

- **Yours.** It is your Anthropic spend and your rate limits.
- **Never on the platform's servers.** Onboarding writes it straight to the repo
  secret via the GitHub API and forgets it.
- **Read only by the Actions runner** at job time, as
  `${{ secrets.ANTHROPIC_API_KEY }}`. It is masked in logs and not exposed to
  forked-PR workflows.

Set or rotate it under **Settings → Secrets and variables → Actions → New
repository secret**, name `ANTHROPIC_API_KEY`.

Other non-secret settings live as **repo variables** (Settings → Secrets and
variables → Actions → *Variables*) or in `.autoscribe/config.json` (below).

---

## Configuring `.autoscribe/config.json`

This file is the project's contract. It travels with the repo, so the whole
configuration is portable. Example:

```json
{
  "version": 1,
  "watchedRepo": "kibook/s1kd-tools",
  "watchedBranch": "main",
  "docsDir": "docs",
  "site": {
    "audience": "developer",
    "style": "concise, second-person, active voice",
    "sections": ["Introduction", "Core Concepts", "Guides", "Reference"]
  },
  "agent": {
    "model": "claude-sonnet-4-5",
    "initModel": "claude-opus-4-1",
    "maxWaveConcurrency": 6,
    "perRunSpendCeilingUsd": 5,
    "dryRunInitialBuild": false
  },
  "draft": {
    "branch": "autoscribe/updates",
    "prTitle": "📚 Docs updates",
    "openAsDraft": true
  }
}
```

| Key                                | What it controls                                                                 |
|------------------------------------|----------------------------------------------------------------------------------|
| `watchedRepo`                      | `owner/name` of the code repo to document. **One watched repo per docs site.**   |
| `watchedBranch`                    | Branch whose merged PRs trigger sync (default `main`).                            |
| `docsDir`                          | Where generated Markdown lives (default `docs`).                                  |
| `site.audience` / `style`          | Voice and reader the editorial pass writes for.                                  |
| `site.sections`                    | Hints for the top-level information architecture during `autoscribe-init`.       |
| `agent.model` / `initModel`        | Per-PR model vs the stronger model used only for the one-time initial build.     |
| `agent.maxWaveConcurrency`         | Cap on parallel sub-agents per wave — the main cost guardrail.                   |
| `agent.perRunSpendCeilingUsd`      | Pause + log if a run would exceed this. Protects your Anthropic bill.            |
| `agent.dryRunInitialBuild`         | If `true`, the first build previews the IA without writing pages.                |
| `draft.branch` / `prTitle`         | The rolling branch and standing Draft PR title.                                  |
| `draft.openAsDraft`                | Keep the accumulating PR in Draft until you mark it ready.                        |

Anything secret (the API key) is **not** in this file — it is a repo secret.

---

## State: `.autoscribe/state.json`

A single committed JSON file is the entire per-tenant database. It holds:

- **`cursor`** — the last processed watched-repo PR (so the cron fallback and
  restarts don't double-process).
- **`queue`** — PRs seen but not yet synced, with lifecycle status
  (`queued → in_progress → no_gap | drafted | published`).
- **`runLog`** — an append-only record: PRs analysed, gap types, files touched,
  token/cost estimates, and errors. Git history gives you a free, auditable
  timeline of every change the agent made and why.

Because it's a plain committed file, you can read it on GitHub, diff it over
time, or feed it to the platform dashboard via the API. No DB to provision.

---

## Repository layout

```
.
├── docs/                        # generated Markdown/MDX — the content (git = truth)
│   ├── introduction/
│   ├── core-concepts/
│   └── reference/
├── src/                         # custom landing page + React widgets (Docusaurus)
├── static/                      # images, favicon, downloads
├── sidebars.ts                  # autogenerated nav (folders + _category_.json)
├── docusaurus.config.ts         # site config (set url/baseUrl for Pages)
├── package.json                 # Docusaurus build scripts
├── .autoscribe/
│   ├── config.json              # project config (above)
│   └── state.json               # cursor + queue + run log
└── .github/workflows/
    ├── autoscribe-init.yml      # one-time initial build → "📚 Initial documentation" PR
    ├── autoscribe-sync.yml      # per-merged-PR sync → rolling Draft PR
    └── pages-deploy.yml         # build + deploy to GitHub Pages on merge
```

---

## First-time setup checklist

1. **Set the secret.** Settings → Secrets and variables → Actions →
   `ANTHROPIC_API_KEY`.
2. **Point at your code.** Edit `.autoscribe/config.json` → `watchedRepo`.
3. **Set the deploy URL.** In `docusaurus.config.ts`, set `url`, `baseUrl`,
   `organizationName`, and `projectName` for your GitHub Pages address
   (`https://<org>.github.io/<repo>/` → `baseUrl: '/<repo>/'`).
4. **Enable Pages.** Settings → Pages → Source = **GitHub Actions**.
5. **Run the first build.** Actions → **autoscribe-init** → *Run workflow*.
   Review and merge the resulting **"📚 Initial documentation"** PR.
6. **Wire the trigger.** Install the platform's GitHub App on the watched repo
   (recommended), or rely on the cron poll in `autoscribe-sync.yml`.

From here it runs itself: merge a PR in your code repo, watch the Draft PR grow,
merge it when you're happy, and the site redeploys.

---

## Local development

```bash
npm ci
npm start        # local dev server with hot reload
npm run build    # production build (what pages-deploy runs)
npm run serve    # preview the production build locally
```

You rarely need this — Autoscribe writes the content and Actions builds it — but
it's here if you want to hand-edit a page or preview before merging.

---

## FAQ

**Does it open a PR for every single watched-repo PR?**
No. It pushes onto one rolling branch and keeps **one** standing Draft PR that
accumulates across many PRs. You merge it when you choose.

**Will it run up my Anthropic bill?**
The `NO_GAP` fast-path makes most PRs cheap, wave concurrency is capped, and
`perRunSpendCeilingUsd` pauses a run before it overspends. The initial full
build is the one large job — use `dryRunInitialBuild` to preview it first.

**Where does the platform store my key or content?**
Nowhere. The key is a repo secret; the content, config, and run log are all in
this repo. The platform is a stateless convenience, not a lock-in.

**Can I watch more than one repo?**
One watched repo per docs site for now. Use a second docs repo for a second
codebase.
