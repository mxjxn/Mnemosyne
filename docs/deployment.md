# Run the web stack

This guide describes the current files and entry points. It is a manual setup
reference, not a claim that installation has been validated on a fresh machine.
The maintainer's working deployment includes additional service and Git-sync
configuration. The root `setup.sh` still targets an older layout; do not rely on
it as a current one-command installer.

## Components and prerequisites

| Component | Requirements |
|---|---|
| Graph API | Java/JVM and [Clojure CLI](https://clojure.org/guides/install_clojure) |
| Private editor | Static file server; reverse proxy to logseqd |
| Public reader | Static file server; Node.js for `gate/gate.mjs` |
| Automatic reindexing after external edits | Linux `inotify-tools`, Bash, and curl |
| Persistent services | Your process manager or service manager; PM2 is optional |

[Caddy](https://caddyserver.com/docs/) examples below keep frontend requests on
their own origin. Replace domains and absolute paths before using them. Protect
the private editor and its API together with HTTPS and authentication. The raw
logseqd API does not include the private editor's authentication layer.

## Start logseqd

Clone with submodules, or initialize them in your existing checkout:

```sh
git submodule update --init --recursive
```

Prepare a graph with `pages/` and `journals/`. From `logseqd/`, run:

```sh
clojure -M:run /absolute/path/to/your-graph 8471
```

This uses `logseqd/deps.edn` and starts `logseq-datalog.core`. Check it on the
server:

```sh
curl --fail http://127.0.0.1:8471/health
```

Run it as a persistent service for normal use. Keep the raw API on a trusted
network or behind access controls; exposing the public reader does not require
exposing logseqd itself. The checked-in Jetty launcher specifies a port, not an
explicit loopback bind, so apply host/network controls rather than assuming the
server listens only on localhost.

## Private editor

Serve the contents of `viewer/`. The frontend sends API requests to `/api/*`;
logseqd expects the same paths **without** `/api`.

Example Caddy site:

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

Generate the password hash with `caddy hash-password`. The authentication block
covers both the static editor and API. Caddy's
[`handle_path`](https://caddyserver.com/docs/caddyfile/directives/handle_path)
strips `/api`; a plain `reverse_proxy /api/* ...` preserves it and does not match
the current API routes. See Caddy's
[`basic_auth`](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
reference for password-hash syntax.

For Nginx, the corresponding API location is:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8471/;
}
```

The trailing slash matters: it replaces the matched `/api/` prefix. Configure
TLS, static serving, and authentication for the entire private site separately.
See the [Nginx proxy_pass reference](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).

The viewer supports an installable PWA, capture shortcuts, local drafts, and an
offline capture queue. A first visit and uncached pages still need the server.

## Reindex external edits

Writes through logseqd reindex the affected file. If an agent or another tool
writes Markdown directly, use the Linux watcher from the repository root:

```sh
GRAPH_DIR=/absolute/path/to/your-graph LOGSEQD_PORT=8471 bash scripts/inotify-watcher.sh
```

It requires `inotifywait` from `inotify-tools`. There is no native macOS watcher
in this repository. For local experimentation, reindex after external changes:

```sh
curl --fail -X POST http://127.0.0.1:8471/reindex
```

## Public reader

Serve `reader/` on a separate public site and route its API through the public
gate. The gate is a Node.js service with no npm dependencies:

```sh
LOGSEQD_URL=http://127.0.0.1:8471 node gate/gate.mjs
```

It defaults to `127.0.0.1:8473`. `LOGSEQD_URL`, `HOST`, and `PORT` are configurable.

**Personal configuration remains in the gate.** Before deploying someone else's
graph, replace both `/root/mxjxn-logseq-notes/pages/` paths in `gate/gate.mjs` with
your graph's `pages/` path. Those reads provide timestamps and curation fields;
they are separate from the upstream API URL. The public reader's title and
site-specific text also live in `reader/index.html` and `reader/reader.js`.

Example public Caddy site:

```caddyfile
notes.example.com {
    handle_path /api/* {
        reverse_proxy 127.0.0.1:8473
    }

    handle {
        root * /absolute/path/to/hermes-logseq/reader
        try_files {path} /index.html
        file_server
    }
}
```

Here `/api/public/pages` becomes `/public/pages` at the gate. Public requests
must go to **8473, the gate**, rather than directly to logseqd. The fallback to
`index.html` lets reader links such as `/p/Page%20Title` open directly.

A page opts in with `public:: true` or `visibility:: public`. All its blocks
are returned by the gate. `position:: 1` places an already-public evergreen
page in the curated section; it does not grant or remove public access.
`private:: true` is not a deny override for this gate's allowlist.

To withdraw a page, remove both public properties if present and reindex the
file. The pinned backend retracts removed page properties during reindexing.
Allow up to 15 seconds for the gate's cached allowlist, or refresh that cache
explicitly through `/public/pages?invalidate=1` on the gate.

Check the gate directly on the server using a real withdrawn page title:

```sh
curl --fail 'http://127.0.0.1:8473/public/pages?invalidate=1'
curl -i 'http://127.0.0.1:8473/public/page/Previously%20Public%20Page'
```

The first response should omit that page; the second should return 404. This
withdraws it from future API responses; it cannot retract copies someone has
already read or saved. The reader exposes external HTTPS images, not local
files from the graph's asset directory.

## Git history and synchronization

`logseqd` indexes and edits files; it is not a Git-sync service. The maintainer's
deployment has separate automation for commits and pushes.

`scripts/git-watcher.sh` fetches/pulls changes from a graph's configured remote.
It does not automatically commit and push local edits. Its conflict handling
prefers remote content in some cases, so it is not a general solution for
concurrent editing from several machines.

## Agent skills and Desktop

The files under `skills/` describe graph conventions and example workflows.
For example, the publishing helper lives at
`skills/hermes-logseq/scripts/logseq-publish.py`; the legacy installer attempts
to copy it from a different path. Install or copy the skill directories through
your current Hermes skill workflow and adapt their graph paths.

For the native Notes workspace and companion pane, use the separate
[Hermes Desktop installation guide](hermes-desktop.md). Its backend and Desktop
half have separate enablement switches and use the selected gateway's graph.

## Updating and checking changes

After pulling this repository, update the pinned dependency:

```sh
git submodule update --init --recursive
```

Restart logseqd after a backend update; startup reindexes existing blocks.
Deploy updated frontend files together with their current asset version and
service-worker cache version. The API and Desktop checks are documented in the
[test guide](../tests/README.md).
