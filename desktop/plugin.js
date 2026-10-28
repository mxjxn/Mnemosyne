import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as sdk from '@hermes/plugin-sdk';

const { host } = sdk;
const h = React.createElement;
const ID = 'hermes-logseq';
const ROUTE = '/logseq-notes';

function routeScope() {
  return {
    connection: host.activeConnectionId?.() || 'local',
    profile: host.state.profile.get() || 'default',
    epoch: sdk.gatewayActivationEpoch?.() ?? 0,
  };
}
function scopeKey(scope) { return JSON.stringify(scope); }
function current(scope) { return scopeKey(routeScope()) === scopeKey(scope); }
function message(error) { return error?.message || String(error || 'Something went wrong.'); }
function prettyTitle(title) {
  if (!/^\d{4}_\d{2}_\d{2}$/.test(title)) return title;
  const [y, m, d] = title.split('_').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

// Both the workspace and companion pane read the same graph-scoped state.
// A gateway switch remounts the view; persisted drafts use stable connection,
// profile and graph identities, never a transient session or activation epoch.
function createModel(ctx) {
  const values = new Map();
  const listeners = new Set();
  return {
    get(key, fallback) {
      if (!values.has(key)) values.set(key, ctx.storage.get(key, fallback));
      return values.get(key);
    },
    set(key, value) {
      values.set(key, value);
      ctx.storage.set(key, value);
      listeners.forEach(listener => listener());
    },
    transient(key, value) { values.set(key, value); listeners.forEach(listener => listener()); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
function useStored(model, key, fallback) {
  const value = useSyncExternalStore(model.subscribe, () => model.get(key, fallback));
  return [value, next => model.set(key, next)];
}

// React text nodes keep graph content inert. Page references are deliberate
// navigation actions; external Markdown links accept only HTTP(S).
function noteText(text, openPage) {
  return String(text || '').split(/(\[\[[^\]]+\]\]|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g).map((part, i) => {
    if (part.startsWith('[[') && part.endsWith(']]')) {
      const [title, label] = part.slice(2, -2).split('|');
      return h('button', { key: i, className: 'ln-ref', onClick: () => openPage(title.trim()) }, label || title);
    }
    if (part.startsWith('**') && part.endsWith('**')) return h('strong', { key: i }, part.slice(2, -2));
    if (part.startsWith('`') && part.endsWith('`')) return h('code', { key: i }, part.slice(1, -1));
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (link) return h('a', { key: i, href: link[2], target: '_blank', rel: 'noopener noreferrer' }, link[1]);
    return part;
  });
}

function InlineEditor({ editor, setEditor, busy, save, error, changed, canRebase, rebase }) {
  return h('form', { className: 'ln-inline', onSubmit: e => { e.preventDefault(); save(); } },
    h('label', null, editor.kind === 'update' ? 'Edit block' : editor.sub_block ? 'New sub-block' : 'New block',
      h('textarea', { 'aria-label': 'Block text', autoFocus: true, rows: 4, value: editor.text,
        disabled: busy, onChange: e => setEditor({ ...editor, text: e.target.value }),
        onKeyDown: e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); } } })),
    changed && h('p', { className: 'ln-error' }, 'This note has changed. Review the refreshed note before saving this draft.'),
    changed && canRebase && h('button', { type: 'button', disabled: busy, onClick: rebase }, 'Use matching block in refreshed note'),
    error && h('p', { className: 'ln-error', role: 'alert' }, error),
    h('div', { className: 'ln-actions' },
      h('button', { type: 'button', disabled: busy, onClick: () => setEditor(null) }, 'Cancel'),
      h('button', { className: 'ln-primary', type: 'submit', disabled: busy || !editor.text.trim() }, busy ? 'Saving…' : 'Save block')));
}

function BlockTree({ blocks, revision, editor, setEditor, busy, save, error, openPage, discuss, rebase, canRebase }) {
  const ids = new Set(blocks.map(block => block['block/id']));
  const children = new Map();
  const roots = [];
  blocks.forEach(block => {
    const parent = block['block/parent']?.['block/id'];
    if (parent && parent !== block['block/id'] && ids.has(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(block);
    } else roots.push(block);
  });
  const visited = new Set();
  function render(block) {
    const id = block['block/id'];
    if (visited.has(id)) return null;
    visited.add(id);
    const editing = editor && editor.block_path === block['block/path'];
    const begin = (kind, sub_block = false) => setEditor({ kind, sub_block,
      block_path: block['block/path'], expected_content: block['block/content'] || '',
      revision, block_level: block['block/level'] || 0, text: kind === 'update' ? block['block/content'] || '' : '' });
    return h('article', { className: 'ln-block', key: id },
      h('div', { className: 'ln-block-text' }, block['block/todo'] && h('strong', null, block['block/todo'] + ' '), noteText(block['block/content'], openPage)),
      Object.keys(block.properties || {}).length > 0 && h('div', { className: 'ln-props' },
        Object.entries(block.properties).map(([key, value]) => h('span', { key }, `${key}:: ${value}`))),
      h('div', { className: 'ln-block-actions' },
        h('button', { disabled: busy || !!editor, onClick: () => begin('insert') }, '+ New block'),
        h('button', { disabled: busy || !!editor || block['block/level'] >= 5, onClick: () => begin('insert', true) }, '↳ New sub-block'),
        h('button', { disabled: busy || !!editor, onClick: () => begin('update') }, 'Edit'),
        h('button', { disabled: busy, onClick: () => discuss(block) }, 'Discuss with Hermes')),
      editing && editor.kind === 'update' && h(InlineEditor, { editor, setEditor, busy, save, error, changed: editor.revision !== revision, canRebase, rebase }),
      h('div', { className: 'ln-children' }, (children.get(id) || []).map(render)),
      editing && editor.kind === 'insert' && h('div', { className: editor.sub_block ? 'ln-children' : '' },
        h(InlineEditor, { editor, setEditor, busy, save, error, changed: editor.revision !== revision, canRebase, rebase })));
  }
  const rendered = roots.map(render);
  // Malformed parent links must not make a block disappear or recurse forever.
  blocks.forEach(block => { if (!visited.has(block['block/id'])) rendered.push(render(block)); });
  return rendered;
}

function ProposalCard({ ctx, identity, initial, onReviewed, streaming = false }) {
  const [scope] = useState(routeScope);
  const [item, setItem] = useState(initial || null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    if (!initial && /^[0-9a-f]{32}$/.test(identity || '') && !streaming) {
      ctx.rest('/proposals/' + identity).then(result => {
        if (active.current && current(scope)) setItem(result);
      }).catch(cause => { if (active.current && current(scope)) setError(message(cause)); });
    }
    return () => { active.current = false; };
  }, [identity, streaming]);
  async function review(action) {
    if (busy || !current(scope)) { setError('Return to the gateway where this suggestion was opened, then refresh Notes.'); return; }
    setBusy(true);
    setError('');
    try {
      await ctx.rest('/proposals/' + identity + '/' + action, { method: 'POST', body: {} });
      if (!active.current || !current(scope)) return;
      const updated = await ctx.rest('/proposals/' + identity);
      if (!active.current || !current(scope)) return;
      setItem(updated);
      onReviewed?.();
    } catch (cause) {
      if (active.current && current(scope)) {
        setError(message(cause));
        // An ambiguous write is terminal on the server. Reload the status so
        // an unconfirmed result cannot continue offering an Apply button.
        try { const result = await ctx.rest('/proposals/' + identity); if (active.current && current(scope)) setItem(result); } catch {}
      }
    } finally { if (active.current) setBusy(false); }
  }
  if (!/^[0-9a-f]{32}$/.test(identity || '')) return null;
  return h('article', { className: 'ln-proposal' },
    h('style', null, STYLES),
    h('strong', null, item ? 'Suggested edit · ' + prettyTitle(item.page) : 'Suggested edit'),
    !item && !error && h('p', null, streaming ? 'Preparing suggestion…' : 'Loading suggestion…'),
    item && h(React.Fragment, null,
      item.reason && h('p', null, item.reason),
      h('small', null, 'Original'), h('pre', null, item.expected_content),
      h('small', null, 'Suggested'), h('pre', null, item.content),
      item.state === 'pending' ? h('div', { className: 'ln-actions' },
        h('button', { className: 'ln-primary', disabled: busy || streaming, onClick: () => review('apply') }, busy ? 'Working…' : 'Apply edit'),
        h('button', { disabled: busy || streaming, onClick: () => review('reject') }, 'Reject')) :
        h('p', { role: 'status' }, item.state === 'uncertain' || item.state === 'applying' ? 'Write unconfirmed. Refresh the note and check its content before requesting another suggestion.' : item.state === 'applied' ? 'Applied to your note' : 'Suggestion rejected')),
    error && h('p', { className: 'ln-error', role: 'alert' }, error));
}

function Notes({ ctx, model, scope, compact }) {
  const [info, setInfo] = useState(null);
  const [connectionName, setConnectionName] = useState(scope.connection === 'local' ? 'This device' : 'Selected gateway');
  const [pages, setPages] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [page, setPage] = useState(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [browse, setBrowse] = useState(!compact);
  const [newTitle, setNewTitle] = useState('');
  const [error, setError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [status, setStatus] = useState('Connecting to your graph…');
  const [size, setSize] = useState('compact');
  const [retry, setRetry] = useState(0);
  const pendingReads = useRef(0);
  const scrollRef = useRef(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const live = () => alive.current && current(scope);
  const graph = JSON.stringify([scope.connection, scope.profile, info?.graph_id || 'pending']);
  const [busy] = useStored(model, graph + ':busy', false);
  const [selected, setSelected] = useStored(model, graph + ':selected', '');
  const title = selected || info?.today || '';
  const [draft, setDraft] = useStored(model, graph + ':draft:' + title, '');
  const [editor, setEditor] = useStored(model, graph + ':editor:' + title, null);
  const [version] = useStored(model, graph + ':refresh', 0);
  const [turn] = useStored(model, 'turn:' + JSON.stringify([scope.connection, scope.profile]), 0);
  const [discussion, setDiscussion] = useStored(model, graph + ':discussion', null);

  useEffect(() => {
    let cancelled = false;
    host.connections?.().then(connections => {
      const connection = connections.find(item => item.id === scope.connection);
      if (!cancelled && live() && connection?.name) setConnectionName(connection.name);
    }).catch(() => {});
    setError('');
    (async () => {
      try {
        if (!current(scope)) return;
        const [health, list] = await Promise.all([ctx.rest('/status'), ctx.rest('/pages')]);
        if (cancelled || !live()) return;
        setInfo(health);
        setPages(list.pages || []);
        setStatus('Connected · ' + scope.profile);
      } catch (cause) {
        if (!cancelled && live()) setError(message(cause));
      }
    })();
    return () => { cancelled = true; };
  }, [retry]);

  useEffect(() => {
    if (!info || !title) return;
    const read = ++pendingReads.current;
    setError('');
    setWriteError('');
    (async () => {
      try {
        if (!current(scope)) return;
        const result = await ctx.rest('/page?title=' + encodeURIComponent(title));
        if (!live() || read !== pendingReads.current) return;
        setPage(result);
      } catch (cause) {
        if (live() && read === pendingReads.current) setError(message(cause));
      }
    })();
    return () => { pendingReads.current++; };
  }, [info, title, version, retry, turn]);

  useEffect(() => {
    let cancelled = false;
    setProposals([]);
    if (info && title && current(scope)) ctx.rest('/proposals?page=' + encodeURIComponent(title)).then(result => {
      if (!cancelled && live()) setProposals(result.proposals || []);
    }).catch(cause => { if (!cancelled && live()) setError('Could not load edit suggestions: ' + message(cause)); });
    return () => { cancelled = true; };
  }, [info, title, version, retry, turn]);

  useEffect(() => {
    if (!query.trim() || !info) { setMatches([]); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (!current(scope)) return;
      try {
        const result = await ctx.rest('/search?q=' + encodeURIComponent(query.trim()));
        if (!cancelled && live()) setMatches(result.results || []);
      } catch { if (!cancelled && live()) setMatches([]); }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, info]);

  function openPage(next) {
    if (model.get(graph + ':busy', false)) return;
    setSelected(next);
    setPage(null);
    setWriteError('');
    setSize('compact');
    if (compact) setBrowse(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }

  async function save(kind) {
    if (model.get(graph + ':busy', false) || !info || !current(scope)) return;
    const text = kind === 'append' ? draft : editor?.text;
    if (!text?.trim()) return;
    model.transient(graph + ':busy', true);
    setWriteError('');
    const key = graph + (kind === 'append' ? ':draft:' : ':editor:') + title;
    try {
      const endpoint = kind === 'append' ? '/append' : '/blocks/' + editor.kind;
      const body = kind === 'append' ? { page: title, content: text } : {
        page: title, content: text, revision: editor.revision, block_path: editor.block_path,
        expected_content: editor.expected_content, sub_block: !!editor.sub_block,
      };
      const result = await ctx.rest(endpoint, { method: 'POST', body });
      if (!result.saved) throw new Error('The save could not be confirmed. Refresh before retrying.');
      // Clear only the originating graph's draft, even if the user switched gateways.
      model.set(key, kind === 'append' ? '' : null);
      model.set(graph + ':refresh', model.get(graph + ':refresh', 0) + 1);
      if (!live()) return;
      if (result.page) setPage(result.page);
      setStatus(result.refresh_required ? 'Saved · refresh to load the latest note' : 'Saved to ' + prettyTitle(title));
      // Refresh the picker after a first entry creates a new page.
      ctx.rest('/pages').then(result => { if (live()) setPages(result.pages || []); }).catch(() => {});
    } catch (cause) {
      if (live()) setWriteError(message(cause));
    } finally {
      model.transient(graph + ':busy', false);
    }
  }

  async function discuss(block) {
    if (!current(scope)) return;
    try {
      const reference = await ctx.rest('/references', { method: 'POST', body: {
        page: title, revision: page.revision, block_path: block['block/path'], expected_content: block['block/content'] || '',
      } });
      if (!live()) return;
      setDiscussion({ page: title, reference: reference.id, preview: reference.expected_content });
      setStatus('Note reference ready · add it to a chat draft below');
    } catch (cause) { if (live()) setStatus(message(cause)); }
  }

  async function attachDiscussion() {
    if (!discussion || !current(scope)) return;
    try {
      const owner = host.state.focusedSessionOwner?.get();
      const connection = host.activeConnectionId?.() || 'local';
      if (!owner || owner.profile !== scope.profile || (owner.connectionId || 'local') !== connection) {
        throw new Error('Open a chat on this gateway and profile before attaching the block.');
      }
      const session = host.state.focusedSessionId.get() || 'new';
      if (!/^[0-9a-f]{32}$/.test(discussion.reference || '')) throw new Error('Attach this block again to create a note reference.');
      const text = `Discuss this note with me. @mnemosyne:${discussion.reference}`;
      const attached = await host.composer.insertText(session, text, { mode: 'block' });
      if (!live()) return;
      if (!attached) throw new Error('Open a chat beside Notes, then choose Add to chat draft again.');
      setDiscussion(null);
      setStatus('Added to the chat draft · review it before sending');
    } catch (cause) { if (live()) setStatus(message(cause)); }
  }

  const visiblePage = page?.title === title ? page : null;
  const canAppend = title && (!/^\d{4}_\d{2}_\d{2}$/.test(title) || title === info?.today);
  const allTitles = [...new Set(pages.map(p => p['page/title'] || p.title).filter(Boolean))].sort((a, b) => b.localeCompare(a));
  const found = new Set(matches.map(match => match.page));
  const filtered = allTitles.filter(name => name.toLowerCase().includes(query.toLowerCase()) || found.has(name));
  const renderEditor = props => h(InlineEditor, { ...props, busy, error: writeError, save: () => save('block') });
  const matchingBlocks = editor && visiblePage ? visiblePage.blocks.filter(block => block['block/content'] === editor.expected_content && (block['block/level'] || 0) === editor.block_level) : [];
  const rebase = () => {
    if (matchingBlocks.length === 1) {
      setEditor({ ...editor, revision: visiblePage.revision, block_path: matchingBlocks[0]['block/path'] });
      setWriteError('');
    }
  };
  const orphanEditor = editor && visiblePage && !visiblePage.blocks.some(block => block['block/path'] === editor.block_path);

  return h('section', { className: 'logseq-notes' + (compact ? ' ln-compact' : '') + (size === 'full' ? ' ln-writing' : '') },
    h('style', null, STYLES),
    h('header', { className: 'ln-header' },
      h('div', null, h('strong', null, 'Notes'), h('small', null, scope.profile + ' · ' + connectionName)),
      h('div', { className: 'ln-actions' },
        h('button', { onClick: () => openPage(info?.today || ''), disabled: !info || busy }, 'Today'),
        h('button', { onClick: () => setBrowse(!browse), 'aria-expanded': browse }, 'Pages'),
        h('button', { disabled: busy, onClick: () => setRetry(retry + 1), 'aria-label': 'Refresh notes' }, '↻'))),
    error && h('div', { className: 'ln-alert', role: 'alert' }, h('p', null, error),
      !info && h('p', null, 'Enable the hermes-logseq backend on the selected gateway. It connects to logseqd on that server.'),
      h('button', { onClick: () => setRetry(retry + 1) }, 'Try again')),
    h('div', { className: 'ln-layout' },
      browse && h('nav', { className: 'ln-browser', 'aria-label': 'Notes pages' },
        h('input', { 'aria-label': 'Find a page', placeholder: 'Find a page…', value: query, onChange: e => setQuery(e.target.value) }),
        h('form', { className: 'ln-new-page', onSubmit: e => { e.preventDefault(); if (newTitle.trim()) { openPage(newTitle.trim()); setNewTitle(''); } } },
          h('input', { 'aria-label': 'New page title', placeholder: 'New page title…', maxLength: 512, value: newTitle, onChange: e => setNewTitle(e.target.value) }),
          h('button', { disabled: !newTitle.trim() || busy }, '+ New page')),
        h('div', { className: 'ln-page-list' }, filtered.map(name => h('button', { key: name, disabled: busy,
          className: name === title ? 'ln-page-active' : '', onClick: () => openPage(name) }, prettyTitle(name)))),
        query && h('small', null, 'Content search covers pages. Open journals by date.')),
      h('div', { className: 'ln-document' },
        h('div', { className: 'ln-scroll', ref: scrollRef },
          title && h('h2', null, title === info?.today ? 'Today’s journal' : prettyTitle(title)),
          title === info?.today && h('p', { className: 'ln-date' }, prettyTitle(title)),
          !info && !error && h('p', null, 'Connecting to your graph…'),
          info && !visiblePage && !error && h('p', null, 'Loading note…'),
          visiblePage && visiblePage.blocks.length === 0 && h('p', { className: 'ln-empty' }, 'A fresh page. Start writing below.'),
          visiblePage && h(BlockTree, { blocks: visiblePage.blocks, revision: visiblePage.revision,
            editor, setEditor: next => { setWriteError(''); setEditor(next); }, busy,
            save: () => save('block'), error: writeError, openPage, discuss, rebase, canRebase: matchingBlocks.length === 1 }),
          proposals.map(item => h(ProposalCard, { key: item.id + ':' + item.state, ctx, identity: item.id, initial: item, onReviewed: () => model.set(graph + ':refresh', model.get(graph + ':refresh', 0) + 1) })),
          orphanEditor && renderEditor({ editor, setEditor, rebase, changed: editor.revision !== visiblePage.revision, canRebase: matchingBlocks.length === 1 })),
        discussion && h('aside', { className: 'ln-discussion' },
          h('strong', null, 'Discuss: ' + discussion.page),
          h('p', null, 'Adds a note reference to your draft. Hermes reads the saved block when you send it.'),
          h('blockquote', null, discussion.preview),
          h('div', { className: 'ln-actions' },
            h('button', { className: 'ln-primary', onClick: attachDiscussion }, 'Add to chat draft'),
            h('button', { onClick: () => { if (current(scope)) host.newChat(scope.profile); } }, 'Open new chat'),
            h('button', { onClick: () => setDiscussion(null) }, 'Dismiss'))),
        canAppend && info && h('form', { className: 'ln-composer ln-size-' + size, onSubmit: e => { e.preventDefault(); save('append'); } },
          h('div', { className: 'ln-composer-heading' },
            h('label', { htmlFor: 'ln-entry-' + (compact ? 'pane' : 'page') }, title === info.today ? 'Write in today’s journal' : 'New block on this page'),
            h('div', { className: 'ln-actions' },
              size !== 'compact' && h('button', { type: 'button', onClick: () => setSize('compact') }, 'Done'),
              h('button', { type: 'button', 'aria-label': size === 'full' ? 'Reduce writing area' : 'Expand writing area', onClick: () => setSize(size === 'full' ? 'writing' : 'full') }, size === 'full' ? 'Reduce' : 'Expand'))),
          h('textarea', { id: 'ln-entry-' + (compact ? 'pane' : 'page'), 'aria-label': 'Journal entry',
            placeholder: 'Write a thought…', value: draft, disabled: busy, rows: 3,
            onFocus: () => { if (size === 'compact') setSize('writing'); },
            onChange: e => setDraft(e.target.value),
            onKeyDown: e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save('append'); } } }),
          writeError && !editor && h('p', { className: 'ln-error', role: 'alert' }, writeError),
          h('div', { className: 'ln-composer-footer' }, h('small', null, 'Draft saved on this device'),
            h('button', { className: 'ln-primary', disabled: busy || !draft.trim() }, busy ? 'Saving…' : 'Save block'))),
        !canAppend && info && h('p', { className: 'ln-date' }, 'To add to this journal, choose New block on an existing entry.'))),
    h('footer', { className: 'ln-status', role: 'status', 'aria-live': 'polite' }, status));
}

function NotesRoot(props) {
  const [scope, setScope] = useState(routeScope);
  useEffect(() => {
    const refresh = () => { const next = routeScope(); setScope(previous => scopeKey(next) === scopeKey(previous) ? previous : next); };
    // This checks an in-memory SDK counter, not a network endpoint. It also
    // detects same-profile gateway switches that a profile subscription misses.
    const timer = setInterval(refresh, 250);
    const stop = host.state.profile.subscribe(refresh);
    return () => { clearInterval(timer); stop(); };
  }, []);
  if (!sdk.gatewayActivationEpoch || !host.activeConnectionId || !host.state.focusedSessionOwner) {
    return h('p', { style: { padding: 16 } }, 'Update Hermes Desktop to use Notes with gateway-aware drafts and discussion.');
  }
  return h(Notes, { ...props, scope, key: scopeKey(scope) });
}

export default {
  id: ID,
  name: 'Logseq Notes',
  defaultEnabled: false,
  register(ctx) {
    const model = createModel(ctx);
    const refreshViews = () => {
      const scope = routeScope();
      const key = 'turn:' + JSON.stringify([scope.connection, scope.profile]);
      model.transient(key, model.get(key, 0) + 1);
    };
    ctx.onEvent?.('message.complete', refreshViews);
    ctx.registerMany([
      ...(sdk.TRANSCRIPT_DIRECTIVE_AREA ? [{
        id: 'edit-review', area: sdk.TRANSCRIPT_DIRECTIVE_AREA,
        data: { name: 'mnemosyne-edit', render: ({ attrs, streaming }) =>
          h(ProposalCard, { key: attrs.id, ctx, identity: attrs.id, streaming, onReviewed: refreshViews }) },
      }] : []),
      { id: 'workspace', area: sdk.ROUTES_AREA, data: { path: ROUTE }, render: () => h(NotesRoot, { ctx, model, compact: false }) },
      { id: 'navigation', area: sdk.SIDEBAR_NAV_AREA, data: { path: ROUTE, label: 'Notes', codicon: 'notebook' } },
      { id: 'companion', area: 'panes', title: 'Notes', data: { placement: 'right', width: '420px' }, render: () => h(NotesRoot, { ctx, model, compact: true }) },
    ]);
  },
};

const STYLES = `
.ln-proposal { padding:16px; margin:16px 0; border:1px solid var(--ui-border, #8884); border-radius:10px; font:14px/1.5 system-ui,sans-serif; }
.ln-proposal pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; padding:10px; background:var(--ui-bg-input, #8881); max-height:280px; overflow:auto; }
.ln-proposal button { font:inherit; cursor:pointer; padding:6px 10px; border:1px solid var(--ui-border, #8884); border-radius:8px; color:inherit; background:var(--ui-bg-input, #8881); }
.ln-proposal button:disabled { opacity:.5; cursor:default; }
.logseq-notes { height:100%; min-height:0; display:flex; flex-direction:column; color:var(--ui-text-primary, #292932); background:var(--ui-bg, transparent); font:14px/1.55 system-ui,sans-serif; }
.logseq-notes * { box-sizing:border-box; }
.logseq-notes button, .logseq-notes input, .logseq-notes textarea { font:inherit; color:inherit; }
.logseq-notes button { cursor:pointer; background:transparent; border:1px solid var(--ui-border, #8884); border-radius:8px; padding:6px 10px; min-height:34px; }
.logseq-notes button:hover { background:var(--ui-bg-hover, #8881); }
.logseq-notes button:disabled { opacity:.5; cursor:default; }
.logseq-notes button:focus-visible, .logseq-notes textarea:focus-visible, .logseq-notes input:focus-visible { outline:2px solid var(--ui-accent, #7562ce); outline-offset:2px; }
.logseq-notes input, .logseq-notes textarea { border:1px solid var(--ui-border, #8884); border-radius:9px; padding:10px 12px; background:var(--ui-bg-input, #8881); width:100%; }
.logseq-notes textarea { resize:vertical; line-height:1.65; min-height:90px; }
.logseq-notes small, .ln-date, .ln-empty { color:var(--ui-text-secondary, #888); }
.ln-header { flex-shrink:0; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:14px 16px; border-bottom:1px solid var(--ui-border, #8883); }
.ln-header strong { font-size:18px; display:block; }
.ln-header small { font-size:11px; }
.ln-actions { display:flex; gap:6px; flex-wrap:wrap; }
.ln-layout { display:flex; flex:1; min-height:0; }
.ln-browser { display:flex; flex-direction:column; gap:12px; width:230px; flex-shrink:0; padding:16px; border-right:1px solid var(--ui-border, #8883); overflow:auto; }
.ln-new-page { display:grid; gap:6px; }
.ln-page-list { display:flex; flex-direction:column; gap:4px; }
.ln-page-list button { text-align:left; border-color:transparent; overflow-wrap:anywhere; }
.ln-page-list .ln-page-active { background:var(--ui-bg-hover, #8882); border-color:var(--ui-border, #8883); }
.ln-document { flex:1; display:flex; flex-direction:column; min-width:0; min-height:0; }
.ln-scroll { flex:1; overflow:auto; padding:20px 24px; overflow-anchor:none; }
.ln-scroll h2 { margin:0 0 4px; font-size:24px; letter-spacing:-.03em; }
.ln-date { margin:0 0 20px; font-size:12px; }
.ln-block { padding:12px 0; border-bottom:1px solid var(--ui-border, #8882); }
.ln-block-text { white-space:pre-wrap; overflow-wrap:anywhere; }
.ln-props { display:flex; flex-wrap:wrap; gap:8px; font-size:11px; color:var(--ui-text-secondary, #888); margin-top:6px; }
.ln-block-actions { display:flex; flex-wrap:wrap; gap:4px; margin-top:8px; }
.ln-block-actions button { font-size:11px; padding:3px 7px; min-height:28px; color:var(--ui-text-secondary, #888); }
.ln-children { padding-left:16px; margin-left:2px; border-left:1px solid var(--ui-border, #8883); }
.logseq-notes .ln-ref { color:var(--ui-accent, #7562ce); padding:0; border:0; min-height:0; display:inline; }
.ln-inline { margin:12px 0; border:1px solid var(--ui-accent, #7562ce); border-radius:10px; padding:12px; }
.ln-inline label { font-weight:600; }
.ln-inline textarea { margin:8px 0; font-weight:400; }
.ln-inline .ln-actions { justify-content:flex-end; }
.ln-composer { flex-shrink:0; padding:14px 20px; border-top:1px solid var(--ui-border, #8883); background:var(--ui-bg-panel, #8881); }
.ln-composer-heading, .ln-composer-footer { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px; }
.ln-composer-heading label { font-weight:600; }
.ln-composer-heading button { font-size:12px; }
.ln-composer-footer { margin:8px 0 0; }
.logseq-notes .ln-primary { background:var(--ui-accent, #7562ce); color:white; border-color:transparent; }
.ln-size-writing textarea { height:180px; max-height:35vh; }
.ln-writing .ln-scroll, .ln-writing .ln-browser, .ln-writing .ln-discussion { display:none; }
.ln-writing .ln-composer { flex:1; display:flex; flex-direction:column; min-height:0; }
.ln-writing .ln-composer textarea { flex:1; min-height:100px; resize:none; }
.ln-status { font-size:11px; padding:6px 16px; border-top:1px solid var(--ui-border, #8882); overflow-wrap:anywhere; }
.ln-alert, .ln-discussion { padding:12px 16px; background:var(--ui-bg-hover, #8881); border-bottom:1px solid var(--ui-border, #8883); }
.ln-alert p, .ln-discussion p { margin:0 0 8px; }
.ln-error { color:var(--ui-text-danger, #b44b4b); font-size:12px; }
.ln-compact .ln-layout { flex-direction:column; }
.ln-compact .ln-browser { width:100%; max-height:40%; border-right:0; border-bottom:1px solid var(--ui-border, #8883); }
.ln-compact .ln-scroll { padding:16px; }
.ln-compact .ln-scroll h2 { font-size:20px; }
.ln-compact .ln-composer { padding:12px; }
.ln-compact .ln-composer-heading { font-size:12px; }
@media (max-width:700px) { .ln-layout { flex-direction:column; } .ln-browser { width:100%; max-height:35%; border-right:0; } }
`;
