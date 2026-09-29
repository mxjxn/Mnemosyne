// ─── Config ─────────────────────────────────────────────────
const API = '/api'; // proxied to logseqd via reverse proxy (see README)

// ─── State ───────────────────────────────────────────────────
let currentPage = null;
let allPages = [];

// ─── API helpers ─────────────────────────────────────────────
// Format Date → value for <input type="datetime-local">
function toDatetimeLocal(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Format Date → value for <input type="date">
function toDateStr(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

async function api(path) {
  const resp = await fetch(API + path, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  return resp.json();
}

async function apiPost(path, body) {
  const resp = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/edn' },
    body: body,
  });
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  return resp.json();
}

// ─── Markdown-ish rendering ──────────────────────────────────
// Renders Logseq block content with [[page refs]], #tags, `code`, **bold**
function renderContent(text) {
  if (!text) return '';
  // Split on literal newlines so multi-line block content renders correctly.
  // Each line is rendered independently (preserving markdown in each line),
  // then joined with <br>.
  return text.split('\n').map(line => renderContentLine(line)).join('<br>');
}

function renderContentLine(text) {
  let html = escapeHtml(text);

  // Code blocks ```...``` (must come before inline code)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
    return `<pre class="code-block">${langLabel}<code>${code.trim()}</code></pre>`;
  });

  // Inline code `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Page references [[Page Name]]
  html = html.replace(/\[\[([^\]]+)\]\]/g, (m, name) =>
    `<a class="page-ref" data-page="${escapeAttr(name)}">${escapeHtml(name)}</a>`
  );

  // Markdown links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) =>
    `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
  );

  // Images ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) =>
    `<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}" loading="lazy">`
  );

  // Bold **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic *text* (not bold, not inside code)
  html = html.replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Strikethrough ~~text~~
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Headers (## Header → styled)
  html = html.replace(/^### (.+)/, '<strong style="font-size:1.05em;color:var(--text-muted)">$1</strong>');
  html = html.replace(/^## (.+)/, '<strong style="font-size:1.1em">$1</strong>');
  html = html.replace(/^# (.+)/, '<strong style="font-size:1.2em">$1</strong>');

  // Blockquotes (> text)
  html = html.replace(/^&gt;\s?(.+)/gm, '<span class="block-quote">$1</span>');

  // Horizontal rule (--- or ***)
  html = html.replace(/^---$|^(\*{3,})$/gm, '<hr>');

  // Tags #tagname — clickable, navigate to tag page
  html = html.replace(/(^|\s)#([\w/-]+)/g, (m, pre, tag) =>
    `${pre}<a class="inline-tag" data-tag="${escapeAttr(tag)}">#${escapeHtml(tag)}</a>`
  );

  return html;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g,'&quot;');
}

// ─── Block rendering ────────────────────────────────────────

// Component registry: property patterns → render functions
// Each renderer receives (block, children) and returns HTML string.
// Falls through to default text rendering if no match.
const COMPONENT_RENDERERS = {
  event: renderEventCard,
  ask: renderAskCard,
};

// ─── Block Type Schemas (input forms) ──────────────────────
// Mirrors COMPONENT_RENDERERS — defines structured input fields per type.
// When a type is selected in the write box, these fields appear.
const BLOCK_SCHEMAS = {
  note: {
    label: 'Note',
    icon: '📝',
    fields: [],
  },
  event: {
    label: 'Event',
    icon: '📅',
    fields: [
      { key: 'start', label: 'Start', type: 'date', required: true, timeOptional: true, default: 'today' },
      { key: 'end', label: 'End', type: 'date', timeOptional: true, default: 'today' },
      { key: 'location', label: 'Location', type: 'text', placeholder: 'Where?' },
      { key: 'status', label: 'Status', type: 'select', options: ['upcoming', 'tentative', 'confirmed', 'cancelled'], default: 'upcoming' },
    ],
  },
  ask: {
    label: 'Ask',
    icon: '❓',
    fields: [],
  },
};

function renderBlockComponent(block, children, allBlocks) {
  const props = block.properties || {};
  const type = props.type;

  // Check registry
  if (type && COMPONENT_RENDERERS[type]) {
    return COMPONENT_RENDERERS[type](block, children, allBlocks);
  }

  // Default: plain text rendering
  return null;
}

// ─── Event Card Component ───────────────────────────────────
function renderEventCard(block, children) {
  const props = block.properties || {};
  const title = block['block/content'] || '';
  const start = props.start || '';
  const end = props.end || '';
  const location = props.location || '';
  const status = props.status || '';

  // Parse dates
  const startDate = start ? new Date(start) : null;
  const endDate = end ? new Date(end) : null;
  const now = new Date();
  const isUpcoming = startDate && startDate > now;
  const isPast = endDate && endDate < now;

  // Status badge
  let badgeClass = 'event-badge-default';
  let badgeText = status || (isUpcoming ? 'upcoming' : isPast ? 'past' : 'scheduled');
  if (isUpcoming) badgeClass = 'event-badge-upcoming';
  if (isPast) badgeClass = 'event-badge-past';

  // Countdown
  let countdownHtml = '';
  if (isUpcoming) {
    const diff = startDate - now;
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    if (days > 0) {
      countdownHtml = `<span class="event-countdown">in ${days} day${days !== 1 ? 's' : ''}${hours > 0 ? `, ${hours}h` : ''}</span>`;
    } else if (hours > 0) {
      countdownHtml = `<span class="event-countdown">in ${hours} hour${hours !== 1 ? 's' : ''}</span>`;
    } else {
      countdownHtml = `<span class="event-countdown event-countdown-soon">starting soon</span>`;
    }
  }

  // Format date nicely — detect all-day (no time component in stored value)
  const dateFmt = { weekday: 'short', month: 'short', day: 'numeric' };
  const timeFmt = { hour: 'numeric', minute: '2-digit' };
  const hasStartTime = start && start.includes('T');
  const hasEndTime = end && end.includes('T');
  let dateLine = '';
  if (startDate) {
    dateLine = startDate.toLocaleDateString('en-US', dateFmt);
    if (hasStartTime) {
      dateLine += ' · ' + startDate.toLocaleTimeString('en-US', timeFmt);
      if (endDate && hasEndTime) {
        const endTime = endDate.toLocaleTimeString('en-US', timeFmt);
        dateLine += ` – ${endTime}`;
      }
    } else if (endDate && !hasEndTime && endDate.toDateString() !== startDate.toDateString()) {
      // Multi-day all-day event
      dateLine += ` – ${endDate.toLocaleDateString('en-US', dateFmt)}`;
    }
    if (!hasStartTime) {
      dateLine += ' · All day';
    }
  }

  // Render sub-tasks (child blocks) as checklist
  let tasksHtml = '';
  if (children && children.length > 0) {
    tasksHtml = '<div class="event-tasks">' +
      children.map(c => {
        const cTodo = c['block/todo'] || '';
        const cContent = escapeHtml(c['block/content'] || '');
        const checked = cTodo === 'DONE' || cTodo === 'DOING';
        return `<label class="event-task ${checked ? 'event-task-done' : ''}">
          <input type="checkbox" ${checked ? 'checked' : ''} disabled>
          <span>${cContent}</span>
        </label>`;
      }).join('') +
    '</div>';
  }

  return `
    <div class="component component-event ${isPast ? 'event-past' : ''}">
      <div class="event-header">
        <div class="event-title">${escapeHtml(title)}</div>
        <span class="event-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
      </div>
      <div class="event-body">
        ${dateLine ? `<div class="event-date">📅 ${escapeHtml(dateLine)}</div>` : ''}
        ${countdownHtml}
        ${location ? `<div class="event-location">📍 ${escapeHtml(location)}</div>` : ''}
      </div>
      ${tasksHtml}
    </div>
  `;
}

// ─── Ask Card Component ─────────────────────────────────────
function renderAskCard(block, children, allBlocks) {
  const props = block.properties || {};
  const question = block['block/content'] || '';
  const askId = props['ask-id'] || '';

  // Search all blocks on page for an answer matching this ask's ask-id
  let answerHtml = '';
  let answered = false;
  if (allBlocks && askId) {
    const answer = allBlocks.find(b => {
      const bp = b.properties || {};
      return bp.type === 'answer' && bp['reply-to'] === askId;
    });
    if (answer) {
      answered = true;
      const answerText = answer['block/content'] || '';
      answerHtml = `<div class="ask-answer"><span class="ask-answer-icon">↳</span> ${renderContent(answerText)}</div>`;
    }
  }

  const badgeClass = answered ? 'ask-badge-answered' : 'ask-badge-pending';
  const badgeText = answered ? 'answered' : 'pending';

  return `
    <div class="component component-ask ${answered ? 'ask-answered' : ''}">
      <div class="ask-header">
        <div class="ask-question">${escapeHtml(question)}</div>
        <span class="ask-badge ${badgeClass}">${badgeText}</span>
      </div>
      ${answerHtml}
    </div>
  `;
}

function renderBlocks(blocks, overridePageTitle) {
  const pageTitle = overridePageTitle || currentPage || '';
  if (!blocks || blocks.length === 0) {
    return '<p class="text-dim" style="color:var(--text-dim)">No blocks yet.</p>';
  }

  // Build parent → children map
  const childMap = {};
  const topBlocks = [];
  for (const b of blocks) {
    const parentId = b['block/parent']?.['block/id'];
    if (parentId && parentId !== b['block/id']) {
      if (!childMap[parentId]) childMap[parentId] = [];
      childMap[parentId].push(b);
    } else {
      topBlocks.push(b);
    }
  }
  // If no parent relationships detected (flat list), treat all as top-level
  const renderList = topBlocks.length > 0 ? topBlocks : blocks;

  const html = renderList.map(b => {
    const level = b['block/level'] || 0;
    const content = b['block/content'] || '';
    const todo = b['block/todo'];
    const props = b.properties || {};
    const children = childMap[b['block/id']] || [];

    // Skip answer blocks — they're rendered inline inside their ask card
    if (props.type === 'answer') return '';

    // Try component rendering first
    const componentHtml = renderBlockComponent(b, children, blocks);
    if (componentHtml) {
      return `<div class="block block-level-${level}" data-block-id="${escapeAttr(b['block/id']||'')}" data-page-title="${escapeAttr(pageTitle)}" data-raw-content="${escapeAttr(content)}" id="blk-${(b['block/id']||'').replace(/[^a-zA-Z0-9-]/g,'_')}">${componentHtml}</div>`;
    }

    // Default text rendering
    let contentHtml = '';
    if (todo) {
      contentHtml += `<span class="todo-${todo}">${todo} </span>`;
    }
    contentHtml += renderContent(content);

    const propKeys = Object.keys(props);
    if (propKeys.length > 0) {
      contentHtml += '<div class="block-props">';
      for (const [k, v] of Object.entries(props)) {
        contentHtml += `<span class="block-prop">${escapeHtml(k)}<span class="prop-sep">::</span>${escapeHtml(v)}</span>`;
      }
      contentHtml += '</div>';
    }

    // Render children inline if any
    let childrenHtml = '';
    if (children.length > 0) {
      childrenHtml = children.map(c => {
        let ch = '';
        const cTodo = c['block/todo'];
        if (cTodo) ch += `<span class="todo-${cTodo}">${cTodo} </span>`;
        ch += renderContent(c['block/content'] || '');
        const cContent = c['block/content'] || '';
        const cLevel = c['block/level'] || (level + 1);
        return `<div class="block block-level-${cLevel}" data-block-id="${escapeAttr(c['block/id']||'')}" data-page-title="${escapeAttr(pageTitle)}" data-raw-content="${escapeAttr(cContent)}"><div class="block-content">${ch}</div></div>`;
      }).join('');
    }

    return `
      <div class="block block-level-${level}" data-block-id="${escapeAttr(b['block/id']||'')}" data-page-title="${escapeAttr(pageTitle)}" data-raw-content="${escapeAttr(content)}" id="blk-${(b['block/id']||'').replace(/[^a-zA-Z0-9-]/g,'_')}">
        <div class="block-content">${contentHtml}${childrenHtml}</div>
      </div>`;
  });

  return html.join('');
}

// ─── Page rendering ──────────────────────────────────────────
function renderPage(data) {
  const rawTitle = data.title || data['page/title'] || 'Untitled';
  const blocks = data.blocks || [];
  const page = data.page || {};
  const tags = page['page/tags'] || [];
  const props = (page.properties || {});

  // Pretty-print journal dates: "2026_07_10" → "July 10, 2026"
  let title = rawTitle;
  const dateMatch = rawTitle.match(/^(\d{4})_(\d{2})_(\d{2})$/);
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    title = `${months[parseInt(m)-1]} ${parseInt(d)}, ${y}`;
  }

  let tagHtml = '';
  if (tags.length > 0) {
    tagHtml = '<div class="page-tags">' +
      tags.map(t => {
        let name;
        if (typeof t === 'string') name = t;
        else if (t['tag/name']) name = t['tag/name'];
        else if (t['page/title']) name = t['page/title'];
        else name = JSON.stringify(t);
        // Clean up [[brackets]]
        name = name.replace(/^\[\[/, '').replace(/\]\]$/, '');
        return `<span class="page-tag">${escapeHtml(name)}</span>`;
      }).join('') +
    '</div>';
  }

  let propHtml = '';
  const propEntries = Object.entries(props);
  if (propEntries.length > 0) {
    propHtml = '<div class="page-properties">' +
      propEntries.map(([k,v]) => `${escapeHtml(k)}:: ${escapeHtml(String(v))}`).join('<br>') +
    '</div>';
  }

  return `
    <div class="page-header">
      <div class="page-title">${escapeHtml(title)}</div>
      ${tagHtml}
      ${propHtml}
    </div>
    <div class="blocks">${renderBlocks(blocks)}</div>
  `;
}

// ─── Compose Bar (global, persistent) ──────────────────────

// State
let composeWriteMode = 'journal';
let composeBlockType = 'note';
let composePageTitle = null;   // current page being viewed (null = home)
let composeIsJournal = false;

// ─── Edit mode state ─────────────────────────────────────────
let editingBlockId = null;
let tapOutSaveSuppressed = false; // set by Cancel/×/Escape so focusout doesn't save
let editingBlockEl = null;
let ghostBlock = null;

// Enter edit mode for a block
function enterEditMode(blockEl) {
  const blockId = blockEl.dataset.blockId;
  if (!blockId) return;

  // Exit any current edit mode first
  exitEditMode();

  // Skip component blocks (events, asks) — they have structured cards
  if (blockEl.querySelector('.event-card, .ask-card')) return;

  editingBlockId = blockId;
  editingBlockEl = blockEl;

  // Add visual indicators
  blockEl.classList.add('block-editing');

  // Insert "editing" indicator with × close
  const indicator = document.createElement('div');
  indicator.className = 'editing-indicator';
  indicator.innerHTML = '<span class="editing-label">editing</span><span class="edit-close">\u00d7</span>';
  indicator.querySelector('.edit-close').addEventListener('pointerdown', () => { tapOutSaveSuppressed = true; });
  indicator.querySelector('.edit-close').addEventListener('click', (e) => {
    e.stopPropagation();
    exitEditMode();
  });
  blockEl.insertBefore(indicator, blockEl.firstChild);

  // Pre-populate compose bar with block's raw text content
  // Use data-raw-content which preserves \n (the API stores literal newlines)
  const input = document.getElementById('journal-input');
  if (input) {
    const rawContent = blockEl.dataset.rawContent;
    if (rawContent !== undefined) {
      // data-raw-content has HTML-escaped entities; decode them back
      const tmp = document.createElement('textarea');
      tmp.innerHTML = rawContent;
      input.value = tmp.value;
    } else {
      // Fallback: read from rendered content (loses <br> but better than nothing)
      const contentEl = blockEl.querySelector('.block-content');
      const clone = contentEl.cloneNode(true);
      clone.querySelectorAll('.block').forEach(el => el.remove());
      input.value = clone.textContent.trim();
    }
    input.focus();
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';

    // Hide compose-bar elements that don't apply to editing
    const composeBar = document.getElementById('compose-bar');
    if (composeBar) composeBar.classList.add('edit-mode');

    const btn = document.getElementById('journal-submit');
    if (btn) btn.textContent = '✓';

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'edit-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'compose-cancel';
    btn.parentNode.insertBefore(cancelBtn, btn);
    cancelBtn.addEventListener('pointerdown', () => { tapOutSaveSuppressed = true; });
    cancelBtn.addEventListener('click', () => exitEditMode());
  }
}

function exitEditMode() {
  if (!editingBlockEl) return;

  editingBlockEl.classList.remove('block-editing');
  const indicator = editingBlockEl.querySelector('.editing-indicator');
  if (indicator) indicator.remove();

  const cb = document.getElementById('edit-cancel');
  if (cb) cb.remove();

  removeGhostBlock();

  // Restore compose bar UI
  const composeBar = document.getElementById('compose-bar');
  if (composeBar) composeBar.classList.remove('edit-mode');

  editingBlockId = null;
  editingBlockEl = null;

  // Restore compose bar UI
  const input = document.getElementById('journal-input');
  const btn = document.getElementById('journal-submit');
  if (input) { input.value = ''; input.style.height = 'auto'; }
  if (btn) btn.textContent = '↑';

  const composeLabel = document.querySelector('#compose-bar .compose-label');
  if (composeLabel) {
    // Restore original label
    composeLabel.textContent = composeWriteMode === 'journal' ? "Today's Journal" : 'This Page';
  }
}

// Global dblclick handler for blocks
document.addEventListener('dblclick', (e) => {
  const blockEl = e.target.closest('.block[data-block-id]');
  if (blockEl && blockEl.dataset.blockId) {
    e.preventDefault();
    enterEditMode(blockEl);
  }
});

// Escape key to cancel edit mode
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editingBlockId) {
    tapOutSaveSuppressed = true;
    exitEditMode();
    setTimeout(() => { tapOutSaveSuppressed = false; }, 0);
  }
});

// ─── Ghost Block (insert via hover "+") ──────────────────────────
function removeGhostBlock() {
  if (ghostBlock) {
    ghostBlock.element.remove();
    ghostBlock = null;
  }
}

function createGhostBlock(afterBlockEl) {
  removeGhostBlock();

  const afterBlockId = afterBlockEl.dataset.blockId;
  const levelMatch = afterBlockEl.className.match(/block-level-(\d+)/);
  const level = parseInt(levelMatch ? levelMatch[1] : '0');
  const pageTitle = afterBlockEl.dataset.pageTitle || currentPage;

  const ghostDiv = document.createElement('div');
  ghostDiv.className = `block ghost-block block-level-${level}`;

  ghostDiv.innerHTML = `
    <div class="ghost-content">
      <textarea placeholder="Type here…"></textarea>
      <span class="ghost-level">L${level}</span>
    </div>`;

  const lastChild = afterBlockEl.querySelector(':scope > .block:last-child');
  if (lastChild) {
    lastChild.after(ghostDiv);
  } else {
    afterBlockEl.after(ghostDiv);
  }

  const textarea = ghostDiv.querySelector('textarea');
  textarea.focus();

  ghostBlock = { element: ghostDiv, afterBlockId, level, textarea, pageTitle };

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      if (ghostBlock.level < 5) {
        ghostBlock.level++;
        ghostDiv.className = `block ghost-block block-level-${ghostBlock.level}`;
        ghostDiv.querySelector('.ghost-level').textContent = `L${ghostBlock.level}`;
      }
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      if (ghostBlock.level > 0) {
        ghostBlock.level--;
        ghostDiv.className = `block ghost-block block-level-${ghostBlock.level}`;
        ghostDiv.querySelector('.ghost-level').textContent = `L${ghostBlock.level}`;
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitGhostBlock();
    } else if (e.key === 'Escape') {
      removeGhostBlock();
    }
  });

  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  });
}

async function submitGhostBlock() {
  if (!ghostBlock) return;

  const content = ghostBlock.textarea.value.trim();
  if (!content) {
    removeGhostBlock();
    return;
  }

  const { afterBlockId, level, pageTitle } = ghostBlock;
  const ednBody = '{:page "' + escapeEdn(pageTitle || '') + '" :content "' + escapeEdn(content) + '" :level ' + level + ' :after-block-id "' + escapeEdn(afterBlockId) + '"}';

  try {
    const result = await apiPost('/insert-block', ednBody);
    if (result.error) throw new Error(result.error);
    const newBlockId = result['block-id'] || '';

    // Block IDs shift on every reindex, so a DOM patch leaves other blocks
    // with stale IDs. Full re-render keeps every data-block-id valid.
    removeGhostBlock();

    const isJournal = pageTitle && /^\d{4}_\d{2}_\d{2}$/.test(pageTitle);
    if (isJournal) {
      await loadJournalTimeline();
    } else if (pageTitle) {
      await loadPage(pageTitle, { fromHash: true });
    }
    if (newBlockId) {
      const updated = document.querySelector(`[data-block-id=\"${CSS.escape(newBlockId)}\"]`);
      if (updated) updated.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch (e) {
    showToast('Failed to insert block', null);
    removeGhostBlock();
  }
}

// Interstitial + button — creates a ghost block after the target block
document.addEventListener('click', (e) => {
  const addBtn = e.target.closest('.block-insert');
  if (addBtn) {
    e.stopPropagation();
    e.preventDefault();
    const blockEl = addBtn.dataset.afterBlockId
      ? document.querySelector(`.block[data-block-id="${addBtn.dataset.afterBlockId}"]`)
      : addBtn.previousElementSibling;
    if (blockEl) createGhostBlock(blockEl);
  }
});

// Block context menu — right-click or long-press
let blockCtxTarget = null;
let blockCtxLongPressTimer = null;

document.addEventListener('contextmenu', (e) => {
  const blockEl = e.target.closest('.block[data-block-id]');
  if (blockEl) {
    e.preventDefault();
    showBlockCtxMenu(blockEl, e.clientX, e.clientY);
  }
});

document.addEventListener('touchstart', (e) => {
  const blockEl = e.target.closest('.block[data-block-id]');
  if (blockEl && !e.target.closest('.block-insert')) {
    blockCtxLongPressTimer = setTimeout(() => {
      const touch = e.touches[0];
      showBlockCtxMenu(blockEl, touch.clientX, touch.clientY);
    }, 500);
  }
}, { passive: true });

document.addEventListener('touchend', () => {
  if (blockCtxLongPressTimer) {
    clearTimeout(blockCtxLongPressTimer);
    blockCtxLongPressTimer = null;
  }
}, { passive: true });

document.addEventListener('touchmove', () => {
  if (blockCtxLongPressTimer) {
    clearTimeout(blockCtxLongPressTimer);
    blockCtxLongPressTimer = null;
  }
}, { passive: true });

function showBlockCtxMenu(blockEl, x, y) {
  blockCtxTarget = blockEl;
  const levelMatch = blockEl.className.match(/block-level-(\d+)/);
  const level = parseInt(levelMatch ? levelMatch[1] : '0');

  const menu = document.getElementById('block-ctx-menu');
  if (!menu) return;
  const indentBtn = document.getElementById('blk-ctx-indent');
  const outdentBtn = document.getElementById('blk-ctx-outdent');

  if (indentBtn) indentBtn.style.display = level < 5 ? '' : 'none';
  if (outdentBtn) outdentBtn.style.display = level > 0 ? '' : 'none';

  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top = Math.min(y, maxY) + 'px';
}

function hideBlockCtxMenu() {
  const menu = document.getElementById('block-ctx-menu');
  if (menu) {
    menu.classList.add('hidden');
    // Restore original menu contents if they were replaced by a sub-menu
    if (!menu.querySelector('#blk-ctx-indent')) {
      menu.innerHTML = `
        <button class="ctx-menu-item" id="blk-ctx-edit" data-action="edit">✏️ Edit block</button>
        <button class="ctx-menu-item" id="blk-ctx-indent" data-action="indent">→ Indent</button>
        <button class="ctx-menu-item" id="blk-ctx-outdent" data-action="outdent">← Outdent</button>
        <button class="ctx-menu-item" id="blk-ctx-add" data-action="add">+ Add block below</button>
        <button class="ctx-menu-item ctx-menu-item-danger" id="blk-ctx-delete" data-action="delete">✕ Delete block</button>
      `;
      wireBlockCtxMenu();
    }
  }
  blockCtxTarget = null;
}

// Wire (or re-wire) the standard block context menu buttons.
// Called once on init, and again whenever hideBlockCtxMenu restores the DOM
// after a sub-menu (previously only delete was re-wired — indent/outdent/add
// went dead after any delete-confirm).
function wireBlockCtxMenu() {
  const blkEdit = document.getElementById('blk-ctx-edit');
  if (blkEdit) blkEdit.addEventListener('click', () => {
    const target = blockCtxTarget; // hide nulls it — capture first
    hideBlockCtxMenu();
    if (target) enterEditMode(target);
  });
  const blkIndent = document.getElementById('blk-ctx-indent');
  const blkOutdent = document.getElementById('blk-ctx-outdent');
  const blkAdd = document.getElementById('blk-ctx-add');
  if (blkIndent) blkIndent.addEventListener('click', () => {
    if (blockCtxTarget) changeBlockLevel(blockCtxTarget, 1);
    hideBlockCtxMenu();
  });
  if (blkOutdent) blkOutdent.addEventListener('click', () => {
    if (blockCtxTarget) changeBlockLevel(blockCtxTarget, -1);
    hideBlockCtxMenu();
  });
  if (blkAdd) blkAdd.addEventListener('click', () => {
    if (blockCtxTarget) createGhostBlock(blockCtxTarget);
    hideBlockCtxMenu();
  });
  const blkDelete = document.getElementById('blk-ctx-delete');
  if (blkDelete) blkDelete.addEventListener('click', () => {
    if (blockCtxTarget) deleteBlock(blockCtxTarget);
  });
}

async function changeBlockLevel(blockEl, direction) {
  const blockId = blockEl.dataset.blockId;
  if (!blockId) return;
  const levelMatch = blockEl.className.match(/block-level-(\d+)/);
  const currentLevel = parseInt(levelMatch ? levelMatch[1] : '0');
  const newLevel = currentLevel + direction;
  if (newLevel < 0 || newLevel > 5) return;

  try {
    const ednBody = '{:block-id "' + escapeEdn(blockId) + '" :new-level ' + newLevel + '}';
    const result = await apiPost('/change-block-level', ednBody);
    if (result.error) throw new Error(result.error);
    // Re-render page from server to reflect structural changes
    const pageTitle = blockEl.dataset.pageTitle;
    if (pageTitle) {
      await loadPage(pageTitle, { fromHash: true });
      // Scroll to the changed block so user sees the update
      const updated = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
      if (updated) updated.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch (e) {
    showToast('Failed to change indent', null);
  }
}

async function deleteBlock(blockEl) {
  const blockId = blockEl.dataset.blockId;
  if (!blockId) return;
  const pageTitle = blockEl.dataset.pageTitle;
  if (!pageTitle) return;

  // Check for children in DOM — look for next siblings with deeper indent
  const levelMatch = blockEl.className.match(/block-level-(\d+)/);
  const blockLevel = parseInt(levelMatch ? levelMatch[1] : '0');
  const hasChildren = blockEl.nextElementSibling &&
    blockEl.nextElementSibling.classList.contains('block') &&
    blockEl.nextElementSibling.dataset.blockId &&
    blockEl.nextElementSibling.className.match(/block-level-(\d+)/) &&
    parseInt(RegExp.$1) > blockLevel;

  if (hasChildren) {
    // Show sub-menu with three choices
    showDeleteConfirmMenu(blockEl, blockId, pageTitle);
  } else {
    // No children — simple confirm
    if (!confirm('Delete this block?')) return;
    await doDeleteBlock(blockId, pageTitle, true);
  }
}

function showDeleteConfirmMenu(blockEl, blockId, pageTitle) {
  // Replace block context menu with delete-confirm sub-menu
  const menu = document.getElementById('block-ctx-menu');
  if (!menu) return;
  menu.innerHTML = `
    <button class="ctx-menu-item" id="blk-del-all" style="color:var(--text-dim)">🗑 Delete block + sub-blocks</button>
    <button class="ctx-menu-item" id="blk-del-inherit" style="color:var(--text-dim)">↰ Delete block, keep sub-blocks</button>
    <button class="ctx-menu-item" id="blk-del-cancel" style="color:var(--text-dim)">Cancel</button>
  `;
  menu.classList.remove('hidden');

  // Position over the block (centered)
  const rect = blockEl.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8)) + 'px';

  document.getElementById('blk-del-all').addEventListener('click', async () => {
    hideBlockCtxMenu();
    await doDeleteBlock(blockId, pageTitle, false);
  });
  document.getElementById('blk-del-inherit').addEventListener('click', async () => {
    hideBlockCtxMenu();
    await doDeleteBlock(blockId, pageTitle, true);
  });
  document.getElementById('blk-del-cancel').addEventListener('click', () => {
    hideBlockCtxMenu();
  });
}

async function doDeleteBlock(blockId, pageTitle, inheritChildren) {
  try {
    const ednBody = '{:block-id "' + escapeEdn(blockId) + '" :inherit-children ' + inheritChildren + '}';
    const result = await apiPost('/delete-block', ednBody);
    if (result.error) throw new Error(result.error);
    showToast('Block deleted', 2000);
  } catch (e) {
    showToast('Failed to delete block', null);
    return;
  }
  // Reload page separately so a render error doesn't mask the delete success
  try {
    await loadPage(pageTitle, { fromHash: true });
  } catch (e) {
    // Page reload failed — delete still worked, user can refresh manually
  }
}

// Update compose bar context when navigating
function updateComposeContext(pageTitle, isJournal) {
  composePageTitle = pageTitle;
  composeIsJournal = isJournal;

  const pagePill = document.getElementById('pill-page');
  const journalPill = document.getElementById('pill-journal');

  if (isJournal) {
    // Already on a journal page — force journal mode, disable page pill
    composeWriteMode = 'journal';
    journalPill.classList.add('active');
    pagePill.classList.remove('active');
    pagePill.disabled = true;
    pagePill.textContent = 'Page';
  } else {
    // On a regular page — enable page pill, update label
    pagePill.disabled = false;
    pagePill.textContent = truncate(pageTitle, 20);
    // Don't force mode change — let user keep their choice
  }
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function escapeEdn(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

// Initialize the compose bar — called once on DOMContentLoaded
function initComposeBar() {
  const btn = document.getElementById('journal-submit');
  const input = document.getElementById('journal-input');
  const titleInput = document.getElementById('write-title');
  const schemaFieldsDiv = document.getElementById('write-schema-fields');
  const journalPill = document.getElementById('pill-journal');
  const pagePill = document.getElementById('pill-page');
  const typePills = document.querySelectorAll('#compose-bar .type-pill');

  // ── Schema field rendering ──
  function renderSchemaFields(typeKey) {
    const schema = BLOCK_SCHEMAS[typeKey];
    if (!schema || !schema.fields || schema.fields.length === 0) {
      schemaFieldsDiv.innerHTML = '';
      return;
    }
    schemaFieldsDiv.innerHTML = schema.fields.map((f, fi) => {
      const fieldId = `field-${f.key}`;
      const tabIdx = 3 + fi; // schema fields start at tabindex 3

      let defaultVal = '';
      if (f.default === 'today') {
        const d = new Date();
        defaultVal = toDateStr(d);
      } else if (f.default) {
        defaultVal = f.default;
      }

      let inputHtml = '';
      if (f.type === 'select') {
        const opts = f.options.map(o => `<option value="${o}" ${o === defaultVal ? 'selected' : ''}>${o}</option>`).join('');
        inputHtml = `<select id="${fieldId}" class="schema-input" tabindex="${tabIdx}">${opts}</select>`;
      } else if (f.type === 'date' && f.timeOptional) {
        inputHtml = `
          <div class="date-time-group">
            <input type="date" id="${fieldId}" class="schema-input" value="${escapeAttr(defaultVal)}" tabindex="${tabIdx}">
            <button type="button" class="time-toggle" data-target="${fieldId}">⏰ Add time</button>
          </div>`;
      } else {
        inputHtml = `<input type="${f.type}" id="${fieldId}" class="schema-input" value="${escapeAttr(defaultVal)}" tabindex="${tabIdx}" ${f.placeholder ? `placeholder="${escapeAttr(f.placeholder)}"` : ''}>`;
      }
      return `<label class="schema-field schema-field-${f.key}"><span class="schema-label">${f.label}${f.required ? ' <span class="required">*</span>' : ''}</span>${inputHtml}</label>`;
    }).join(' ');

    // Wire time toggle buttons
    schemaFieldsDiv.querySelectorAll('.time-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = document.getElementById(btn.dataset.target);
        if (!target) return;
        const dateVal = target.value || toDateStr(new Date());
        if (target.type === 'date') {
          const dt = document.createElement('input');
          dt.type = 'datetime-local';
          dt.id = target.id;
          dt.className = target.className;
          dt.value = dateVal + 'T09:00';
          target.replaceWith(dt);
          btn.textContent = '✕ Remove time';
          btn.classList.add('active');
        } else {
          const dt = document.createElement('input');
          dt.type = 'date';
          dt.id = target.id;
          dt.className = target.className;
          dt.value = target.value.split('T')[0] || dateVal;
          target.replaceWith(dt);
          btn.textContent = '⏰ Add time';
          btn.classList.remove('active');
        }
      });
    });

    // Wire start→end
    const startEl = document.getElementById('field-start');
    const endEl = document.getElementById('field-end');
    if (startEl && endEl) {
      startEl.addEventListener('change', () => {
        const sv = startEl.value.split('T')[0];
        const ev = endEl.value.split('T')[0];
        if (sv > ev) {
          const hasTime = endEl.type === 'datetime-local';
          endEl.value = sv + (hasTime ? 'T10:00' : '');
        }
      });
    }
  }

  // Initial render
  renderSchemaFields(composeBlockType);

  // ── Write mode toggle ──
  journalPill.addEventListener('click', () => {
    composeWriteMode = 'journal';
    journalPill.classList.add('active');
    pagePill.classList.remove('active');
  });
  pagePill.addEventListener('click', () => {
    if (pagePill.disabled) return;
    composeWriteMode = 'page';
    pagePill.classList.add('active');
    journalPill.classList.remove('active');
  });

  // ── Block type toggle ──
  typePills.forEach(pill => {
    pill.addEventListener('click', () => {
      composeBlockType = pill.dataset.blockType;
      typePills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      renderSchemaFields(composeBlockType);

      // Swap placeholder based on type
      if (composeBlockType === 'ask') {
        input.placeholder = 'Ask a question…';
        titleInput.placeholder = '(optional context)';
      } else {
        input.placeholder = 'Write something…';
        titleInput.placeholder = 'Title or #tags (optional)…';
      }
    });
  });

  // ── Build content ──
  function buildContent() {
    const title = titleInput ? titleInput.value.trim() : '';
    const notes = input.value.trim();
    if (!title && !notes) return null;

    if (composeBlockType === 'note') {
      if (title && notes) return title + '\n\t- ' + notes;
      return title || notes;
    }

    // For ask type: generate a random ask-id for linking answers
    if (composeBlockType === 'ask') {
      const askId = Math.random().toString(36).substring(2, 10);
      let result = notes || title;
      result += '\n\ttype:: ask\n\task-id:: ' + askId;
      if (title && notes) result = title + '\n\t- ' + notes + '\n\ttype:: ask\n\task-id:: ' + askId;
      return result;
    }

    const schema = BLOCK_SCHEMAS[composeBlockType];
    let propLines = '\ttype:: ' + composeBlockType;
    if (schema && schema.fields) {
      for (const f of schema.fields) {
        const el = document.getElementById('field-' + f.key);
        if (!el) continue;
        const val = el.value.trim();
        if (val) propLines += '\n\t' + f.key + ':: ' + val;
      }
    }
    let result = title || notes;
    if (title && notes) result += '\n\t' + notes;
    result += '\n' + propLines;
    return result;
  }

  // ── Submit ──
  btn.addEventListener('click', async () => {
    // ── Edit mode: update existing block ──
    if (editingBlockId) {
      const content = input.value.trim();
      if (!content) return;
      btn.disabled = true;
      try {
        const result = await apiPost('/update-block', '{:id "' + escapeEdn(editingBlockId) + '" :content "' + escapeEdn(content) + '"}');
        if (result.error) throw new Error(result.error);
        const newBlockId = result['block-id'] || editingBlockId;
        // Capture page title BEFORE exitEditMode nulls editingBlockEl,
        // and BEFORE loadPage rewrites the DOM.
        const pageTitle = editingBlockEl?.dataset.pageTitle || currentPage;
        exitEditMode();
        // Full re-render: block IDs shift on every reindex, so a DOM patch
        // would leave other blocks with stale IDs → next edit fails silently.
        if (pageTitle && /^\d{4}_\d{2}_\d{2}$/.test(pageTitle)) {
          await loadJournalTimeline();
        } else if (pageTitle) {
          await loadPage(pageTitle, { fromHash: true });
        }
        const updated = document.querySelector(`[data-block-id="${CSS.escape(newBlockId)}"]`);
        if (updated) updated.scrollIntoView({ behavior: 'smooth', block: 'center' });
        showToast('Block updated', null);
      } catch (e) {
        showToast('Failed to update — try again', null);
      }
      btn.disabled = false;
      return;
    }

    // ── Normal mode: append new block ──
    const content = buildContent();
    if (!content) return;
    btn.disabled = true;

    try {
      if (composeWriteMode === 'journal') {
        await apiPost('/append', '{:content "' + escapeEdn(content) + '" :journal true}');
      } else {
        await apiPost('/append', '{:title "' + escapeEdn(composePageTitle) + '" :content "' + escapeEdn(content) + '"}');
      }

      // Clear inputs
      if (titleInput) titleInput.value = '';
      input.value = '';
      input.style.height = 'auto';
      renderSchemaFields(composeBlockType);

      btn.disabled = false;

      const targetPage = composeWriteMode === 'journal' ? todayJournalPage() : composePageTitle;
      const label = composeWriteMode === 'journal' ? "today's journal" : 'this page';
      showToast(`Added to ${label}`, targetPage);
      // Reload timeline if in journal mode, otherwise reload the page
      if (composeWriteMode === 'journal') {
        loadJournalTimeline();
      } else {
        loadPage(targetPage);
      }
    } catch (e) {
      btn.disabled = false;
      showToast('Failed to save — try again', null);
    }
  });

  // ── Enter to submit (Shift+Enter for newline) ──
  // The slash menu owns navigation keys while it's open.
  input.addEventListener('keydown', (e) => {
    if (isSlashMenuOpen()) {
      handleSlashKeydown(e);
      return; // menu handles Enter/Arrows/Escape; skip normal submit
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      btn.click();
    }
  });

  // ── Tap-out saves: leaving the field while editing commits the edit ──
  input.addEventListener('focusout', (e) => {
    if (!editingBlockId || btn.disabled) return;
    if (isSlashMenuOpen()) return; // picking a template isn't leaving
    if (tapOutSaveSuppressed) { tapOutSaveSuppressed = false; return; }
    const rt = e.relatedTarget;
    if (rt && rt.closest && rt.closest('#compose-bar')) return; // ✓ / Cancel handle themselves
    if (!input.value.trim()) { exitEditMode(); return; } // empty — just leave
    btn.click(); // reuse the exact edit-save path
  });
  if (titleInput) {
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.focus();
      }
    });
  }

  // ── Auto-resize textarea ──
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
}

// ─── Slash Command Menu ──────────────────────────────────────
// Detects "/" as the first char of an otherwise-empty line in the compose
// textarea, shows a filterable template dropdown. Arrow keys navigate,
// Enter selects, Escape dismisses. On select, the template's children are
// appended as new blocks to the current page/journal.

let slashTemplates = [];
let slashMenuEl = null;
let slashMatches = [];
let slashSelectedIndex = 0;

async function loadSlashTemplates() {
  try {
    const data = await api('/templates');
    slashTemplates = (data && data.templates) || [];
  } catch (e) {
    console.error('Failed to load templates:', e);
    slashTemplates = [];
  }
}

function isSlashMenuOpen() {
  return !!slashMenuEl && !slashMenuEl.classList.contains('hidden');
}

function filterSlashTemplates(query) {
  if (!slashTemplates.length) return [];
  const q = (query || '').toLowerCase();
  if (!q) return slashTemplates.slice(0, 8);
  const starts = slashTemplates.filter(t => (t.name || '').toLowerCase().startsWith(q));
  if (starts.length) return starts.slice(0, 8);
  const includes = slashTemplates.filter(t => (t.name || '').toLowerCase().includes(q));
  return includes.slice(0, 8);
}

function renderSlashMenu() {
  if (!slashMenuEl) return;
  slashMenuEl.innerHTML = slashMatches.map((t, i) => {
    const name = escapeHtml(t.name || '');
    const page = t.page ? `<span class="slash-item-page">${escapeHtml(t.page)}</span>` : '';
    return `<div class="slash-item${i === slashSelectedIndex ? ' selected' : ''}" data-index="${i}">
      <span class="slash-item-name">/${name}</span>
      ${page}
    </div>`;
  }).join('');

  slashMenuEl.querySelectorAll('.slash-item').forEach(el => {
    const idx = parseInt(el.dataset.index, 10);
    // mousedown + preventDefault keeps focus on the textarea
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (slashMatches[idx]) selectSlashTemplate(slashMatches[idx]);
    });
    el.addEventListener('mouseenter', () => {
      slashSelectedIndex = idx;
      updateSlashSelection();
    });
  });
}

function updateSlashSelection() {
  if (!slashMenuEl) return;
  const items = slashMenuEl.querySelectorAll('.slash-item');
  items.forEach((el, i) => el.classList.toggle('selected', i === slashSelectedIndex));
}

function scrollSlashSelectionIntoView() {
  if (!slashMenuEl) return;
  const sel = slashMenuEl.querySelector('.slash-item.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function showSlashMenu() {
  if (slashMenuEl) slashMenuEl.classList.remove('hidden');
}

function hideSlashMenu() {
  if (slashMenuEl) slashMenuEl.classList.add('hidden');
}

function onSlashInput() {
  const input = document.getElementById('journal-input');
  if (!input) return;
  const val = input.value;
  const pos = input.selectionStart;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const line = val.slice(lineStart, pos);
  // Trigger: "/" as the first char of the line, optionally followed by a
  // non-whitespace query token (e.g. "/", "/t", "/mo").
  const m = line.match(/^\/(\S*)$/);
  if (m && slashTemplates.length > 0) {
    slashMatches = filterSlashTemplates(m[1]);
    if (slashMatches.length > 0) {
      slashSelectedIndex = 0;
      renderSlashMenu();
      showSlashMenu();
      return;
    }
  }
  hideSlashMenu();
}

function handleSlashKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (slashMatches.length === 0) return;
    slashSelectedIndex = (slashSelectedIndex + 1) % slashMatches.length;
    updateSlashSelection();
    scrollSlashSelectionIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (slashMatches.length === 0) return;
    slashSelectedIndex = (slashSelectedIndex - 1 + slashMatches.length) % slashMatches.length;
    updateSlashSelection();
    scrollSlashSelectionIntoView();
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (slashMatches[slashSelectedIndex]) selectSlashTemplate(slashMatches[slashSelectedIndex]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideSlashMenu();
  }
}

async function selectSlashTemplate(tpl) {
  hideSlashMenu();
  const input = document.getElementById('journal-input');
  const children = (tpl && tpl.children) || [];
  const content = children.join('\n');
  if (!content.trim()) {
    if (input) { input.value = ''; input.style.height = 'auto'; }
    return;
  }

  try {
    if (composeWriteMode === 'journal') {
      await apiPost('/append', '{:content "' + escapeEdn(content) + '" :journal true}');
    } else {
      await apiPost('/append', '{:title "' + escapeEdn(composePageTitle || '') + '" :content "' + escapeEdn(content) + '"}');
    }

    // Clear the textarea after a successful insert
    if (input) { input.value = ''; input.style.height = 'auto'; }

    if (composeWriteMode === 'journal') {
      loadJournalTimeline();
      showToast("Added template to today's journal", todayJournalPage());
    } else {
      loadPage(composePageTitle);
      showToast('Added template to this page', composePageTitle);
    }
  } catch (e) {
    showToast('Failed to insert template', null);
  }
}

function initSlashMenu() {
  const input = document.getElementById('journal-input');
  if (!input) return;
  const wrap = input.parentElement;
  if (!wrap) return;

  slashMenuEl = document.createElement('div');
  slashMenuEl.className = 'slash-menu hidden';
  wrap.appendChild(slashMenuEl);

  input.addEventListener('input', onSlashInput);
  input.addEventListener('blur', () => {
    // small delay so a mousedown on an item can register first
    setTimeout(hideSlashMenu, 120);
  });
}

// ─── Search results ──────────────────────────────────────────
function renderSearchResults(query, results) {
  if (results.length === 0) {
    return `<div class="empty-state"><h2>No results for "${escapeHtml(query)}"</h2></div>`;
  }

  const html = results.map(r => {
    const page = r['block/page'] || {};
    const pageTitle = page['page/title'] || '?';
    const content = r['block/content'] || '';
    return `
      <div class="search-result" data-page="${escapeAttr(pageTitle)}">
        <div class="result-page">${escapeHtml(pageTitle)}</div>
        <div class="result-content">${renderContent(content)}</div>
      </div>`;
  });

  return `<div class="search-results">
    <div style="font-size:0.8rem;color:var(--text-dim);margin-bottom:1rem">
      ${results.length} result${results.length !== 1 ? 's' : ''} for "${escapeHtml(query)}"
    </div>
    ${html.join('')}
  </div>`;
}

// ─── Navigation ──────────────────────────────────────────────
// Get today's journal page name in YYYY_MM_DD format (matches logseqd)
function todayJournalPage() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}_${m}_${day}`;
}

// Toast notification — message + optional page name to link to
let toastTimer = null;
function showToast(message, pageName) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  clearTimeout(toastTimer);

  let html = `<span class="toast-icon">✓</span><span>${escapeHtml(message)}</span>`;
  if (pageName) {
    html += `<a class="toast-link" id="toast-link">View journal →</a>`;
  }
  toast.innerHTML = html;
  toast.classList.remove('hidden');

  // Wire toast link
  if (pageName) {
    document.getElementById('toast-link').addEventListener('click', () => {
      toast.classList.add('hidden');
      loadPage(pageName);
    });
  }

  toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

async function loadPage(title, opts = {}) {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const data = await api('/page/' + encodeURIComponent(title));
    currentPage = title;

    // Update URL hash (skip if called from hashchange to avoid loop)
    if (!opts.fromHash) {
      const hash = '#/' + title;
      if (location.hash !== hash) {
        history.pushState({page: title}, '', hash);
      }
    }

    content.innerHTML = renderPage(data);

    // Deep link: scroll to and highlight a specific block if ?b= present
    const targetBlock = hashToBlockId();
    if (targetBlock) {
      // Slight delay to ensure DOM is fully painted
      setTimeout(() => scrollToBlock(targetBlock), 100);
    }

    // Update active highlight
    document.querySelectorAll('.sb-page-link').forEach(a => a.classList.remove('active'));
    const jBtn = document.getElementById('btn-sidebar-journal');
    if (jBtn) jBtn.classList.remove('active');
    const active = document.querySelector(`.sb-page-link[data-page="${CSS.escape(title)}"]`);
    if (active) active.classList.add('active');

    // Update compose bar context
    const isJournalPage = /^\d{4}_\d{2}_\d{2}$/.test(title);
    updateComposeContext(title, isJournalPage);

    // Wire page refs and tag clicks
    wirePageRefs();
    wireBlockInterstials();
    wireTagClicks();
    document.getElementById('sidebar').classList.remove('open');
  } catch (e) {
    // If called in "try next" mode (from loadDefaultPage), re-throw so it can continue
    if (opts.tryNext) throw e;
    // If 404, this might be a ghost page or a new journal day
    if (e.message && e.message.includes('404')) {
      const isJournal = /^\d{4}_\d{2}_\d{2}$/.test(title);
      if (isJournal) {
        loadEmptyJournal(title);
      } else {
        await loadGhostPage(title);
      }
      return;
    }
    content.innerHTML = `<div class="empty-state"><h2>Couldn't load "${escapeHtml(title)}"</h2><p>${escapeHtml(e.message)}</p></div>`;
  }
}

// ─── Empty Journal (today exists but no entries yet) ────────
function loadEmptyJournal(title) {
  const content = document.getElementById('content');
  currentPage = title;

  const hash = '#/' + title;
  if (location.hash !== hash) {
    history.pushState({page: title}, '', hash);
  }

  document.querySelectorAll('.sb-page-link').forEach(a => a.classList.remove('active'));
  updateComposeContext(title, true);

  content.innerHTML = `
    <div class="page-header">
      <div class="page-title">${escapeHtml(title)}</div>
    </div>
    <div class="empty-state"><p>Nothing written yet today.</p></div>
  `;

  document.getElementById('sidebar').classList.remove('open');
}

// ─── Ghost Page (referenced but no file) ─────────────────────
// Shows empty page + linked references (backlinks), like Logseq desktop
async function loadGhostPage(title) {
  const content = document.getElementById('content');
  currentPage = title;

  // Update URL hash
  const hash = '#/' + title;
  if (location.hash !== hash) {
    history.pushState({page: title}, '', hash);
  }

  // Update active highlight
  document.querySelectorAll('.sb-page-link').forEach(a => a.classList.remove('active'));
  const active = document.querySelector(`.sb-page-link[data-page="${CSS.escape(title)}"]`);
  if (active) active.classList.add('active');

  // Update compose bar context
  updateComposeContext(title, false);

  // Query for backlinks — blocks that reference this page title in content
  let refs = [];
  try {
    const queryBody = '{:find [(pull ?b [:block/id :block/content :block/order {:block/page [:page/title]}])] :where [[?b :block/content ?c] [(clojure.string/includes? ?c "' + title.replace(/"/g, '\\"') + '")]]} ';
    const resp = await fetch(API + '/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/edn' },
      body: queryBody,
    });
    if (resp.ok) {
      const data = await resp.json();
      refs = (data.results || []).map(r => Array.isArray(r) ? r[0] : r);
      // Sort by page title then block order
      refs.sort((a, b) => {
        const pa = (a['block/page']?.['page/title']) || '';
        const pb = (b['block/page']?.['page/title']) || '';
        if (pa !== pb) return pa.localeCompare(pb);
        return (a['block/order'] || 0) - (b['block/order'] || 0);
      });
    }
  } catch (qErr) {
    console.error('Backlink query failed:', qErr);
  }

  let html = `
    <div class="page-header">
      <div class="page-title">${escapeHtml(title)}</div>
    </div>
    <div class="ghost-page-notice">This page has no content yet. Create it by writing a note below.</div>
  `;

  if (refs.length === 0) {
    html += '<div class="empty-state"><p>No references yet.</p></div>';
  } else {
    html += `
      <div class="linked-references">
        <div class="linked-refs-header">${refs.length} Linked Reference${refs.length !== 1 ? 's' : ''}</div>
        ${refs.map(r => {
          const pageTitle = r['block/page']?.['page/title'] || '?';
          const blockContent = r['block/content'] || '';
          const blockId = r['block/id'] || '';
          return `
            <div class="linked-ref" data-page="${escapeAttr(pageTitle)}" data-block-id="${escapeAttr(blockId)}">
              <div class="linked-ref-page" data-page="${escapeAttr(pageTitle)}">${escapeHtml(pageTitle)}</div>
              <div class="linked-ref-content">${renderContent(blockContent)}</div>
            </div>`;
        }).join('')}
      </div>
    `;
  }

  content.innerHTML = html;

  // Wire interactions
  wireTagClicks();
  wirePageRefs();

  document.querySelectorAll('.linked-ref[data-page]').forEach(el => {
    const pageTitle = el.dataset.page;
    const blockId = el.dataset.blockId;
    el.querySelector('.linked-ref-page').addEventListener('click', () => {
      if (blockId) {
        loadPage(pageTitle, {fromHash: true});
        setTimeout(() => scrollToBlock(blockId), 200);
      } else {
        loadPage(pageTitle);
      }
    });
  });

  document.getElementById('sidebar').classList.remove('open');
}

// ─── Tag Page ────────────────────────────────────────────────
// Shows all blocks referencing a tag as "Linked References" — like Logseq backlinks
async function loadTagPage(tagName) {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty-state">Loading…</div>';

  // Update URL hash
  const hash = '#/tag/' + tagName;
  if (location.hash !== hash) {
    history.pushState({tag: tagName}, '', hash);
  }

  // Clear active page highlight
  document.querySelectorAll('.sb-page-link').forEach(a => a.classList.remove('active'));
  const jBtn = document.getElementById('btn-sidebar-journal');
  if (jBtn) jBtn.classList.remove('active');

  try {
    // Query blocks with this tag
    const queryBody = '{:find [(pull ?b [:block/id :block/content :block/level :block/order {:block/page [:page/title]} {:block/tags [:tag/name]}]) ] :where [[?b :block/tags ?t] [?t :tag/name "' + tagName.replace(/"/g, '\\"') + '"]]}';
    const resp = await fetch(API + '/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/edn' },
      body: queryBody,
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = await resp.json();
    const refs = data.results.map(r => r[0]);

    // Sort by page title then block order
    refs.sort((a, b) => {
      const pa = (a['block/page']?.['page/title']) || '';
      const pb = (b['block/page']?.['page/title']) || '';
      if (pa !== pb) return pa.localeCompare(pb);
      return (a['block/order'] || 0) - (b['block/order'] || 0);
    });

    let html = `
      <div class="page-header">
        <div class="page-title">#${escapeHtml(tagName)}</div>
        <div class="page-tags"><span class="page-tag">tag</span></div>
      </div>
    `;

    if (refs.length === 0) {
      html += '<div class="empty-state"><p>No references yet.</p></div>';
    } else {
      html += `
        <div class="linked-references">
          <div class="linked-refs-header">${refs.length} Linked Reference${refs.length !== 1 ? 's' : ''}</div>
          ${refs.map(r => {
            const pageTitle = r['block/page']?.['page/title'] || '?';
            const blockContent = r['block/content'] || '';
            const blockId = r['block/id'] || '';
            return `
              <div class="linked-ref" data-page="${escapeAttr(pageTitle)}" data-block-id="${escapeAttr(blockId)}">
                <div class="linked-ref-page" data-page="${escapeAttr(pageTitle)}">${escapeHtml(pageTitle)}</div>
                <div class="linked-ref-content">${renderContent(blockContent)}</div>
              </div>`;
          }).join('')}
        </div>
      `;
    }

    content.innerHTML = html;

    // Wire tag clicks, page refs, and linked-ref page navigation
    wireTagClicks();
    wirePageRefs();
    wireBlockInterstials();

    // Wire linked reference page titles → navigate to that page (with block highlight)
    document.querySelectorAll('.linked-ref[data-page]').forEach(el => {
      const pageTitle = el.dataset.page;
      const blockId = el.dataset.blockId;
      el.querySelector('.linked-ref-page').addEventListener('click', () => {
        if (blockId) {
          loadPage(pageTitle, {fromHash: true});
          setTimeout(() => scrollToBlock(blockId), 200);
        } else {
          loadPage(pageTitle);
        }
      });
    });

    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><h2>Couldn't load #${escapeHtml(tagName)}</h2><p>${escapeHtml(e.message)}</p></div>`;
  }
}

// Wire all .inline-tag elements to navigate to tag pages
function wireTagClicks() {
  document.querySelectorAll('.inline-tag[data-tag]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      loadTagPage(el.dataset.tag);
    });
  });
}

async function doSearch(query) {
  if (!query.trim()) {
    loadSidebar();
    return;
  }

  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty-state">Searching…</div>';

  try {
    const data = await api('/search?q=' + encodeURIComponent(query));
    const results = data.results || [];
    content.innerHTML = renderSearchResults(query, results);

    // Click result → load that page
    document.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => {
        const pageTitle = el.getAttribute('data-page');
        loadPage(pageTitle);
      });
    });
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><h2>Search failed</h2><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function wirePageRefs() {
  document.querySelectorAll('.page-ref').forEach(el => {
    el.addEventListener('click', () => loadPage(el.getAttribute('data-page')));
  });
}

// ─── Interstitial + dividers ────────────────────────────────
// Injects a thin + button between blocks. On desktop: hover to reveal.
// On mobile: always visible (thin hit target).
function wireBlockInterstials() {
  // Remove old interstitials first (for re-render)
  document.querySelectorAll('.block-insert').forEach(el => el.remove());

  const blocksContainers = document.querySelectorAll('.blocks');
  blocksContainers.forEach(container => {
    const blocks = container.querySelectorAll(':scope > .block');
    blocks.forEach(block => {
      const blockId = block.dataset.blockId;
      if (!blockId) return;

      const insert = document.createElement('div');
      insert.className = 'block-insert';
      insert.dataset.afterBlockId = blockId;
      insert.textContent = '+';
      block.after(insert);
    });
  });
}

// ─── Pins (localStorage) ────────────────────────────────────
const PINS_KEY = 'logseq-pinned-pages';
function getPins() {
  try { return JSON.parse(localStorage.getItem(PINS_KEY)) || []; } catch { return []; }
}
function savePins(pins) {
  localStorage.setItem(PINS_KEY, JSON.stringify(pins));
}
function isPinned(title) {
  return getPins().includes(title);
}
function togglePin(title) {
  let pins = getPins();
  if (pins.includes(title)) {
    pins = pins.filter(p => p !== title);
  } else {
    pins.push(title);
  }
  savePins(pins);
  return pins;
}

// ─── Relative time ────────────────────────────────────────────
// mtime is Java epoch ms (same as Unix epoch ms)
function relativeTime(mtimeMs) {
  if (!mtimeMs) return '';
  const now = Date.now();
  const diff = now - mtimeMs; // ms
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

// ─── Context menu ─────────────────────────────────────────────
let ctxTargetPage = null;

function showCtxMenu(pageTitle, x, y) {
  ctxTargetPage = pageTitle;
  const menu = document.getElementById('ctx-menu');
  const pinBtn = document.getElementById('ctx-pin');
  const unpinBtn = document.getElementById('ctx-unpin');

  if (isPinned(pageTitle)) {
    pinBtn.classList.add('hidden');
    unpinBtn.classList.remove('hidden');
  } else {
    pinBtn.classList.remove('hidden');
    unpinBtn.classList.add('hidden');
  }

  // Position: ensure stays in viewport
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top = Math.min(y, maxY) + 'px';
}

function hideCtxMenu() {
  const menu = document.getElementById('ctx-menu');
  if (menu) menu.classList.add('hidden');
  ctxTargetPage = null;
}

function initCtxMenu() {
  // Wire context menu actions
  document.getElementById('ctx-pin').addEventListener('click', () => {
    if (ctxTargetPage) {
      togglePin(ctxTargetPage);
      loadSidebar(); // re-render
    }
    hideCtxMenu();
  });
  document.getElementById('ctx-unpin').addEventListener('click', () => {
    if (ctxTargetPage) {
      togglePin(ctxTargetPage);
      loadSidebar(); // re-render
    }
    hideCtxMenu();
  });

  // Close on click outside or Escape
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ctx-menu')) {
      hideCtxMenu();
      hideBlockCtxMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideCtxMenu();
      hideBlockCtxMenu();
    }
  });

  // Block context menu actions (wiring lives in wireBlockCtxMenu)
  wireBlockCtxMenu();
}

// ─── Sidebar rendering ───────────────────────────────────────
function isJournalTitle(title) {
  return /^\d{4}_\d{2}_\d{2}$/.test(title);
}
// Cron/system output pages — dated dash format like "2026-07-09 - Morning Kickoff"
function isSystemPage(title) {
  return /^\d{4}-\d{2}-\d{2} - /.test(title);
}

function buildPageItem(title, extraClass) {
  const pinned = isPinned(title);
  const isActive = currentPage === title;
  let classes = 'sb-page-link';
  if (isActive) classes += ' active';
  if (extraClass) classes += ' ' + extraClass;
  const pinIcon = pinned ? '📍' : '📌';
  return `<li class="sb-page-item${pinned ? ' is-pinned' : ''}" data-page-title="${escapeAttr(title)}">
    <a class="${classes}" data-page="${escapeAttr(title)}">${escapeHtml(title)}</a>
    <button class="sb-pin-btn" data-pin-page="${escapeAttr(title)}" title="${pinned ? 'Unpin' : 'Pin'}">${pinIcon}</button>
  </li>`;
}

function buildRecentItem(title, mtime, hoursAgo) {
  const pinned = isPinned(title);
  const isActive = currentPage === title;
  const timeStr = relativeTime(mtime);
  const freshnessClass = hoursAgo < 24 ? ' recent-fresh' : '';
  let classes = 'sb-page-link' + freshnessClass;
  if (isActive) classes += ' active';
  const pinIcon = pinned ? '📍' : '📌';
  return `<li class="sb-page-item${pinned ? ' is-pinned' : ''}" data-page-title="${escapeAttr(title)}">
    <a class="${classes}" data-page="${escapeAttr(title)}">
      <span>${escapeHtml(title)}</span>
      <span class="sb-page-time">${timeStr}</span>
    </a>
    <button class="sb-pin-btn" data-pin-page="${escapeAttr(title)}" title="${pinned ? 'Unpin' : 'Pin'}">${pinIcon}</button>
  </li>`;
}

function wireSidebarItem(el) {
  // Page link click → navigate
  const link = el.querySelector('.sb-page-link');
  if (link) {
    link.addEventListener('click', () => loadPage(link.getAttribute('data-page')));
  }

  // Pin button click → toggle pin + re-render
  const pinBtn = el.querySelector('.sb-pin-btn');
  if (pinBtn) {
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const title = pinBtn.getAttribute('data-pin-page');
      togglePin(title);
      loadSidebar();
    });
  }

  // Right-click → context menu
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const title = el.getAttribute('data-page-title');
    showCtxMenu(title, e.clientX, e.clientY);
  });
}

function wireSectionCollapse(header, section) {
  header.addEventListener('click', (e) => {
    // Don't toggle if clicking on pin button inside header
    if (e.target.closest('.sb-pin-btn')) return;
    section.classList.toggle('collapsed');
  });
}

async function loadSidebar() {
  try {
    const [health, pagesData, tagsData] = await Promise.all([
      api('/health'),
      api('/pages'),
      api('/tags'),
    ]);

    // Stats
    document.getElementById('graph-stats').textContent =
      `${health.blocks} blocks · ${health.pages} pages`;

    // Separate and sort pages
    const pages = pagesData.pages || [];
    const journals = pages.filter(p => isJournalTitle(p['page/title'] || p.title || ''));
    const systemPages = pages.filter(p => isSystemPage(p['page/title'] || p.title || ''));
    const regularPages = pages.filter(p => {
      const t = p['page/title'] || p.title || '';
      return !isJournalTitle(t) && !isSystemPage(t);
    });

    // Sort regular pages alphabetically for "All Pages"
    regularPages.sort((a, b) => {
      const ta = (a['page/title'] || a.title || '').toLowerCase();
      const tb = (b['page/title'] || b.title || '').toLowerCase();
      return ta.localeCompare(tb);
    });

    // Sort journals alphabetically
    journals.sort((a, b) => {
      const ta = (a['page/title'] || a.title || '').toLowerCase();
      const tb = (b['page/title'] || b.title || '').toLowerCase();
      return ta.localeCompare(tb);
    });

    // Sort system pages alphabetically
    systemPages.sort((a, b) => {
      const ta = (a['page/title'] || a.title || '').toLowerCase();
      const tb = (b['page/title'] || b.title || '').toLowerCase();
      return ta.localeCompare(tb);
    });

    // Recent pages: non-journal, with mtime, sorted by mtime desc, max 8
    const withMtime = regularPages.filter(p => p['page/mtime']);
    withMtime.sort((a, b) => (b['page/mtime'] || 0) - (a['page/mtime'] || 0));
    const recentPages = withMtime.slice(0, 8);

    // Pins
    const pins = getPins();
    const pinnedPages = pins.map(pinTitle =>
      pages.find(p => (p['page/title'] || p.title || '') === pinTitle)
    ).filter(Boolean);

    const nav = document.getElementById('sidebar-nav');
    let html = '';

    // ── Pinned section ──
    if (pinnedPages.length > 0) {
      html += `<div class="sb-section" id="sb-pinned">
        <div class="sb-header"><span class="sb-chevron">▾</span><span class="sb-label">Pinned</span><span class="sb-count">${pinnedPages.length}</span></div>
        <div class="sb-body"><ul class="sb-list">`;
      for (const p of pinnedPages) {
        html += buildPageItem(p['page/title'] || p.title || '');
      }
      html += '</ul></div></div>';
    } else {
      html += `<div class="sb-section" id="sb-pinned">
        <div class="sb-header"><span class="sb-chevron">▾</span><span class="sb-label">Pinned</span></div>
        <div class="sb-body"><div class="sb-empty">Right-click any page to pin it</div></div>
      </div>`;
    }

    // ── Recent section ──
    const nowMs = Date.now();
    html += `<div class="sb-section" id="sb-recent">
      <div class="sb-header"><span class="sb-chevron">▾</span><span class="sb-label">Recent</span><span class="sb-count">${recentPages.length}</span></div>
      <div class="sb-body"><ul class="sb-list">`;
    if (recentPages.length === 0) {
      html += '<li style="padding:0.3rem 1rem;color:var(--text-faint);font-size:0.8rem">No recent pages</li>';
    } else {
      for (const p of recentPages) {
        const title = p['page/title'] || p.title || '';
        const mtime = p['page/mtime'] || 0;
        const hoursAgo = (nowMs - mtime) / 3600000;
        html += buildRecentItem(title, mtime, hoursAgo);
      }
    }
    html += '</ul></div></div>';

    // ── Pages section — browse pointer (flat list retired: 85% ghost refs) ──
    const regularCount = regularPages.length;
    const realCount = regularPages.filter(p => p['page/file']).length;
    const ghostCount = regularCount - realCount;
    const journalCount = journals.length;
    const systemCount = systemPages.length;
    html += `<div class="sb-section" id="sb-browse">
      <div class="sb-header"><span class="sb-chevron">▾</span><span class="sb-label">Pages</span><span class="sb-count">${realCount}</span></div>
      <div class="sb-body">
        <ul class="sb-list">
          <li class="sb-page-item"><a class="sb-page-link" data-browse="library"><span>browse library</span><span class="tag-count">→</span></a></li>
        </ul>
        <div class="sb-empty">${ghostCount} ghost refs omitted — search reaches them</div>
      </div>
    </div>`;

    // ── Journals section (hoisted from old All Pages) ──
    if (journalCount > 0) {
      html += `<div class="sb-section collapsed" id="sb-journals">
        <div class="sb-header"><span class="sb-chevron">▾</span><span class="sb-label">Journals</span><span class="sb-count">${journalCount}</span></div>
        <div class="sb-body"><ul class="sb-list">`;
      for (const p of journals) {
        html += buildPageItem(p['page/title'] || p.title || '');
      }
      html += '</ul></div></div>';
    }

    // ── System section (cron output, hoisted, collapsed) ──
    if (systemCount > 0) {
      html += `<div class="sb-section collapsed" id="sb-system">
        <div class="sb-header"><span class="sb-chevron">▾</span><span class="sb-label">System</span><span class="sb-count">${systemCount}</span></div>
        <div class="sb-body"><ul class="sb-list">`;
      for (const p of systemPages) {
        html += buildPageItem(p['page/title'] || p.title || '');
      }
      html += '</ul></div></div>';
    }

    // ── Tags section ──
    const tags = (tagsData.tags || []).sort((a, b) => b.count - a.count).slice(0, 30);
    html += `<div class="sb-section" id="sb-tags">
      <div class="sb-header"><span class="sb-chevron">▾</span><span class="sb-label">Tags</span><span class="sb-count">${tags.length}</span></div>
      <div class="sb-body"><ul class="sb-list">`;
    if (tags.length === 0) {
      html += '<li style="padding:0.3rem 1rem;color:var(--text-faint);font-size:0.8rem">No tags yet</li>';
    } else {
      for (const t of tags) {
        let displayName = t.name.replace(/\[\[|\]\]/g, '');
        html += `<li class="sb-page-item tag-item">
          <a class="sb-page-link" data-tag="${escapeAttr(t.name)}"><span>${escapeHtml(displayName)}</span><span class="tag-count">${t.count}</span></a>
        </li>`;
      }
    }
    html += '</ul></div></div>';

    nav.innerHTML = html;

    // ── Wire push notification toggle (button is in static HTML) ──
    const pushBtn = document.getElementById('sb-push-toggle');
    if (pushBtn) {
      const pushEnabled = localStorage.getItem('pushEnabled') === 'true';
      if (pushEnabled) pushBtn.classList.add('active');
      pushBtn.querySelector('.sb-push-label').textContent = pushEnabled ? 'Notifications on' : 'Notifications off';
      pushBtn.addEventListener('click', () => togglePushNotifications(pushBtn));
    }

    // ── Wire all interactions ──

    // Wire page item clicks + right-click + pin buttons
    nav.querySelectorAll('.sb-page-item[data-page-title]').forEach(wireSidebarItem);

    // Wire tag item clicks
    nav.querySelectorAll('.tag-item a').forEach(a => {
      a.addEventListener('click', () => loadTagPage(a.getAttribute('data-tag')));
    });

    // Wire browse links (library / graph pointers)
    nav.querySelectorAll('a[data-browse]').forEach(a => {
      a.addEventListener('click', () => {
        if (a.getAttribute('data-browse') === 'graph') loadGraphView();
        else loadLibraryView();
      });
    });

    // Wire section collapse/expand
    nav.querySelectorAll('.sb-section').forEach(section => {
      const header = section.querySelector(':scope > .sb-header');
      if (header) wireSectionCollapse(header, section);
    });

    // Store pages for later reference
    allPages = pages;

  } catch (e) {
    console.error('Sidebar load failed:', e);
  }
}

// ─── Push Notifications ────────────────────────────────────────

const VAPID_PUBLIC_KEY = 'BLicFjCWKe3eEEC3FfiPitCSAu_M9wG3wHk_jKU_4e5CRB5n6DfyMD9fXCMfZLIhMR73o6j-W4sL0frXz8z0Yps';

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(b64);
  return Uint8Array.from(rawData, c => c.charCodeAt(0));
}

async function togglePushNotifications(btn) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Push notifications not supported in this browser');
    return;
  }

  const enabled = localStorage.getItem('pushEnabled') === 'true';

  if (enabled) {
    // Unsubscribe
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await sub.unsubscribe();
          await fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
        }
      }
      localStorage.setItem('pushEnabled', 'false');
      btn.classList.remove('active');
      btn.querySelector('.sb-push-label').textContent = 'Notifications off';
    } catch (e) {
      console.error('Unsubscribe failed:', e);
    }
  } else {
    // Subscribe
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        btn.querySelector('.sb-push-label').textContent = 'Denied';
        return;
      }

      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });

      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });

      localStorage.setItem('pushEnabled', 'true');
      btn.classList.add('active');
      btn.querySelector('.sb-push-label').textContent = 'Notifications on';
    } catch (e) {
      console.error('Subscribe failed:', e);
      btn.querySelector('.sb-push-label').textContent = 'Error';
    }
  }
}

// ─── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initCtxMenu();
  loadSidebar();
  initComposeBar();
  initSlashMenu();
  loadSlashTemplates();

  // Mobile menu toggle
  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  // Close sidebar when tapping outside (backdrop)
  document.getElementById('content').addEventListener('click', (e) => {
    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('open') && e.target.closest('#content') && !e.target.closest('#sidebar')) {
      sidebar.classList.remove('open');
    }
  });

  // Sidebar Journal button
  document.getElementById('btn-sidebar-journal').addEventListener('click', () => {
    loadJournalTimeline();
    document.getElementById('sidebar').classList.remove('open');
  });

  document.getElementById('btn-sidebar-library').addEventListener('click', () => {
    loadLibraryView();
  });

  document.getElementById('btn-sidebar-graph').addEventListener('click', () => {
    loadGraphView();
  });

  // Search with debounce
  let searchTimer;
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(searchInput.value), 300);
  });

  // Hash routing — deep links like your-domain.com/#/Gift Ideas
  // Also handles #/tag/tagname and #/Page?b=BlockId
  // Handle back/forward
  window.addEventListener('popstate', (e) => {
    const route = hashRoute();
    if (!route) { loadDefaultPage(); return; }
    if (route.type === 'view') {
      if (route.name === 'library') loadLibraryView();
      else if (route.name === 'graph') loadGraphView();
      else loadDefaultPage();
    } else if (route.type === 'tag') {
      loadTagPage(route.name);
    } else {
      loadPage(route.name, {fromHash: true});
    }
  });

  // Load page from URL hash, or default to journal.
  // Rule: a fresh visit to your-domain.com (no hash, or typed URL) → journal.
  // Deep links (someone shares your-domain.com/#/SomePage) work on first visit.
  // Reloads always go to journal — ignore stale hash from previous session.
  // Uses sessionStorage to detect "already been here this tab".
  const route = hashRoute();
  const visited = sessionStorage.getItem('notes-visited');
  if (route && !visited) {
    // First visit this tab with a hash — could be a shared deep link
    sessionStorage.setItem('notes-visited', '1');
    if (route.type === 'view') {
      if (route.name === 'library') loadLibraryView();
      else if (route.name === 'graph') loadGraphView();
      else loadDefaultPage();
    } else if (route.type === 'tag') {
      loadTagPage(route.name);
    } else {
      loadPage(route.name, {fromHash: true});
    }
  } else if (route && visited) {
    // Reload with a stale hash — go to journal instead
    loadDefaultPage();
  } else {
    loadDefaultPage();
  }
});

// ─── Journal Timeline ─────────────────────────────────────────
// Default view: unified timeline of all journal entries, latest first.
// Fetches 7 days at a time, with "load more" for pagination.
let journalTimelineOffset = 0;
const JOURNAL_PAGE_SIZE = 7;

async function loadJournalTimeline(append = false) {
  const content = document.getElementById('content');

  if (!append) {
    content.innerHTML = '<div class="empty-state">Loading…</div>';
    journalTimelineOffset = 0;
  }

  try {
    // Get all pages, filter for strict YYYY_MM_DD journal format
    const pagesData = await api('/pages');
    const allTitles = (pagesData.pages || [])
      .map(p => p['page/title'] || p.title || '')
      .filter(name => /^\d{4}_\d{2}_\d{2}$/.test(name));
    const uniqueDates = [...new Set(allTitles)].sort((a, b) => b.localeCompare(a));

    // Get the slice for this page
    const slice = uniqueDates.slice(journalTimelineOffset, journalTimelineOffset + JOURNAL_PAGE_SIZE);

    if (slice.length === 0 && !append) {
      content.innerHTML = `
        <div class="page-header"><div class="page-title">Journal</div></div>
        <div class="empty-state"><p>No entries yet. Start writing below.</p></div>`;
      currentPage = '__journal__';
      updateComposeContext(todayJournalPage(), true);
      return;
    }

    // Fetch all journal pages in parallel
    const results = await Promise.all(
      slice.map(date => api('/page/' + encodeURIComponent(date)).catch(() => null))
    );

    // Build HTML for this batch
    let batchHtml = '';
    for (let i = 0; i < results.length; i++) {
      const data = results[i];
      if (!data) continue;
      const date = slice[i];
      const match = date.match(/^(\d{4})_(\d{2})_(\d{2})$/);
      if (!match) continue;
      const [, y, m, d] = match;
      const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
      const prettyDate = `${months[parseInt(m)-1]} ${parseInt(d)}, ${y}`;
      const blocks = data.blocks || [];
      if (blocks.length === 0) continue;

      batchHtml += `<div class="journal-day" data-date="${escapeAttr(date)}">`;
      batchHtml += `<div class="journal-date-header"><a data-page="${escapeAttr(date)}">${escapeHtml(prettyDate)}</a></div>`;
      batchHtml += `<div class="blocks">${renderBlocks(blocks, date)}</div>`;
      batchHtml += '</div>';
    }

    // "Load more" button
    const newOffset = journalTimelineOffset + slice.length;
    const hasMore = newOffset < uniqueDates.length;
    let loadMoreHtml = hasMore
      ? `<div class="load-more"><button id="btn-load-more">Load older entries</button></div>`
      : '';

    if (!append) {
      let html = '<div class="page-header"><div class="page-title">Journal</div></div>';
      html += '<div class="journal-timeline">' + batchHtml + loadMoreHtml + '</div>';
      content.innerHTML = html;
    } else {
      // Remove old "load more" button, append new batch
      const oldBtn = content.querySelector('.load-more');
      if (oldBtn) oldBtn.remove();
      const timeline = content.querySelector('.journal-timeline');
      if (timeline) {
        timeline.insertAdjacentHTML('beforeend', batchHtml + loadMoreHtml);
      }
    }

    journalTimelineOffset = newOffset;

    // Update state
    currentPage = '__journal__';
    updateComposeContext(todayJournalPage(), true);
    if (location.hash) {
      history.pushState({page: '__journal__'}, '', '#/');
    }
    document.querySelectorAll('.sb-page-link').forEach(a => a.classList.remove('active'));
    const jBtn = document.getElementById('btn-sidebar-journal');
    if (jBtn) jBtn.classList.add('active');
    document.getElementById('sidebar').classList.remove('open');

    // Wire interactions
    wirePageRefs();
    wireBlockInterstials();
    wireTagClicks();

    // Wire date header clicks → individual day view
    content.querySelectorAll('.journal-date-header a').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        loadPage(a.getAttribute('data-page'));
      });
    });

    // Wire "load more" button
    const loadMoreBtn = document.getElementById('btn-load-more');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => loadJournalTimeline(true));
    }
  } catch (e) {
    if (!append) {
      content.innerHTML = `<div class="empty-state"><h2>Couldn't load journal</h2><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
}

// Default view: journal timeline
function loadDefaultPage() {
  loadJournalTimeline();
}

// Parse hash into a route: {type: 'page'|'tag', name: string}
// Supports: #/Page Name, #/Page Name?b=BlockId, #/tag/tagname
function hashRoute() {
  const hash = location.hash;
  if (!hash || hash.length < 2) return null;
  let raw = hash.replace(/^#\//, '').split('?')[0];
  if (raw.startsWith('tag/')) {
    return {type: 'tag', name: decodeURIComponent(raw.substring(4))};
  }
  if (raw.startsWith('view/')) {
    return {type: 'view', name: decodeURIComponent(raw.substring(5))};
  }
  return {type: 'page', name: decodeURIComponent(raw)};
}

// Parse #/Page Name from URL, return page name or null
// Also supports ?b=Block-ID for deep linking to specific blocks
function hashToPage() {
  const r = hashRoute();
  return (r && r.type === 'page') ? r.name : null;
}

// Extract ?b=Block-ID from URL hash for deep linking
function hashToBlockId() {
  const hash = location.hash;
  if (!hash) return null;
  const match = hash.match(/[?&]b=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Scroll to and highlight a specific block by block-id
function scrollToBlock(blockId) {
  if (!blockId) return;
  // Try data-block-id first
  let el = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
  if (!el) {
    // Fallback: try sanitized id
    const sanitized = blockId.replace(/[^a-zA-Z0-9-]/g, '_');
    el = document.getElementById('blk-' + sanitized);
  }
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('block-highlight');
    // Click anywhere else to dismiss
    const dismiss = () => {
      el.classList.remove('block-highlight');
      document.removeEventListener('click', dismiss);
    };
    setTimeout(() => document.addEventListener('click', dismiss), 500);
  }
}

// ── New Page Wizard ──
(function initNewPageWizard() {
  const modal      = document.getElementById('new-page-modal');
  const titleInput = document.getElementById('new-page-title');
  const propsDiv   = document.getElementById('new-page-props');
  const tmplSelect = document.getElementById('new-page-template');
  const errorDiv   = document.getElementById('new-page-error');
  const createBtn  = document.getElementById('new-page-create');
  const cancelBtn  = document.getElementById('new-page-cancel');
  const closeBtn   = document.getElementById('new-page-close');
  const addPropBtn = document.getElementById('new-page-add-prop');
  const overlay    = modal.querySelector('.modal-overlay');

  function show() {
    modal.classList.remove('hidden');
    errorDiv.classList.add('hidden');
    titleInput.value = '';
    titleInput.focus();
    // Clear dynamic properties
    propsDiv.innerHTML = '';
    // Fetch properties schema + templates in parallel
    Promise.all([
      fetch(API + '/properties-schema').then(r => r.json()).catch(() => ({properties: []})),
      fetch(API + '/templates').then(r => r.json()).catch(() => ({templates: []}))
    ]).then(([schemaData, tmplData]) => {
      // Populate template dropdown
      const currentTmpl = tmplSelect.value;
      tmplSelect.innerHTML = '<option value="">— none —</option>';
      for (const t of (tmplData.templates || [])) {
        const opt = document.createElement('option');
        opt.value = t.name;
        opt.textContent = t.name + (t.page ? ` (${t.page})` : '');
        tmplSelect.appendChild(opt);
      }
      if (currentTmpl) tmplSelect.value = currentTmpl;
    });
  }

  function hide() {
    modal.classList.add('hidden');
    propsDiv.innerHTML = '';
    titleInput.value = '';
    errorDiv.classList.add('hidden');
  }

  function addPropRow(key = '', val = '') {
    const row = document.createElement('div');
    row.className = 'prop-row';
    row.innerHTML = `
      <input type="text" class="prop-key" placeholder="key" value="${escHtml(key)}">
      <input type="text" class="prop-val" placeholder="value" value="${escHtml(val)}">
      <button class="prop-remove" title="Remove">&times;</button>
    `;
    row.querySelector('.prop-remove').addEventListener('click', () => row.remove());
    propsDiv.appendChild(row);
    row.querySelector(key ? '.prop-val' : '.prop-key').focus();
  }

  function getProperties() {
    const props = {};
    for (const row of propsDiv.querySelectorAll('.prop-row')) {
      const k = row.querySelector('.prop-key').value.trim();
      const v = row.querySelector('.prop-val').value.trim();
      if (k) props[k] = v;
    }
    return props;
  }

  async function createPage() {
    const title = titleInput.value.trim();
    if (!title) {
      errorDiv.textContent = 'Title is required.';
      errorDiv.classList.remove('hidden');
      titleInput.focus();
      return;
    }
    errorDiv.classList.add('hidden');
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    try {
      const properties = getProperties();
      const template = tmplSelect.value || null;
      // POST body as EDN
      let body = '{:title "' + ednEscape(title) + '"';
      if (Object.keys(properties).length > 0) {
        body += ' :properties {';
        for (const [k, v] of Object.entries(properties)) {
          body += ' "' + ednEscape(k) + '" "' + ednEscape(v) + '"';
        }
        body += '}';
      }
      if (template) {
        body += ' :template "' + ednEscape(template) + '"';
      }
      body += '}';

      const resp = await fetch(API + '/create-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/edn' },
        body: body
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        errorDiv.textContent = data.error || 'Failed to create page.';
        errorDiv.classList.remove('hidden');
        createBtn.disabled = false;
        createBtn.textContent = 'Create Page';
        return;
      }
      // Success — close modal, navigate to new page
      hide();
      const pageUrl = '#/' + encodeURIComponent(data.title);
      window.location.hash = pageUrl;
      refreshSidebar();
    } catch (e) {
      errorDiv.textContent = 'Network error: ' + e.message;
      errorDiv.classList.remove('hidden');
    }
    createBtn.disabled = false;
    createBtn.textContent = 'Create Page';
  }

  function ednEscape(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // Wire events
  document.getElementById('btn-new-page').addEventListener('click', show);
  cancelBtn.addEventListener('click', hide);
  closeBtn.addEventListener('click', hide);
  overlay.addEventListener('click', hide);
  addPropBtn.addEventListener('click', () => addPropRow());
  createBtn.addEventListener('click', createPage);
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createPage();
    if (e.key === 'Escape') hide();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) hide();
  });
})();

// ═══ Library View ═════════════════════════════════════════════
let libraryCache = null;
let libFilterTag = null;
let libSortMode = 'recent';
let libFilterText = '';

function libBadTag(t) {
  return !t || /["\\\n]/.test(t) || t.length > 28;
}

function setActiveSidebarView(view) {
  document.querySelectorAll('.sb-page-link').forEach(a => a.classList.remove('active'));
  const map = { journal: 'btn-sidebar-journal', library: 'btn-sidebar-library', graph: 'btn-sidebar-graph' };
  Object.keys(map).forEach(k => {
    const btn = document.getElementById(map[k]);
    if (btn) btn.classList.toggle('active', k === view);
  });
}

function libTopTags(pages) {
  const freq = {};
  pages.forEach(p => (p.tags || []).filter(t => !libBadTag(t)).forEach(t => { freq[t] = (freq[t] || 0) + 1; }));
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 14);
}

async function loadLibraryView() {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty-state">Loading library…</div>';
  currentPage = '__library__';
  history.pushState({ page: '__library__' }, '', '#/view/library');
  updateComposeContext(todayJournalPage(), true);
  document.getElementById('sidebar').classList.remove('open');
  try {
    if (!libraryCache) libraryCache = await api('/library');
    const pages = (libraryCache.pages || []).filter(p => p.title);
    const topTags = libTopTags(pages);
    content.innerHTML = `
      <div class="page-header"><div class="page-title">Library</div>
        <div class="lib-count">${pages.length} pages</div></div>
      <div class="lib-toolbar">
        <input id="lib-filter" class="lib-filter" type="search" placeholder="filter titles…" value="${escapeAttr(libFilterText)}" autocomplete="off">
        <div class="lib-sort">
          <button class="sort-pill ${libSortMode === 'recent' ? 'active' : ''}" data-sort="recent">Recent</button>
          <button class="sort-pill ${libSortMode === 'alpha' ? 'active' : ''}" data-sort="alpha">A–Z</button>
        </div>
      </div>
      <div class="lib-chips" id="lib-chips"></div>
      <div class="lib-grid" id="lib-grid"></div>`;
    renderLibChips(topTags);
    renderLibGrid(pages);
    content.querySelectorAll('.sort-pill').forEach(b => b.addEventListener('click', () => {
      libSortMode = b.dataset.sort;
      content.querySelectorAll('.sort-pill').forEach(x => x.classList.toggle('active', x === b));
      renderLibGrid((libraryCache.pages || []).filter(p => p.title));
    }));
    const libFilterInput = document.getElementById('lib-filter');
    if (libFilterInput) libFilterInput.addEventListener('input', () => {
      libFilterText = libFilterInput.value.trim();
      renderLibGrid((libraryCache.pages || []).filter(p => p.title));
    });
    setActiveSidebarView('library');
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><h2>Couldn't load library</h2><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderLibChips(topTags) {
  const chipsEl = document.getElementById('lib-chips');
  if (!chipsEl) return;
  let html = `<button class="chip ${!libFilterTag ? 'active' : ''}" data-tag="">All</button>`;
  topTags.forEach(([t, n]) => {
    html += `<button class="chip ${libFilterTag === t ? 'active' : ''}" data-tag="${escapeAttr(t)}">${escapeHtml(t)} <span class="chip-n">${n}</span></button>`;
  });
  chipsEl.innerHTML = html;
  chipsEl.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    libFilterTag = c.dataset.tag || null;
    renderLibChips(topTags);
    renderLibGrid((libraryCache.pages || []).filter(p => p.title));
  }));
}

function renderLibGrid(pages) {
  const grid = document.getElementById('lib-grid');
  if (!grid) return;
  let list = pages;
  if (libFilterTag) list = list.filter(p => (p.tags || []).includes(libFilterTag));
  if (libFilterText) {
    const q = libFilterText.toLowerCase();
    list = list.filter(p => p.title.toLowerCase().includes(q) || (p.snippet || '').toLowerCase().includes(q));
  }
  list = list.slice().sort((a, b) => {
    if (libSortMode === 'alpha') return a.title.localeCompare(b.title);
    return (b.mtime || 0) - (a.mtime || 0);
  });
  const cardHtml = (p) => {
    const tags = (p.tags || []).filter(t => !libBadTag(t)).slice(0, 3)
      .map(t => `<button class="tag-chip" data-tag="${escapeAttr(t)}">${escapeHtml(t)}</button>`).join('');
    const time = p.mtime ? relativeTime(p.mtime) : '';
    return `<div class="lib-card" data-page="${escapeAttr(p.title)}">
      <div class="lib-card-title">${escapeHtml(p.title)}</div>
      ${p.snippet ? `<div class="lib-snippet">${escapeHtml(p.snippet)}</div>` : ''}
      <div class="lib-card-meta">${tags ? `<span class="lib-tags">${tags}</span>` : ''}${time ? `<span class="lib-time">${time}</span>` : ''}</div>
    </div>`;
  };
  let inner;
  if (libSortMode === 'alpha' && list.length) {
    const groups = new Map();
    for (const p of list) {
      const L = (p.title.trim()[0] || '#').toUpperCase();
      const key = /[A-Z]/.test(L) ? L : '#';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    inner = [...groups.entries()].map(([key, cards]) =>
      `<div class="lib-letter">${key}<span class="lib-letter-n">${cards.length}</span></div>` +
      cards.map(cardHtml).join('')
    ).join('');
  } else {
    inner = list.map(cardHtml).join('');
  }
  grid.innerHTML = inner || '<div class="empty-state">No pages match this filter.</div>';
  grid.querySelectorAll('.lib-card').forEach(c => c.addEventListener('click', (e) => {
    if (e.target.closest('.tag-chip')) return;
    loadPage(c.dataset.page);
  }));
  grid.querySelectorAll('.tag-chip').forEach(c => c.addEventListener('click', (e) => {
    e.stopPropagation();
    loadTagPage(c.dataset.tag);
  }));
}

// ═══ Graph View ═══════════════════════════════════════════════
async function loadGraphView() {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty-state">Loading graph…</div>';
  currentPage = '__graph__';
  history.pushState({ page: '__graph__' }, '', '#/view/graph');
  updateComposeContext(todayJournalPage(), true);
  document.getElementById('sidebar').classList.remove('open');
  try {
    const data = await api('/graph');
    if (!data.nodes || !data.nodes.length) {
      content.innerHTML = '<div class="empty-state"><p>No connected pages yet — link pages with [[double brackets]] or #tags.</p></div>';
      setActiveSidebarView('graph');
      return;
    }
    content.innerHTML = `
      <div class="page-header"><div class="page-title">Graph</div>
        <div class="lib-count">${data.nodes.length} pages · ${data.edges.length} links</div></div>
      <div class="graph-wrap"><canvas id="graph-canvas"></canvas>
        <div class="graph-hint">drag: pan · scroll: zoom · drag node: pin · click node: open</div>
      </div>`;
    setActiveSidebarView('graph');
    runForceGraph(document.getElementById('graph-canvas'), data);
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><h2>Couldn't load graph</h2><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function runForceGraph(canvas, data) {
  const ctx = canvas.getContext('2d');
  const N_BG = '#0f1116', N_NODE = '#7c6ef0', N_HUB = '#b7adf7', N_HI = '#ffffff';
  const E_DIM = 'rgba(124,110,240,0.10)', E_HI = 'rgba(183,173,247,0.55)';
  const LABEL = 'rgba(224,224,230,0.85)';

  const nodes = data.nodes.map((n, i) => ({
    title: n.title, degree: n.degree,
    x: Math.cos(i / data.nodes.length * Math.PI * 2) * (160 + i * 1.2),
    y: Math.sin(i / data.nodes.length * Math.PI * 2) * (160 + i * 1.2),
    vx: 0, vy: 0, fx: null, fy: null
  }));
  const idx = new Map(nodes.map((n, i) => [n.title, i]));
  const adj = nodes.map(() => []);
  data.edges.forEach(([a, b]) => {
    const ia = idx.get(a), ib = idx.get(b);
    if (ia !== undefined && ib !== undefined) { adj[ia].push(ib); adj[ib].push(ia); }
  });

  let scale = 1, ox = 0, oy = 0, alpha = 1;
  let hoverIdx = null, dragIdx = null, panning = false, moved = 0;
  let lastX = 0, lastY = 0, fitted = false;

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
  }
  resize();
  window.addEventListener('resize', () => { resize(); requestDraw(); });

  function physics() {
    const N = nodes.length;
    const REP = 2600, SPRING = 0.006, LEN = 95, GRAV = 0.04, DAMP = 0.85;
    for (let i = 0; i < N; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < N; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        const f = REP / d2;
        const fx = dx / d * f, fy = dy / d * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }
    for (let i = 0; i < N; i++) {
      const a = nodes[i];
      adj[i].forEach(j => {
        const b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const f = (d - LEN) * SPRING;
        a.vx += dx / d * f; a.vy += dy / d * f;
      });
    }
    for (const n of nodes) {
      n.vx -= n.x * GRAV; n.vy -= n.y * GRAV;
      if (n.fx !== null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; continue; }
      n.vx *= DAMP; n.vy *= DAMP;
      n.x += n.vx * alpha; n.y += n.vy * alpha;
    }
    alpha = Math.max(0, alpha - 0.004);
  }

  function fitView() {
    const r = canvas.getBoundingClientRect();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(n => {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    });
    const pad = 70;
    const sx = (r.width - pad * 2) / Math.max(1, maxX - minX);
    const sy = (r.height - pad * 2) / Math.max(1, maxY - minY);
    scale = Math.min(sx, sy, 1.6);
    ox = r.width / 2 - (minX + maxX) / 2 * scale;
    oy = r.height / 2 - (minY + maxY) / 2 * scale;
  }

  function nodeRadius(n) { return 3 + Math.sqrt(n.degree) * 2.2; }
  function toScreen(n) { return { x: n.x * scale + ox, y: n.y * scale + oy }; }
  function toWorld(sx, sy) { return { x: (sx - ox) / scale, y: (sy - oy) / scale }; }

  function hit(sx, sy) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const p = toScreen(nodes[i]);
      const r = Math.max(8, nodeRadius(nodes[i]) * scale + 3);
      const dx = p.x - sx, dy = p.y - sy;
      if (dx * dx + dy * dy <= r * r) return i;
    }
    return null;
  }

  function draw() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = N_BG;
    ctx.fillRect(0, 0, r.width, r.height);

    // edges
    ctx.lineWidth = 1;
    for (const [a, b] of data.edges) {
      const ia = idx.get(a), ib = idx.get(b);
      if (ia === undefined || ib === undefined) continue;
      const hi = hoverIdx !== null && (ia === hoverIdx || ib === hoverIdx);
      if (hoverIdx !== null && !hi) continue;
      const pa = toScreen(nodes[ia]), pb = toScreen(nodes[ib]);
      ctx.strokeStyle = hi ? E_HI : E_DIM;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    // neighbor set for dimming
    let nbrs = null;
    if (hoverIdx !== null) { nbrs = new Set([hoverIdx, ...adj[hoverIdx]]); }

    // nodes
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const p = toScreen(n);
      if (p.x < -40 || p.y < -40 || p.x > r.width + 40 || p.y > r.height + 40) continue;
      const rad = nodeRadius(n) * scale;
      const dimmed = nbrs && !nbrs.has(i);
      ctx.globalAlpha = dimmed ? 0.15 : 1;
      ctx.fillStyle = i === hoverIdx ? N_HI : (n.degree >= 8 ? N_HUB : N_NODE);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, rad), 0, Math.PI * 2);
      ctx.fill();
      // every node gets a label - hubs slightly larger
      ctx.font = (n.degree >= 8 ? '12px' : '10.5px') + ' "JetBrains Mono", monospace';
      ctx.globalAlpha = dimmed ? 0.15 : 0.9;
      ctx.fillStyle = i === hoverIdx ? N_HI : LABEL;
      ctx.textAlign = 'center';
      const t = n.title.length > 26 ? n.title.slice(0, 24) + '…' : n.title;
      ctx.fillText(t, p.x, p.y - Math.max(6, rad + 5));
    }
    ctx.globalAlpha = 1;
  }

  // settle the layout headless BEFORE first paint, then render statically
  // (no bounce animation - layout is instant and still)
  for (let t = 0; t < 450; t++) physics();
  fitView();
  fitted = true;
  draw();  // initial paint — no interaction needed

  // coalesced redraw - only on interaction, never on a timer
  function requestDraw() {
    if (requestDraw._queued) return;
    requestDraw._queued = true;
    requestAnimationFrame(() => { requestDraw._queued = false; draw(); });
  }

  function localXY(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ── multi-touch aware pointer handling (pinch to zoom, v0.0.37) ──
  const activePtrs = new Map(); // pointerId -> {x, y}
  let pinchPrev = null;         // {dist, mx, my} from previous pinch move

  function ptrDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function beginDragOrPan(x, y) {
    lastX = x; lastY = y; moved = 0;
    dragIdx = hit(x, y);
    panning = dragIdx === null;
    if (dragIdx !== null) {
      const w = toWorld(x, y);
      nodes[dragIdx].fx = w.x; nodes[dragIdx].fy = w.y;
      alpha = Math.max(alpha, 0.3);
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = localXY(e);
    activePtrs.set(e.pointerId, { x, y });
    if (activePtrs.size === 2) {
      // second finger down -> pinch mode; cancel any drag/pan in progress
      if (dragIdx !== null) { nodes[dragIdx].fx = null; nodes[dragIdx].fy = null; dragIdx = null; }
      panning = false;
      const pts = [...activePtrs.values()];
      pinchPrev = {
        dist: ptrDist(pts[0], pts[1]),
        mx: (pts[0].x + pts[1].x) / 2,
        my: (pts[0].y + pts[1].y) / 2
      };
      return;
    }
    if (activePtrs.size > 2) return; // ignore extra fingers
    beginDragOrPan(x, y);
    requestDraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    const { x, y } = localXY(e);
    if (activePtrs.has(e.pointerId)) activePtrs.set(e.pointerId, { x, y });

    // pinch: two pointers -> pan by midpoint delta, zoom by distance ratio
    if (pinchPrev && activePtrs.size >= 2) {
      const pts = [...activePtrs.values()];
      const dist = ptrDist(pts[0], pts[1]);
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      ox += mx - pinchPrev.mx;
      oy += my - pinchPrev.my;
      if (pinchPrev.dist > 0) {
        const factor = dist / pinchPrev.dist;
        const ns = Math.min(4, Math.max(0.15, scale * factor));
        const k = ns / scale;
        ox = mx - (mx - ox) * k;
        oy = my - (my - oy) * k;
        scale = ns;
      }
      pinchPrev = { dist: dist, mx: mx, my: my };
      requestDraw();
      return;
    }

    if (dragIdx !== null) {
      const w = toWorld(x, y);
      nodes[dragIdx].fx = w.x; nodes[dragIdx].fy = w.y;
      moved += Math.abs(x - lastX) + Math.abs(y - lastY);
    } else if (panning) {
      ox += x - lastX; oy += y - lastY;
      moved += Math.abs(x - lastX) + Math.abs(y - lastY);
    } else {
      const h = hit(x, y);
      if (h !== hoverIdx) { hoverIdx = h; canvas.style.cursor = h !== null ? 'pointer' : 'grab'; }
    }
    lastX = x; lastY = y;
    requestDraw();
  });

  function endPtr(e) {
    activePtrs.delete(e.pointerId);
    if (activePtrs.size < 2) pinchPrev = null;
    if (activePtrs.size === 1) {
      // one finger remains after a pinch -> it pans (suppress click)
      const rem = [...activePtrs.values()][0];
      lastX = rem.x; lastY = rem.y;
      moved = 10;
      dragIdx = null;
      panning = true;
      return;
    }
    if (activePtrs.size > 0) return;
    // last pointer lifted -> click detection
    const { x, y } = localXY(e);
    if (dragIdx !== null) {
      if (moved < 6) {
        loadPage(nodes[dragIdx].title);
      } else {
        nodes[dragIdx].fx = null; nodes[dragIdx].fy = null; // release pin
      }
    } else if (panning && moved < 6) {
      const h = hit(x, y);
      if (h !== null) loadPage(nodes[h].title);
    }
    dragIdx = null; panning = false;
    requestDraw();
  }

  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { x, y } = localXY(e);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.min(4, Math.max(0.15, scale * factor));
    ox = x - (x - ox) * (ns / scale);
    oy = y - (y - oy) * (ns / scale);
    scale = ns;
    requestDraw();
  }, { passive: false });
}
