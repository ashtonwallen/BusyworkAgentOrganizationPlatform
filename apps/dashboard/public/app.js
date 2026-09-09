import {orders} from './pages/orders.js';
import {editBusinessEntity,emailPage,connectEmail,syncEmail,composeEmail,showEmail,emailSettings} from './pages/email.js';
import {prepareRelease,showRelease,showDeployment} from './pages/releases.js';
import {updateChat,removeChat} from './panels/chat.js';
import {dismissFailures} from './lib/alerts.js';
import { documents, showDocument, editDocument, downloadDocument, searchDocuments } from './pages/documents.js';
import { state, root, modal, pendingCount } from './lib/state.js';
import { api, toast, download, setUnauthorizedHandler } from './lib/api.js';
import { icon } from './lib/icons.js';
import { esc, titleCase, money } from './lib/format.js';
import { ctx } from './lib/context.js';
import { applyTheme, setTheme, setMode } from './lib/theme.js';
import { openModal, closeModal } from './lib/modal.js';

import { overview } from './pages/overview.js';
import { conversations } from './pages/conversations.js';
import { work } from './pages/work.js';
import { opportunities } from './pages/opportunities.js';
import { inbox } from './pages/inbox.js';
import { moneyPage } from './pages/money.js';
import { team } from './pages/team.js';
import { models } from './pages/models.js';
import { log } from './pages/log.js';
import { controls } from './pages/controls.js';

import { showTask, showEmployee, showExperiment, showProposal, showRequest, showMeeting } from './modals/records.js';
import { setDirection, clearDirection, directionHistory } from './modals/direction.js';
import * as forms from './modals/forms.js';

const NAV = [
  ['overview', 'home', 'Overview'],
  ['experiments', 'idea', 'Opportunities'],
  ['orders','work','Orders'],
  ['work', 'work', 'Work'],
  ['inbox', 'inbox', 'Approvals'],
  ['finance', 'finance', 'Money'],
  ['team', 'team', 'Team'],
  ['conversations', 'chat', 'Conversations'],
  ['documents', 'work', 'Documents'],
  ['email','inbox','Email'],
  ['models', 'models', 'Models'],
  ['log', 'log', 'Company log'],
  ['settings', 'settings', 'Controls'],
];

const PAGES = { orders,overview, experiments: opportunities, work, inbox, finance: moneyPage, team, conversations, documents, email:emailPage, models, log, settings: controls };

let busy = false;
let refreshPending = false;
let signInRequired = true;

applyTheme();


// ---------------------------------------------------------------- sign in

function showLogin() {
  removeChat();
  state.data = null;
  root.innerHTML = `<div class="login">
    <section class="login-form">
      <form class="login-box" id="login">
        <div class="brand"><span class="brand-mark">b</span><span class="brand-name">Busywork</span></div>
        <h2>Sign in</h2>
        <p>Your company's control panel. It runs on this machine only.</p>
        <div class="field"><label for="owner-key">Owner access key</label>
          <input id="owner-key" name="token" type="password" autocomplete="current-password" required placeholder="Access key"></div>
        <p class="error-message" id="login-error" role="alert"></p>
        <button class="primary" type="submit">Open dashboard</button>
        <p class="login-foot">The key is in <code>data/owner-token.txt</code>, or whatever you set <code>HIVE_OWNER_TOKEN</code> to. Provider API keys are separate and never leave the server.</p>
      </form>
    </section>
  </div>`;
  document.querySelector('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = e.target.querySelector('button');
    submit.disabled = true;
    try {
      await api('/auth/login', 'POST', { token: new FormData(e.target).get('token') });
      await refresh(true);
    } catch (error) {
      document.querySelector('#login-error').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
}

function sessionExpired() {
  if (!state.data) return showLogin();
  if (document.querySelector('#session-expired')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'session-expired';
  dialog.innerHTML = '<form><h2>Session expired</h2><p>Sign in to continue. Your current page and form are preserved.</p><div class="field"><label for="session-key">Owner access key</label><input id="session-key" name="token" type="password" autocomplete="current-password" required><p class="error-message" role="alert"></p></div><button type="submit" class="primary">Continue</button></form>';
  document.body.append(dialog);
  dialog.addEventListener('cancel', e => e.preventDefault());
  dialog.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const button = dialog.querySelector('button');
    button.disabled = true;
    try {
      await api('/auth/login', 'POST', { token: new FormData(e.target).get('token') });
      dialog.close(); dialog.remove();
      await refresh();
    } catch (error) { dialog.querySelector('.error-message').textContent = error.message; }
    finally { button.disabled = false; }
  });
  dialog.showModal();
}

// ---------------------------------------------------------------- shell

function shell() {
  document.body.classList.remove('drawer-open');
  const d = state.data;
  const pending = pendingCount();
  const active = NAV.find((n) => n[0] === state.page) || NAV[0];
  const status = d.company.status;
  root.innerHTML = `<aside class="sidebar">
    <div class="brand"><span class="brand-mark">b</span><span class="brand-name">Busywork</span></div>
    <button class="drawer-close" data-action="close-menu">Close sections</button>
    <nav class="nav" aria-label="Sections">
      ${NAV.map(([id, name, label]) => `<button data-page="${id}" class="${state.page === id ? 'active' : ''}"${state.page === id ? ' aria-current="page"' : ''}>${icon(name)}${label}${id === 'inbox' && pending ? `<span class="count">${pending}</span>` : ''}</button>`).join('')}
    </nav>
    <div class="sidebar-bottom">
      <div class="owner">
        <div class="avatar">O</div>
        <div>Owner<small>${(d.employees || []).filter((e) => e.status === 'ACTIVE').length} agents working for you</small></div>
        ${signInRequired ? `<button class="quiet small" data-action="logout" title="Sign out" aria-label="Sign out">${icon('arrow')}</button>` : ''}
      </div>
    </div>
  </aside>
  <button class="drawer-scrim" data-action="close-menu" aria-label="Close sections"></button>
  <main class="main">
    <header class="topbar">
      <div class="breadcrumb">
        <button class="mobile-menu" data-action="menu" aria-label="Sections">${icon('menu')}</button>
        <strong>${esc(active[2])}</strong>
      </div>
      <div class="top-actions">
        <span class="timestamp muted">${money(d.metrics.dailyUsedUsd)} spent today</span>
        <button class="state-badge status-${status.toLowerCase()}" data-action="${status === 'RUNNING' ? 'pause' : 'start'}" title="${status === 'RUNNING' ? 'Pause the company' : 'Start the company'}">
          <span class="live-dot ${status === 'RUNNING' ? '' : 'off'}"></span>${titleCase(status)}
        </button>
        <button class="quiet small" data-action="shortcuts" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">${icon('branch')}</button>
        <button class="quiet small ${pending ? 'has-pending' : ''}" data-page="inbox" aria-label="${pending} waiting on you">${icon('bell')}${pending ? `<span class="dot"></span>` : ''}</button>
      </div>
    </header>
    <div class="content" id="content"></div>
  </main>`;
  renderPage();
}

function renderPage() {
  if (hasUnsavedControls()) return;
  const active = NAV.find((n) => n[0] === state.page) || NAV[0];
  document.title = `Busywork — ${active[2]}`;
  const content = document.querySelector('#content');
  const scroller = document.querySelector('.main');
  const scroll = scroller?.scrollTop ?? 0;
  content.innerHTML = (PAGES[state.page] || overview)();
  if (scroller) scroller.scrollTop = scroll;
  bindPageForms();
}

/** Forms that live on a page rather than in a modal. */
function bindPageForms() {
  for (const form of document.querySelectorAll('#budget-form,#policy-form')) {
    const initial = JSON.stringify([...new FormData(form)]);
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    const note = document.createElement('span'); note.className = 'muted'; note.setAttribute('role','status');
    button.before(note);
    form.addEventListener('input', () => {
      const dirty = JSON.stringify([...new FormData(form)]) !== initial;
      form.dataset.dirty = String(dirty); button.disabled = !dirty; note.textContent = dirty ? 'Unsaved changes' : '';
    });
  }
  document.querySelector('#budget-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const values = Object.fromEntries(new FormData(e.target));
      for (const input of e.target.querySelectorAll('input[name]')) {
        if (input.value === input.defaultValue) values[input.name] = state.data.company[input.name];
      }
      await api('/company/budgets', 'PUT', values);
      e.target.dataset.dirty = 'false';
      await refresh(true);
      toast('Limits saved.');
    } catch (error) { toast(error.message); }
  });
  document.querySelector('#policy-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const input of e.target.querySelectorAll('input[type=checkbox]')) body[input.name] = input.checked;
    try {
      await api('/company/approval-policy', 'PUT', body);
      e.target.dataset.dirty = 'false';
      await refresh(true);
      toast('Approval settings saved.');
    } catch (error) { toast(error.message); }
  });
  document.querySelector('#sms-enabled')?.addEventListener('change', async (e) => {
    try {
      await api('/company/approval-policy', 'PUT', { smsEnabled: e.target.checked });
      toast('Text alert preference saved.');
    } catch (error) {
      e.target.checked = !e.target.checked;
      toast(error.message);
    }
  });
}

function hasUnsavedControls() { return !!document.querySelector('#budget-form[data-dirty=true],#policy-form[data-dirty=true]'); }
window.addEventListener('beforeunload', e => { if (hasUnsavedControls()) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- data

async function refresh(force = false) {
  if (busy) { refreshPending ||= force; return; }
  busy = true;
  try {
    const snapshot=await api('/snapshot');
    if(state.data?.businessGeneration!==undefined&&snapshot.businessGeneration!==state.data.businessGeneration){
      // Another tab may have reset the company. Reload clears all module caches,
      // pending reads and in-flight forms, not just the current page's records.
      location.reload();return;
    }
    state.data=snapshot;
    state.connected = true;
    updateChat();
    if (!state.paymentInfo) {
      try { state.paymentInfo = await api('/company/payment-info'); } catch { /* optional */ }
    }
    const editing = document.querySelector('input:focus,textarea:focus,select:focus');
    if ((force || !document.querySelector('#content')) && !hasUnsavedControls()) shell();
    else if (!modal.open && !editing) renderPage();
  } catch (error) {
    state.connected = false;
    if (force) toast(error.message);
  } finally {
    busy = false;
    if (refreshPending) { refreshPending = false; void refresh(true); }
  }
}

ctx.refresh = refresh;
ctx.renderPage = renderPage;
ctx.showLogin = showLogin;
setUnauthorizedHandler(sessionExpired);

// ---------------------------------------------------------------- events

document.addEventListener('change', async e => {
  const caps = e.target.closest('[data-model-caps]');
  if (caps) {
    caps.disabled = true;
    try {
      await api(`/models/${encodeURIComponent(caps.dataset.modelCaps)}/spending-caps`, 'PUT', {enabled:caps.checked});
      await refresh();
      toast(caps.checked ? 'Model spending caps enabled.' : 'Model spending caps disabled. Spending approvals still apply.');
    } catch (error) { caps.checked = !caps.checked; toast(error.message); }
    finally { caps.disabled = false; }
    return;
  }
  const input = e.target.closest('[data-employee-model]');
  if (!input) return;
  const employee = state.data.employees.find(p => p.id === input.dataset.employeeModel);
  const previous = employee?.model_id;
  input.disabled = true;
  try {
    await api(`/employees/${encodeURIComponent(input.dataset.employeeModel)}/model`, 'PUT', {modelId:input.value});
    await refresh();
    toast('Worker model changed. Reserved calls finish on their original model.');
  } catch (error) { input.value = previous; toast(error.message); }
  finally { input.disabled = false; }
});

const RECORD_HANDLERS = {
  task: showTask, employee: showEmployee, experiment: showExperiment,
  proposal: showProposal, request: showRequest, meeting: showMeeting,
};

function showShortcutsModal() {
  openModal('Keyboard Shortcuts', `
    <div class="shortcuts-grid">
      <div class="shortcut-group">
        <h3>Navigation (press <kbd>g</kbd> then key)</h3>
        ${NAV.map(([id,,label]) => `<div class="shortcut-item"><kbd>g</kbd> <kbd>${({orders:'u',overview:'o',experiments:'p',work:'w',inbox:'i',finance:'m',team:'t',conversations:'v',documents:'d',email:'e',models:'r',log:'l',settings:'c'})[id]}</kbd> <span>${esc(label)}</span></div>`).join('')}
      </div>
      <div class="shortcut-group">
        <h3>Inbox & Proposals</h3>
        <div class="shortcut-item"><kbd>j</kbd> <span>Next proposal</span></div>
        <div class="shortcut-item"><kbd>k</kbd> <span>Previous proposal</span></div>
        <div class="shortcut-item"><kbd>Enter</kbd> <span>Review selected proposal</span></div>
        <div class="shortcut-item"><kbd>a</kbd> <span>Quick approve (proposal or review)</span></div>
        <div class="shortcut-item"><kbd>x</kbd> or <kbd>r</kbd> <span>Quick reject (proposal or review)</span></div>
        <div class="shortcut-item"><kbd>?</kbd> <span>Open this shortcuts help</span></div>
        <div class="shortcut-item"><kbd>Esc</kbd> <span>Close active modal</span></div>
      </div>
    </div>
  `);
}

const ACTIONS = {
  'close-modal': closeModal,
  'owner-profile': forms.ownerProfile,
  'export-ledger': () => download('/exports/ledger.csv', 'busywork-ledger.csv'),
  menu: () => { const open = document.querySelector('.sidebar').classList.toggle('open'); document.body.classList.toggle('drawer-open', open); if (open) document.querySelector('.drawer-close').focus(); },
  'close-menu': () => { document.querySelector('.sidebar').classList.remove('open'); document.body.classList.remove('drawer-open'); document.querySelector('.mobile-menu').focus(); },
  shortcuts: showShortcutsModal,
  mandate: forms.companyMandate,
  'set-direction': setDirection,
  'direction-history': directionHistory,
  'clear-direction': async () => { closeModal(); await clearDirection(); toast('Direction cleared. The CEO will choose the next one.'); },
  'new-grant': forms.newGrant,
  'new-record': () => forms.newRecord(),
  'request-reply': () => forms.requestReply(),
  'dismiss-failures': () => { dismissFailures(state.data.tasks); renderPage(); toast('Notice dismissed. No work was restarted.'); },
  'recover-ceo-cycle': () => forms.recoverCeoCycle(),
  'new-task': () => forms.newTask(),
  'new-experiment': () => forms.newExperiment(),
  'new-request': forms.newRequest,
  'new-action': forms.newAction,
  'new-ledger': forms.newLedger,
  'new-message': forms.newMessage,
  'new-meeting': forms.newMeeting,
  kill: forms.confirmStop,
  "reset-business": forms.confirmReset,
  'load-older-events': async () => {
    const btn = document.querySelector('[data-action="load-older-events"]');
    const before = btn?.dataset.before;
    if (!before) return;
    try {
      const older = await api(`/events?before=${before}`);
      state.extraEvents = [...(state.extraEvents || []), ...older];
      renderPage();
      toast(`Loaded ${older.length} older event${older.length === 1 ? '' : 's'}.`);
    } catch (err) { toast(err.message); }
  },
  'load-newer-events': async () => {
    const btn = document.querySelector('[data-action="load-newer-events"]');
    const after = btn?.dataset.after || '0';
    try {
      const newer = await api(`/events?after=${after}`);
      if (newer.length) {
        state.extraEvents = [...(state.extraEvents || []), ...newer];
        renderPage();
        toast(`Loaded ${newer.length} new event${newer.length > 1 ? 's' : ''}.`);
      } else {
        toast('Audit log is up to date.');
      }
    } catch (err) { toast(err.message); }
  },
};

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.page) {
      if (hasUnsavedControls() && !window.confirm('Discard unsaved control changes?')) return;
      document.querySelectorAll('form[data-dirty]').forEach(f => f.dataset.dirty = 'false');
      state.page = b.dataset.page;
      location.hash = state.page;
      closeModal();
      shell();
      return;
    }
    if (b.dataset.document) return await showDocument(b.dataset.document,b.dataset.version);
    if (b.dataset.documentEdit) return await editDocument(b.dataset.documentEdit);
    if (b.dataset.documentDownload) return await downloadDocument(b.dataset.documentDownload,b.dataset.version);
    if (b.dataset.action === 'prepare-release') return await prepareRelease();
    if (b.dataset.action === 'new-document') return await editDocument();
    if (b.dataset.email) { await showEmail(b.dataset.email); return; }
    if (b.dataset.action==='email-connect') { await connectEmail(); return; }
    if (b.dataset.action==='email-sync') { await syncEmail(); await refresh(true); return; }
    if (b.dataset.action==='email-compose') { await composeEmail(); return; }
    if (b.dataset.action==='email-entity') { editBusinessEntity(state.data.emailEntities?.find(r=>r.id===b.dataset.entityId&&r.kind===b.dataset.entityKind)); return; }
    if (b.dataset.action==='email-settings') { emailSettings(); return; }
    if (b.dataset.deployment) { await showDeployment(b.dataset.deployment); return; }
    if (b.dataset.release) { await showRelease(b.dataset.release); return; }
    if (b.dataset.workView) { state.workView = b.dataset.workView; renderPage(); return; }
    if (b.dataset.period) { state.period = Number(b.dataset.period); renderPage(); return; }
    if (b.dataset.logFilter) { state.logFilter = b.dataset.logFilter; renderPage(); return; }
    if (b.dataset.themeChoice) { setTheme(b.dataset.themeChoice); return; }
    if (b.dataset.modeChoice) { setMode(b.dataset.modeChoice); return; }
    if (b.dataset.copy) {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast('Copied to clipboard.');
      return;
    }

    for (const [key, handler] of Object.entries(RECORD_HANDLERS)) {
      if (b.dataset[key]) return await handler(b.dataset[key]);
    }

    if (b.dataset.editRecord) return forms.newRecord((state.data.records || []).find((r) => r.id === b.dataset.editRecord));
    if (b.dataset.action==='add-model') return forms.addModelProfile();
    if (b.dataset.configureModel) return forms.configureModel(b.dataset.configureModel);
    if (b.dataset.testProvider) return forms.testProvider(b.dataset.testProvider);
    if (b.dataset.archiveRecord) {
      await api(`/company/records/${b.dataset.archiveRecord}`, 'DELETE');
      await refresh(true);
      toast('Removed. The team will not see it again.');
      return;
    }
    if (b.dataset.promote) return forms.newExperiment((await api(`/tasks/${encodeURIComponent(b.dataset.promote)}`)).task);
    if (b.dataset.delegate) return forms.newTask((await api(`/tasks/${encodeURIComponent(b.dataset.delegate)}`)).task);
    if (b.dataset.reconcile) return forms.reconcileCall(b.dataset.reconcile);
    if (b.dataset.smsReconcile) return forms.reconcileNotification(b.dataset.smsReconcile);
    if (b.dataset.completeAction) return forms.recordCompletion(b.dataset.completeAction);
    if (b.dataset.cancelMeeting) return forms.cancelMeeting(b.dataset.cancelMeeting);

    if (b.dataset.quickDecision) {
      const id = b.dataset.quickDecision;
      const decision = b.dataset.decision || 'APPROVE';
      const a = (state.data?.actions || []).find((x) => x.id === id);
      if (a) {
        await api(`/actions/${id}/decision`, 'POST', {
          decision,
          rationale: decision === 'APPROVE' ? 'Approved by owner via quick decision.' : 'Rejected by owner via quick decision.',
          hash: a.action_hash,
        });
        closeModal();
        await refresh(true);
        toast(decision === 'APPROVE' ? 'Proposal approved.' : 'Proposal rejected.');
      }
      return;
    }

    if (b.dataset.retry || b.dataset.cancel) {
      const id = b.dataset.retry || b.dataset.cancel;
      await api(`/tasks/${id}/${b.dataset.retry ? 'retry' : 'cancel'}`, 'POST', {});
      closeModal();
      await refresh(true);
      return;
    }
    if (b.dataset.revoke) { await api(`/grants/${b.dataset.revoke}/revoke`, 'POST', {}); await refresh(true); toast('Grant revoked.'); return; }
    if (b.dataset.cancelAction) { await api(`/actions/${b.dataset.cancelAction}/cancel`, 'POST', {}); closeModal(); await refresh(true); return; }
    if (b.dataset.execute) { await api(`/actions/${b.dataset.execute}/execute`, 'POST', {}); closeModal(); await refresh(true); return; }

    const action = b.dataset.action;
    if (!action) return;
    if (ACTIONS[action]) return ACTIONS[action]();
    if (action === 'logout') { if (!window.confirm('Sign out of the dashboard?')) return; await api('/auth/logout', 'POST', {}); showLogin(); return; }
    if (action === 'start' || action === 'pause') {
      await api('/company/status', 'POST', { status: action === 'start' ? 'RUNNING' : 'PAUSED' });
      await refresh(true);
      toast(action === 'start' ? 'The company is running.' : 'Paused. No new work will start.');
    }
  } catch (error) {
    toast(error.message);
  }
});

window.addEventListener('hashchange', () => {
  const page = location.hash.slice(1);
  if (page !== state.page) {
    if (hasUnsavedControls() && !window.confirm('Discard unsaved control changes?')) { location.hash = state.page; return; }
    document.querySelectorAll('form[data-dirty]').forEach(f => f.dataset.dirty = 'false');
    state.page = page;
    if (state.data) shell();
  }
});

modal.addEventListener('click', (e) => {
  if (e.target !== modal) return;
  const r = modal.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) modal.close();
});

// ---------------------------------------------------------------- keyboard shortcuts

let gLeader = false;
let gTimeout = null;

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) { ACTIONS['close-menu'](); return; }
  const activeTag = document.activeElement?.tagName;
  const isInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT';
  if (isInput) return;

  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    showShortcutsModal();
    return;
  }

  if (e.key === 'Escape') {
    closeModal();
    return;
  }

  if (e.key.toLowerCase() === 'g' && !gLeader) {
    gLeader = true;
    clearTimeout(gTimeout);
    gTimeout = setTimeout(() => { gLeader = false; }, 1200);
    return;
  }

  if (gLeader) {
    gLeader = false;
    clearTimeout(gTimeout);
    const key = e.key.toLowerCase();
    const map = {
      o: 'overview',
      w: 'work',
      i: 'inbox',
      m: 'finance',
      f: 'finance',
      t: 'team',
      u:'orders',v: 'conversations', d: 'documents', e: 'email', r: 'models',
      l: 'log',
      c: 'settings',
      s: 'settings',
      p: 'experiments',
      e: 'experiments',
    };
    if (map[key]) {
      e.preventDefault();
      document.querySelector(`nav [data-page="${map[key]}"]`)?.click();
      return;

    }
  }

  if (modal.open) {
    if (e.key.toLowerCase() === 'a') {
      const approveBtn = modal.querySelector('[data-quick-decision][data-decision="APPROVE"]');
      if (approveBtn) { e.preventDefault(); approveBtn.click(); return; }
    } else if (e.key.toLowerCase() === 'x' || e.key.toLowerCase() === 'r') {
      const rejectBtn = modal.querySelector('[data-quick-decision][data-decision="REJECT"]');
      if (rejectBtn) { e.preventDefault(); rejectBtn.click(); return; }
    }
  }

  if ((state.page === 'inbox' || state.page === 'overview') && !modal.open) {
    const proposals = Array.from(document.querySelectorAll('.proposal'));
    if (!proposals.length) return;
    let selectedIdx = proposals.findIndex((p) => p.classList.contains('focused-proposal'));
    if (e.key === 'j') {
      e.preventDefault();
      proposals.forEach((p) => p.classList.remove('focused-proposal'));
      selectedIdx = selectedIdx < 0 ? 0 : (selectedIdx + 1) % proposals.length;
      proposals[selectedIdx].classList.add('focused-proposal');
      proposals[selectedIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'k') {
      e.preventDefault();
      proposals.forEach((p) => p.classList.remove('focused-proposal'));
      selectedIdx = selectedIdx <= 0 ? proposals.length - 1 : selectedIdx - 1;
      proposals[selectedIdx].classList.add('focused-proposal');
      proposals[selectedIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault();
      const reviewBtn = proposals[selectedIdx].querySelector('[data-proposal], [data-request]');
      reviewBtn?.click();
    } else if (e.key.toLowerCase() === 'a' && selectedIdx >= 0) {
      e.preventDefault();
      const approveBtn = proposals[selectedIdx].querySelector('[data-quick-decision][data-decision="APPROVE"]');
      approveBtn?.click();
    } else if ((e.key.toLowerCase() === 'x' || e.key.toLowerCase() === 'r') && selectedIdx >= 0) {
      e.preventDefault();
      const rejectBtn = proposals[selectedIdx].querySelector('[data-quick-decision][data-decision="REJECT"]');
      rejectBtn?.click();
    }
  }
});

// ---------------------------------------------------------------- boot

try {
  const auth = await api('/auth/status');
  signInRequired = auth.signInRequired !== false;
  if (auth.authenticated) await refresh(true);
  else showLogin();
} catch {
  root.innerHTML = '<div class="boot"><span class="brand-mark">b</span><p>The server is not reachable. Start the API and reload this page.</p></div>';
}

setInterval(() => { if (state.data && !document.hidden && !document.querySelector('#session-expired')) void refresh(); }, 10000);

function positionHelp(event) {
  const tip = event.target.closest?.('.help-tip');
  if (!tip) return;
  const popup = tip.querySelector('.help-popup');
  popup.style.left = '0px';
  const bounds = popup.getBoundingClientRect();
  const shift = bounds.right > innerWidth - 12 ? innerWidth - 12 - bounds.right : bounds.left < 12 ? 12 - bounds.left : 0;
  popup.style.left = shift + 'px';
}
document.addEventListener('pointerover', positionHelp);
document.addEventListener('focusin', positionHelp);

document.addEventListener('submit',async event=>{
 if(event.target.id!=='document-search')return;
 event.preventDefault();
 try{await searchDocuments(new FormData(event.target).get('query'));}catch(error){toast(error.message);}
});
