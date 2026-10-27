// Browser-only SDK contract harness. No credentials or Hermes state are used.
import React from 'react';

export const ROUTES_AREA = 'routes';
export const SIDEBAR_NAV_AREA = 'sidebar.nav';
const listeners = new Set();
const environment = { connection: 'vps-a', epoch: 0, mode: 'workspace', chat: '', mismatch: false };
let redraw = () => {};
export const gatewayActivationEpoch = () => environment.epoch;
export const host = {
  activeConnectionId: () => environment.connection,
  state: {
    profile: { get: () => 'default', subscribe: fn => { listeners.add(fn); fn(); return () => listeners.delete(fn); } },
    focusedSessionId: { get: () => 'session-' + environment.connection },
    focusedSessionOwner: { get: () => ({ connectionId: environment.mismatch ? 'wrong-gateway' : environment.connection, profile: 'default' }) },
  },
  composer: {
    async insertText(session, text) {
      if (environment.mode !== 'chat' || session !== 'session-' + environment.connection) return false;
      environment.chat += (environment.chat ? '\n\n' : '') + text;
      redraw();
      return true;
    },
  },
  newChat() { environment.mode = 'chat'; redraw(); },
};
export function mountHarness(plugin, createRoot) {
  const contributions = [];
  const data = new Map();
  const ctx = {
    storage: {
      get(key, fallback) { return data.has(key) ? data.get(key) : fallback; },
      set(key, value) { data.set(key, value); },
    },
    registerMany(items) { contributions.push(...items); },
    async rest(path, options = {}) {
      const connection = environment.connection;
      const response = await fetch('/api/' + connection + path, {
        method: options.method || 'GET', headers: { 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || 'Request failed');
      return body;
    },
  };
  plugin.register(ctx);
  const workspace = contributions.find(item => item.id === 'workspace');
  const pane = contributions.find(item => item.id === 'companion');
  window.harness = {
    switchGateway() { environment.connection = environment.connection === 'vps-a' ? 'vps-b' : 'vps-a'; environment.epoch++; redraw(); },
    mismatch(value) { environment.mismatch = value; },
    setChat(text) { environment.chat = text; redraw(); },
    data,
  };
  const root = createRoot(document.getElementById('root'));
  redraw = () => root.render(React.createElement(React.StrictMode, null,
    React.createElement('div', { style: { height: '100vh', display: 'flex', background: '#f8f8fb' } },
      React.createElement('main', { style: { flex: 1, minWidth: 0 }, 'data-testid': 'workspace' }, environment.mode === 'workspace' ? workspace.render() :
        React.createElement('div', { style: { padding: 24 } }, React.createElement('h2', null, 'Hermes conversation'),
          React.createElement('textarea', { 'aria-label': 'Hermes chat draft', value: environment.chat, onChange: e => { environment.chat = e.target.value; redraw(); } }))),
      React.createElement('aside', { style: { width: 420, borderLeft: '1px solid #ddd' }, 'data-testid': 'pane' }, pane.render()))));
  redraw();
}
