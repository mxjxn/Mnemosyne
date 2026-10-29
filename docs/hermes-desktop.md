# Notes in Hermes Desktop

The plugin connects Hermes Desktop to the same server graph used by the web app,
Telegram, and scheduled jobs. The server remains the main copy. GitHub sync stays
with your existing deployment; the plugin does not start another sync worker.

## What this version includes

- A **Notes** workspace in the sidebar and a companion **Notes** pane beside chat.
- Today's journal, a page picker, page search, and new pages created by their first entry.
- A journal composer that expands without losing its draft.
- **Edit**, **New block**, and **New sub-block** actions, including nested blocks.
- **Discuss with Hermes**: a block action opens a fresh chat with that saved reference as a composer chip. The composer is ready for your message; nothing is sent automatically.
- Saved `@mnemosyne:` block references, resolved by the gateway when a message is sent.
- Agent suggestions with original/suggested text and **Apply edit** / **Reject**, both in Notes and in supported chat transcripts.
- Shared drafts between the workspace and pane, separated by gateway, profile, graph, and page.
- A refresh after Hermes completes a message, plus a manual refresh button.

The native interface renders text, basic emphasis, code spans, HTTP(S) Markdown
links, and clickable `[[page references]]`. The existing web app remains available
for graph visualization, templates, and structured Event/Ask forms. This first
version does not add a local graph, file sync, offline note browsing, automatic
response publishing, or suggestions that create/reorder entire block trees. Edit suggestions currently replace one referenced block at a time.

## How it connects

```text
Hermes Desktop plugin
    → selected gateway's authenticated plugin routes
        → logseqd on that server
            → existing Markdown graph and GitHub sync
```

The Desktop half uses Hermes's connection credentials through the SDK. It does
not receive or store the VPS token. The gateway half forwards a fixed set of
note operations to `LOGSEQD_URL` (default `http://127.0.0.1:8471`). Keep logseqd
behind the gateway; the Desktop plugin does not need a public logseqd endpoint.

## Install the server half

First deploy this repository revision **including the pinned logseqd submodule**:

```sh
git submodule update --init --recursive
```

Restart your existing logseqd service. Startup reindexes the graph with the source
positions needed for reliable block editing. The plugin refuses block edits
against older logseqd versions; journal/page append still works.

Install the package into the Hermes profile that owns the graph. After this
change is merged to `main`, the standard installation is:

```sh
hermes plugins install mxjxn/Mnemosyne --no-enable
hermes plugins enable hermes-logseq
hermes gateway restart
```

For a named profile, use `hermes -p PROFILE ...` for each Hermes command.
Restart only when that gateway is ready to stop its current work.

For development from an existing checkout, link that checkout instead of cloning
another package. Replace the path before running:

```sh
mkdir -p ~/.hermes/plugins
ln -s /absolute/path/to/hermes-logseq ~/.hermes/plugins/hermes-logseq
hermes plugins doctor hermes-logseq --ci
hermes plugins enable hermes-logseq
hermes gateway restart
```

These paths assume the default Hermes home. Use the corresponding profile/home
plugin directory if yours differs. If logseqd uses another address, set
`LOGSEQD_URL` in that gateway's environment and restart the gateway.

## Install the Desktop half on your computer

The server installation cannot place files on your Mac. You need the Desktop
half locally too, even when all notes and agent work run on the VPS.

Use a current Hermes Desktop build that exposes gateway activation scopes,
focused session owners, and the composer draft API. The gateway must support
`PluginContext.register_context_reference` and the `ContextReferenceProvider` API
(`agent.context_references`). The plugin registers the `mnemosyne` prefix and
the `mnemosyne_propose_edit` tool; it needs the gateway’s FastAPI/Pydantic runtime.
Inline review cards additionally require `TRANSCRIPT_DIRECTIVE_AREA`; Notes
remains the review surface when that Desktop extension is unavailable. Older builds show an update
message rather than trying an unsafe fallback.

In **Capabilities → Plugins → Install from Git**, install
`mxjxn/Mnemosyne` with the **Desktop** component selected, then enable
**Logseq Notes**. Alternatively, from a checkout containing this revision:

```sh
mkdir -p ~/.hermes/desktop-plugins/hermes-logseq
cp desktop/plugin.js ~/.hermes/desktop-plugins/hermes-logseq/plugin.js
```

Enable **Logseq Notes** in **Capabilities → Plugins**. Saving the copied file
hot-reloads it; copying a newer version is how you update a manual installation.
No frontend build or npm install is required for the production plugin.

In **Settings → Gateways**, add/test your VPS's SSH or remote gateway connection.
Select the VPS and its graph-owning profile in Sessions. **Notes** now uses that
backend. Enabling the frontend plugin and enabling the server package are
separate switches; both need to be on.

## Daily use

Open **Notes** for the full workspace, or use the companion pane beside a chat.
The workspace and companion share their selected page and drafts. Use Hermes's
layout tabs to switch between views. In current Hermes Desktop builds, closing
a plugin's only contributed pane disables that plugin, including its workspace
navigation. Re-enable **Logseq Notes** in **Capabilities → Plugins** to restore
it; your saved drafts remain available.

Write in the journal composer and choose **Save block**, or press Cmd/Ctrl+Enter.
Enter inserts a newline. Expand/Reduce/Done change the writing area without
replacing the draft. Drafts are local to this computer; saving writes to the VPS.

For a new page, open **Pages**, enter its title, choose **New page**, and write
its first block. To add to an older journal, choose **New block** on an existing
entry; appending through logseqd's journal endpoint targets today's journal.

To discuss a block, hover over it and choose **Discuss with Hermes**. Its actions stay out of the way until hover or keyboard focus. Hermes opens a fresh chat with the saved `@mnemosyne:…` reference as a composer chip; the chip resolves to the selected block snapshot when you send your own message. The composer is focused and waits for you—nothing is sent automatically.

Ask Hermes to improve the referenced block. The provided `mnemosyne_propose_edit`
tool stores a suggestion without modifying the graph. Hermes returns a
`::mnemosyne-edit{id="…"}` directive on its own line, which supported Desktop
builds render as a review card. The same suggestion appears below the note in
**Notes** after the message completes; use **Refresh notes** if needed.
Review **Original** and **Suggested**, then choose **Apply edit** or **Reject**.
Apply updates that block and refreshes Notes. To revise the suggestion, discuss
it further and ask for another proposal; reject the superseded one.

Apply checks the original page revision and block content again. If the note
changed, refresh and attach a fresh reference before asking for a new suggestion.
An interrupted Apply is marked **Write unconfirmed** and cannot be applied again;
check the actual note before continuing. The tool provides this review workflow;
it does not remove the agent’s other existing file or shell capabilities.

References and proposals are stored on the gateway in the active Hermes profile’s
`plugin-data/hermes-logseq/notes.sqlite3`, separate from the Markdown graph. Back
up this file if you want discussion references and review history to survive a
profile rebuild. The selected gateway/profile and configured `LOGSEQD_URL` scope
the records. Copying only the graph does not copy these saved references.

## Updating an existing installation

Update the server package checkout to this revision, including submodules, and
restart the Hermes gateway for the graph-owning profile. Keep its existing
`LOGSEQD_URL` and logseqd service configuration. In a linked checkout, that means
pulling `main` and running `git submodule update --init --recursive` before the
restart. Verify registration with `hermes plugins doctor hermes-logseq --ci`.
The package should report version **0.2.0** and one registered tool.

Update the Desktop component as well. For a manual installation, copy the new
`desktop/plugin.js` to the existing Desktop plugin directory shown above; Desktop
hot-reloads that file. An older server package cannot resolve the new references.
Verify by attaching a block and asking Hermes for a suggested edit. The note
should stay unchanged until you choose **Apply edit**.

## When notes change elsewhere

A block edit carries the page revision and its full tree position. If Telegram,
a scheduled job, or another editor changes the note, the plugin keeps your draft
and refuses to overwrite it. Refresh the note. If the original block still has
a unique match, choose **Use matching block in refreshed note** after reviewing
it, then save. If the original changed or is ambiguous, copy the draft before
cancelling and choosing a fresh target.

The bundled logseqd locates writes by indexed source spans, so repeated text,
sibling-local order numbers, multiline content, and code-fence bullets cannot
silently redirect an edit. It also refuses writes when the source file changed
since indexing. These are optimistic checks, not a distributed transaction:
external tools can still race a write between validation and the file update.

The UI never automatically retries writes. If a connection drops during a save,
refresh and check whether it arrived before retrying. A successful write followed
by a failed refresh is reported as **Saved**, not offered as another submission.

## Verification

See [the test guide](../tests/README.md). The package includes API tests, a React
browser harness for the Desktop SDK contract, real-logseqd integration tests,
and the dependency's Clojure regression tests.

A browser harness cannot verify every native layout/connection detail. The final
acceptance step is to load the plugin in your installed Desktop build, select
your VPS, and try journal capture, a nested block edit, a reference-based discussion, and applying/rejecting a suggestion.
