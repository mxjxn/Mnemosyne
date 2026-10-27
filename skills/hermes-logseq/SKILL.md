---
visibility: public
name: hermes-logseq
description: Hermes Agent + Logseq knowledge graph integration — architecture, block format, sync, and wiring guide.
version: 1.1.0
metadata:
  hermes:
    tags: [logseq, knowledge-graph, hermes, notes]
---

# Hermes Logseq — Core Integration

Connect your Hermes Agent to a Logseq knowledge graph via the headless logseqd API server. Write pages, query blocks, and build a persistent second brain that survives across agent sessions.

## Architecture

Two operational modes — same stack, different sync story:

### Headless Mode (Hermes-only)

```
Hermes Agent ──writes──→ pages/*.md ──inotify──→ logseqd (API)
                                              ↓
                                         Viewer (web)
```

No desktop app needed. Hermes writes markdown files directly to the graph directory. inotify triggers instant reindex in logseqd. The viewer serves the graph to any browser.

**Best for:** Mac mini / server setups where Hermes is the primary writer. Humans read and browse via the web viewer.

### Desktop-Assisted Mode

```
Logseq Desktop ──git push──→ GitHub ──git watcher──→ pages/*.md ──inotify──→ logseqd
                                                                          ↓
                                                                     Viewer (web)
       ↑                                                              
  Human reads/edits locally                                               
```

Human edits in Logseq desktop, pushes via git plugin. Server-side git watcher pulls changes. Hermes and logseqd see updates automatically.

**Best for:** People who want the full Logseq desktop editing experience alongside their Hermes agent.

### Components

| Component | Role | Repo Location |
|-----------|------|---------------|
| logseqd | Headless Datalog API server | `logseqd/` (submodule) |
| inotify watcher | Auto-reindex on file changes | `scripts/inotify-watcher.sh` |
| git watcher | Auto-pull from GitHub (desktop mode) | `scripts/git-watcher.sh` |
| Viewer | Web UI for browsing the graph | `viewer/` |
| Skills | Hermes skill files | `skills/` |

## Quick Start

```bash
git clone --recurse-submodules https://github.com/mxjxn/hermes-logseq.git
cd hermes-logseq
```

Use the repository's [manual deployment guide](https://github.com/mxjxn/hermes-logseq/blob/main/docs/deployment.md)
for the current Clojure entry point and reverse-proxy setup. `setup.sh` is a
legacy installer whose launch/copy paths do not match the current tree.
The included watcher uses Linux `inotifywait`; native macOS watching is not implemented.

## Logseq Block Format

Logseq is fundamentally list-based. Every piece of content is a bullet point. Indentation (tabs, not spaces) is the hierarchy — it IS the graph structure.

### Page Structure

```markdown
title:: Page Title Here
tags:: [[ParentPage]] #tag1 #tag2
- First block of content #block-tag
	- Child block (tab-indented) #sub-tag
		- Grandchild block (double tab)
- Second block of content
```

### The Rules

1. Every content line starts with `- ` (dash + space)
2. `\t- ` (tab + dash + space) = one nesting level deeper
3. A line without a dash belongs to the block above (properties, continuation)
4. Page properties (`title::`, `tags::`) on the first line — no dash, no YAML `---` delimiters
5. Blank lines between blocks are fine — visual spacers, not structural

### Tags

Tags create navigable pages. Use sparingly — every `#tag` becomes a page someone might visit.

- `tags::` on the first line for page-level categorization: `tags:: [[ParentPage]] #topic`
- Inline tags only for concepts worth navigating to as a page
- `[[]]` for page references: `[[ProjectName]]`, `[[Person]]`

### Properties

```markdown
- Block title
  property:: value
  another-prop:: value
```

Properties belong to the preceding block and have no bullet marker. The parser returns them in a `properties` map; it does not implement inherited property queries.

## logseqd API Reference

The API runs on a configurable port (default: 8471). All responses are JSON.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/pages` | GET | List all pages |
| `/page/:title` | GET | Get page blocks with parent references |
| `/search?q=query` | GET | Full-text search across blocks |
| `/query` | POST | Datalog query (EDN body) |
| `/reindex` | POST | Full graph reindex |
| `/reindex-file` | POST | Reindex single file (EDN: `{:file "name.md"}`) |
| `/append` | POST | Append block to page |
| `/insert-block` | POST | Insert block after specific block |
| `/change-block-level` | POST | Indent/outdent a block |
| `/update-block` | POST | Replace block content |
| `/delete-block` | POST | Delete a block, optionally inheriting its children |
| `/property?key=type&value=job` | GET | Query properties; add `scope=page` for page properties |

Properties are parsed separately from block content and are queryable through
`/property` and Datalog attributes such as `:prop/type`. They appear under
`properties` in API responses. `/search` excludes journals, date/system-page
patterns, and pages with `private:: true`; use page reads or Datalog when needed.

## File Organization

```
your-graph/
├── pages/          # Logseq pages (main content)
├── journals/       # Daily journal files (YYYY_MM_DD.md)
├── logseq/
│   ├── config.edn  # Logseq configuration
│   └── templates/   # Journal default templates
└── .git/           # Version control
```

## Content Type Convention

When generating published content, use two orthogonal axes:

- `type::` or `#type/*` tag = the format/shape (daily-scan, deep-research, evening-digest, etc.)
- Topic tags = what it's about (#cryptoart, #farcaster, #ai, etc.)

One document has exactly one type but can carry many topic tags.

## See Also

- `hermes-logseq-viewer` — deploying and configuring the web viewer
- `hermes-logseq-cron` — cron job patterns for check-ins, research, and publishing
