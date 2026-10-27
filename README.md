# hermes-logseq

Your Logseq graph — plain markdown files you own — with a private web editor and a public read-only site on top. No build steps, no third-party services, no export step.

```
                Logseq graph (plain .md files)
                              │
                   ┌──────────▼──────────┐
                   │       logseqd       │   headless API over the graph
                   └────┬───────────┬────┘
          full read/    │           │    read-only,
          write access  │           │    privacy-filtered
                        ▼           ▼
             ┌──────────────┐   ┌────────┐       ┌──────────────┐
             │   viewer/    │   │ gate/  │  ───► │   reader/    │
             │ private      │   │ public │       │ public site  │
             │ editor (PWA) │   │ proxy  │       │ (static JS)  │
             └──────────────┘   └────────┘       └──────────────┘
```

## The four pieces

**`logseqd/`** — the engine. A Clojure service (runs on Babashka) that indexes your graph into a Datalog database and serves it as a REST API: pages, blocks, search, queries, writes, image uploads. It is the only component that touches your note files. A file watcher reindexes on every change — write from the viewer, an agent, or Logseq desktop, and everything sees the same graph within a second. *(git submodule)*

**`viewer/`** — the private side. A zero-build vanilla JS PWA: journal timeline, page browsing, block-level editing, library and graph views, image upload. Deploy it behind auth (basic auth is enough) and point it straight at logseqd.

**`gate/`** — the boundary. A read-only proxy that exposes exactly the endpoints the reader needs and nothing else. Pages marked `private:: true` never pass through, and from the outside a private page is indistinguishable from a nonexistent one. Publishing is just a property: `position:: N` pins a page to the reader's front page; removing it unpublishes.

**`reader/`** — the public side. Static JS, no build step, talks only to the gate. Dated entries collapse into series, articles render blog-style with excerpts, deep links and search work. Your notes become a website because they already are one.

Live example: **[notes.mxjxn.com](https://notes.mxjxn.com)** — the reader running against a production graph.

## Same graph, two doors

Write from Logseq desktop, the viewer, or an AI agent — it's all plain markdown, so anything that can write files is a first-class client.

- **Headless** (agent-only): agent writes markdown → watcher → logseqd → viewer. No Logseq desktop needed.
- **Desktop-assisted**: Logseq desktop → git push → git watcher → files → same chain.

## Quick start

```bash
git clone --recurse-submodules https://github.com/mxjxn/hermes-logseq.git
cd hermes-logseq
./setup.sh
```

The installer asks where your graph lives, which port to run logseqd on, headless or desktop mode, and whether to deploy the viewer. It handles dependency detection, PM2 setup, watcher configuration, and Hermes skill installation.

**Requirements:** [Babashka](https://babashka.org) · `inotify-tools` (`apt`/`brew`) · PM2 (recommended) · a Logseq graph directory. Any static file server + reverse proxy in front (Caddy configs live in the skills).

## Hermes Desktop plugin

Open your server graph inside Hermes Desktop: a Notes workspace, a companion
pane beside chat, journal capture, block editing, and **Discuss with Hermes**.
The plugin connects through your selected gateway and keeps using your existing
server graph and GitHub sync.

See [installation and usage](docs/hermes-desktop.md). The Desktop frontend and
VPS backend must both be installed/enabled. Block editing requires the pinned
logseqd revision included here.

## Hermes skills

Three focused skills for [Hermes Agent](https://hermes-agent.nousresearch.com), each independently useful:

| Skill | Purpose |
|-------|---------|
| `hermes-logseq` | Core integration — architecture, block format rules, API reference |
| `hermes-logseq-viewer` | Viewer deployment — reverse proxy setup, customization, PWA config |
| `hermes-logseq-cron` | Cron patterns — check-ins, research pipelines, publishing workflows |

## Status

⚠️ Untested as a template. It runs one person's production notes stack; the installer has not been exercised on a fresh machine. Expect rough edges — feedback and PRs welcome.

<details>
<summary>Maintainer TODOs</summary>

- [ ] Test `setup.sh` end-to-end on fresh Linux + macOS
- [ ] Verify macOS watcher compatibility
- [ ] Test viewer deployment behind Nginx (Caddy tested)
- [ ] Add CI: shellcheck + skill frontmatter validation
- [ ] `docker-compose.yml` for non-Babashka users
- [ ] Update skill docs when queryable property support ships in logseqd
</details>
