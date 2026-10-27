---
visibility: public
name: hermes-logseq-viewer
description: Deploy and configure the private web editor for a Logseq graph via logseqd.
version: 1.1.0
metadata:
  hermes:
    tags: [logseq, viewer, web, knowledge-graph]
---

# Private web editor

The files in `viewer/` implement a private, zero-build web editor for the graph.
The current deployment reference is the repository's
[manual web-stack guide](https://github.com/mxjxn/hermes-logseq/blob/main/docs/deployment.md).

## Current capabilities

- Journal timeline, expandable journal composer, and full writing mode
- Local drafts and an offline capture queue
- Page browsing, search, tags, and `[[page references]]`
- Edit, delete, indent/outdent, New block, and New sub-block actions
- Library and graph views
- Structured Note/Event/Ask composition and slash templates
- Installable PWA and capture/share shortcuts

Search uses logseqd's `/search`, which excludes journals, date/system-page
patterns, and pages marked `private:: true`. Do not promise whole-graph search.
Push-notification UI is present but requires the corresponding backend and
browser setup. Cached reads and capture queues are not complete offline sync.
The viewer does not implement Logseq query rendering, canvas, or the separate
Logseq database format. There is no image-upload control in the current viewer;
backend upload endpoints are a separate capability.

## Deployment

Serve `viewer/` as static files behind HTTPS and authentication. The frontend
uses `/api`; strip that prefix before forwarding to logseqd.

Example Caddy site (replace the domain, path, username, and hash):

```caddyfile
edit.example.com {
    basic_auth {
        your-user REPLACE_WITH_A_CADDY_PASSWORD_HASH
    }
    handle_path /api/* {
        reverse_proxy 127.0.0.1:8471
    }
    handle {
        root * /absolute/path/to/hermes-logseq/viewer
        file_server
    }
}
```

Generate the hash with `caddy hash-password`. Protect the API as well as the
static frontend. Caddy's `handle_path` removes `/api`; a plain path-matched
`reverse_proxy` does not.

For Nginx, use a trailing slash in the upstream URL:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8471/;
}
```

Configure the private site's TLS, authentication, and static serving separately.

The current backend runs with Clojure CLI from the `logseqd/` directory:

```sh
clojure -M:run /absolute/path/to/graph 8471
```

The repository has no current Babashka launcher. The Linux watcher in
`scripts/inotify-watcher.sh` handles direct file edits; API writes reindex their
own files. Native macOS watching needs a separate implementation.

## Customization and updates

- Site title and footer link: `viewer/index.html`
- Theme: CSS variables in `viewer/style.css`
- Fonts: Inter and JetBrains Mono, loaded from Google Fonts
- API prefix: the `API` constant in `viewer/app.js`
- Installed-app name, icons, shortcuts, and sharing: `viewer/manifest.json`

For a frontend update, keep the HTML asset query versions and service-worker
cache version in sync. Deploy the files together. Existing drafts stay in the
browser; saving sends them to the server.

The normal landing page is the journal timeline. Compose actions and manual
navigation refresh the relevant content; do not describe the web viewer as a
live subscription to all graph changes.

## Public reader and Desktop

The private editor is separate from `reader/`. The public reader talks to
`gate/gate.mjs`, whose allowlist uses `public:: true` or `visibility:: public`.
`position:: N` controls ordering, not access. Do not expose the raw logseqd API
as the public reader's backend. The gate still contains maintainer-specific
filesystem paths that need adaptation for another graph.

For the native Notes workspace and companion pane, use the
[Hermes Desktop guide](https://github.com/mxjxn/hermes-logseq/blob/main/docs/hermes-desktop.md).
It has its own backend/frontend enablement and supported features.
