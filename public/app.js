'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/** Keep the app shell sized to the *visible* viewport (not layout 100vh). */
function syncAppHeight() {
  const viewport = window.visualViewport;
  const height = Math.round((viewport && viewport.height) || window.innerHeight || 0);
  const width = Math.round((viewport && viewport.width) || window.innerWidth || 0);
  const style = document.documentElement.style;
  if (height > 0) {
    style.setProperty('--app-height', `${height}px`);
  }
  if (width > 0) style.setProperty('--app-width', `${width}px`);
  style.setProperty('--app-top', `${Math.round((viewport && viewport.offsetTop) || 0)}px`);
  style.setProperty('--app-left', `${Math.round((viewport && viewport.offsetLeft) || 0)}px`);
}
syncAppHeight();
window.addEventListener('resize', syncAppHeight);
window.addEventListener('orientationchange', syncAppHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncAppHeight);
  window.visualViewport.addEventListener('scroll', syncAppHeight);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && location.pathname !== '/login.html') location.href = '/login.html';
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function initAuthPage() {
  const loginForm = $('#login-form');
  const setupForm = $('#setup-form');
  if (!loginForm && !setupForm) return;

  let setupRequired = false;
  try {
    const status = await fetch('/api/auth-status', { headers: { Accept: 'application/json' } })
      .then((r) => r.json());
    setupRequired = Boolean(status.setupRequired);
    if (status.authenticated && !setupRequired) {
      location.href = '/';
      return;
    }
  } catch {
    setupRequired = false;
  }

  const title = $('#auth-title');
  const blurb = $('#auth-blurb');
  const eyebrow = $('#auth-eyebrow');

  if (setupRequired && setupForm) {
    if (eyebrow) eyebrow.textContent = 'FIRST-TIME SETUP';
    if (title) title.textContent = 'Choose a username & password';
    if (blurb) blurb.textContent = 'This protects the Grok WebUI on your Tailscale network. Your browser can save the pair for next time.';
    setupForm.hidden = false;
    if (loginForm) loginForm.hidden = true;
    $('#setup-username')?.focus();

    setupForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = setupForm.querySelector('button');
      const error = $('#setup-error');
      button.disabled = true;
      if (error) error.textContent = '';
      try {
        await request('/api/setup', {
          method: 'POST',
          body: JSON.stringify({
            username: $('#setup-username').value.trim(),
            password: $('#setup-password').value,
            confirm: $('#setup-confirm').value,
          }),
        });
        location.href = '/';
      } catch (cause) {
        if (error) error.textContent = cause.message;
        $('#setup-password')?.select();
      } finally {
        button.disabled = false;
      }
    });
    return;
  }

  if (loginForm) {
    if (eyebrow) eyebrow.textContent = 'PRIVATE WORKSPACE';
    if (title) title.textContent = 'Grok, from anywhere.';
    if (blurb) blurb.textContent = 'A private bridge to the Grok agent running on your laptop — chat history, tools, files, and slash commands.';
    loginForm.hidden = false;
    if (setupForm) setupForm.hidden = true;
    $('#username')?.focus();

    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = loginForm.querySelector('button');
      const error = $('#login-error');
      const usernameInput = $('#username');
      const passwordInput = $('#password');
      button.disabled = true;
      if (error) error.textContent = '';
      try {
        await request('/api/login', {
          method: 'POST',
          body: JSON.stringify({
            username: usernameInput.value.trim(),
            password: passwordInput.value,
          }),
        });
        location.href = '/';
      } catch (cause) {
        if (error) error.textContent = cause.message;
        passwordInput.select();
      } finally {
        button.disabled = false;
      }
    });
  }
}

initAuthPage();

if ($('#composer-form')) {
  const state = {
    sessionId: null,
    cwd: null,
    running: false,
    streamingNode: null,
    streamingMessageId: null,
    sessions: [],
    activeSessionIds: new Set(),
    followOutput: true,
    activityEntries: new Map(),
    currentPlan: [],
    currentPlanExplanation: '',
    attachments: [],
    commands: [],
    commandIndex: 0,
    models: null,
    eventSource: null,
    historyFingerprint: '',
    resyncTimer: null,
    resyncInFlight: false,
    resyncPending: null,
    catchupTimers: [],
    lastEventAt: 0,
    awaitingTurn: false,
    // User messages shown immediately on send, before disk history catches up.
    optimisticUsers: [],
    sessionTokens: 0,
    lastTurnTokens: 0,
    providerUsageLabel: '',
    prefs: null,
    amtStatus: null,
    // Bounded history window for long sessions (phones crash when full tool history is painted).
    historyTotalMessages: 0,
    historyMessageOffset: 0,
    historyHasOlder: false,
    historyLoadingOlder: false,
    messageQueue: [],
    stagedMessage: null,
    commandLoadPromise: null,
    pendingPermission: null,
    pendingAskUser: null,
    pendingPlanApproval: null,
  };

  /** Fewer messages/tools on narrow viewports — mobile Safari is the main crash surface. */
  function historyPageSize() {
    return isMobileLayout() ? 40 : 80;
  }
  function historyToolLimit() {
    return isMobileLayout() ? 30 : 50;
  }
  function sessionHistoryUrl(id, { lite = false, before = 0, messages = null, tools = null } = {}) {
    const params = new URLSearchParams();
    if (lite) params.set('lite', '1');
    else {
      params.set('messages', String(messages != null ? messages : historyPageSize()));
      params.set('tools', String(tools != null ? tools : historyToolLimit()));
      if (before > 0) params.set('before', String(before));
    }
    const qs = params.toString();
    return `/api/sessions/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;
  }
  function noteHistoryMeta(result = {}) {
    state.historyTotalMessages = Number(result.totalMessages) || (result.messages || []).length || 0;
    state.historyMessageOffset = Number(result.messageOffset) || 0;
    state.historyHasOlder = Boolean(result.messagesTruncated && state.historyMessageOffset > 0);
  }

  const PREFS_KEY = 'grok-webui-prefs-v1';
  const QUEUE_KEY = 'grok-webui-message-queue-v1';
  const DEFAULT_PREFS = {
    defaultModel: '',
    defaultEffort: '',
    systemPrompt: '',
    systemPromptByWorkspace: {},
    autoScroll: true,
    autoActivity: true,
    density: 'comfortable',
    theme: 'dark',
    accent: 'blue',
    amtToolsEnabled: false,
    notifyOnComplete: false,
    permissionMode: 'moderate',
  };

  function loadPrefs() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; }
    catch { stored = {}; }
    state.prefs = { ...DEFAULT_PREFS, ...stored, systemPromptByWorkspace: { ...(DEFAULT_PREFS.systemPromptByWorkspace), ...(stored.systemPromptByWorkspace || {}) } };
    return state.prefs;
  }

  function savePrefs(partial = {}) {
    state.prefs = { ...loadPrefs(), ...partial };
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    applyPrefsToUi();
    return state.prefs;
  }

  function saveMessageQueue() {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(state.messageQueue));
    renderMessageQueue();
  }
  function loadMessageQueue() {
    try { state.messageQueue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') || []; }
    catch { state.messageQueue = []; }
    renderMessageQueue();
  }
  function renderMessageQueue() {
    const wrap = $('#message-queue');
    if (!wrap) return;
    const current = state.messageQueue.filter((item) => !item.sessionId || item.sessionId === state.sessionId);
    wrap.replaceChildren();
    wrap.classList.toggle('hidden', !current.length);
    for (const item of current) {
      const row = document.createElement('div'); row.className = 'queued-message';
      const label = document.createElement('span'); label.textContent = item.text || item.attachments?.map((file) => file.name).join(', ') || 'Attachment';
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'Remove queued message';
      remove.addEventListener('click', () => { state.messageQueue = state.messageQueue.filter((queued) => queued.id !== item.id); saveMessageQueue(); });
      row.append(label, remove); wrap.append(row);
    }
  }
  function enqueueStaged({ interrupt = false } = {}) {
    if (!state.stagedMessage) return;
    state.messageQueue.push({ ...state.stagedMessage, id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, sessionId: state.sessionId });
    state.stagedMessage = null;
    clearAttachments();
    $('#queue-choice').classList.add('hidden');
    saveMessageQueue();
    if (interrupt) $('#interrupt').click();
  }
  function flushMessageQueue() {
    if (state.running) return;
    const index = state.messageQueue.findIndex((item) => !item.sessionId || item.sessionId === state.sessionId);
    if (index < 0) return;
    const [next] = state.messageQueue.splice(index, 1);
    saveMessageQueue();
    state.attachments = next.attachments || [];
    renderAttachments();
    setTimeout(() => sendMessage(next.text || ''), 250);
  }

  function workspaceSystemPrompt() {
    const prefs = state.prefs || loadPrefs();
    const cwd = state.cwd || '';
    if (cwd && prefs.systemPromptByWorkspace && prefs.systemPromptByWorkspace[cwd] != null) {
      return prefs.systemPromptByWorkspace[cwd];
    }
    return prefs.systemPrompt || '';
  }

  function setWorkspaceSystemPrompt(text) {
    const prefs = loadPrefs();
    const cwd = state.cwd || '';
    const map = { ...(prefs.systemPromptByWorkspace || {}) };
    if (cwd) map[cwd] = text;
    savePrefs({ systemPrompt: text, systemPromptByWorkspace: map });
  }

  function applyPrefsToUi() {
    const prefs = state.prefs || loadPrefs();
    document.body.dataset.theme = prefs.theme === 'light' ? 'light' : 'dark';
    document.body.dataset.accent = ['blue', 'green', 'purple', 'gold'].includes(prefs.accent) ? prefs.accent : 'blue';
    document.body.dataset.density = prefs.density === 'compact' ? 'compact' : 'comfortable';
    state.followOutput = prefs.autoScroll !== false;

    const modelSel = $('#model');
    const effortSel = $('#effort');
    if (modelSel && prefs.defaultModel && [...modelSel.options].some((o) => o.value === prefs.defaultModel)) {
      if (!modelSel.value) modelSel.value = prefs.defaultModel;
    }
    if (effortSel && prefs.defaultEffort) {
      if (!effortSel.value) effortSel.value = prefs.defaultEffort;
    }

    // Prefs form fields if open
    const pm = $('#pref-default-model');
    if (pm) {
      syncPrefModelOptions();
      pm.value = prefs.defaultModel || '';
    }
    if ($('#pref-default-effort')) $('#pref-default-effort').value = prefs.defaultEffort || '';
    if ($('#pref-system-prompt')) $('#pref-system-prompt').value = workspaceSystemPrompt();
    if ($('#pref-auto-scroll')) $('#pref-auto-scroll').checked = prefs.autoScroll !== false;
    if ($('#pref-auto-activity')) $('#pref-auto-activity').checked = prefs.autoActivity !== false;
    if ($('#pref-density')) $('#pref-density').value = prefs.density || 'comfortable';
    if ($('#pref-theme')) $('#pref-theme').value = prefs.theme || 'dark';
    if ($('#pref-accent')) $('#pref-accent').value = prefs.accent || 'blue';
    if ($('#pref-amt-tools-enabled')) $('#pref-amt-tools-enabled').checked = Boolean(prefs.amtToolsEnabled);
    if ($('#pref-notify-complete')) $('#pref-notify-complete').checked = Boolean(prefs.notifyOnComplete);
    if ($('#pref-permission-mode')) $('#pref-permission-mode').value = prefs.permissionMode || 'moderate';
    const labels = { restrictive: 'Restrictive', moderate: 'Moderate', yolo: 'YOLO' };
    if ($('#permission-pill')) $('#permission-pill').textContent = labels[prefs.permissionMode] || labels.moderate;
    if ($('#permission-note')) $('#permission-note').textContent = `${labels[prefs.permissionMode] || labels.moderate} permissions`;
  }

  function syncPrefModelOptions() {
    const pm = $('#pref-default-model');
    const modelSel = $('#model');
    if (!pm || !modelSel) return;
    const current = pm.value;
    pm.replaceChildren();
    for (const opt of modelSel.options) {
      const clone = opt.cloneNode(true);
      pm.append(clone);
    }
    if (current && [...pm.options].some((o) => o.value === current)) pm.value = current;
  }

  function formatTokens(n) {
    const num = Number(n) || 0;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 10_000) return `${Math.round(num / 1000)}k`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return String(num);
  }

  function updateUsageStrip() {
    const sessionEl = $('#session-tokens');
    const providerEl = $('#provider-usage');
    const amtEl = $('#amt-usage');
    if (sessionEl) {
      sessionEl.textContent = state.sessionTokens
        ? `Chat · ${formatTokens(state.sessionTokens)} tokens`
        : 'Chat · —';
      sessionEl.title = state.lastTurnTokens
        ? `This chat: ${state.sessionTokens.toLocaleString()} tokens (last turn ${state.lastTurnTokens.toLocaleString()})`
        : 'Tokens reported for this chat';
    }
    if (providerEl) {
      providerEl.textContent = state.providerUsageLabel
        ? `Model · ${state.providerUsageLabel}`
        : 'Model · session only';
      providerEl.classList.toggle('ok', Boolean(state.providerUsageLabel));
      providerEl.title = state.providerUsageLabel
        ? `Provider-reported: ${state.providerUsageLabel}`
        : 'Grok/xAI remaining balance is only shown when the agent reports it';
    }
    if (amtEl) {
      const s = state.amtStatus;
      if (s && s.connected) {
        amtEl.classList.remove('hidden');
        const rem = s.usage?.remaining != null ? s.usage.remaining : '—';
        const lim = s.usage?.limit != null ? s.usage.limit : '—';
        const credits = s.credit_balance?.total ?? s.usage_credits ?? '—';
        amtEl.textContent = `AMT · ${rem}/${lim} today · ${credits} cr`;
        amtEl.classList.toggle('warn', Number(s.usage?.remaining) === 0);
        amtEl.classList.toggle('ok', Number(s.usage?.remaining) > 0);
      } else {
        amtEl.classList.add('hidden');
      }
    }
  }

  function noteTokenUsage(usage, { cumulative = false } = {}) {
    if (!usage || typeof usage !== 'object') return;
    const total = Number(usage.totalTokens || usage.total_tokens || usage.used || 0);
    const input = Number(usage.inputTokens || usage.input_tokens || usage.promptTokens || 0);
    const output = Number(usage.outputTokens || usage.output_tokens || usage.completionTokens || 0);
    let amount = total;
    if (!amount && (input || output)) amount = input + output;
    if (amount) {
      if (cumulative || (usage.used != null && usage.size != null)) {
        // Stream "used/size" style counters are usually session-cumulative.
        state.sessionTokens = Math.max(state.sessionTokens, amount);
      } else {
        // Turn totals — avoid double-counting identical consecutive reports.
        if (amount !== state.lastTurnTokens || state.sessionTokens === 0) {
          state.lastTurnTokens = amount;
          state.sessionTokens += amount;
        }
      }
    }
    // Provider remaining fields when present
    const remaining = usage.remainingTokens ?? usage.remaining_tokens ?? usage.remaining
      ?? usage.quotaRemaining ?? usage.quota_remaining;
    const limit = usage.limitTokens ?? usage.limit_tokens ?? usage.limit ?? usage.quota ?? usage.size;
    const credits = usage.credits ?? usage.credit_balance ?? usage.balance;
    if (remaining != null || credits != null || (usage.used != null && usage.size != null)) {
      const bits = [];
      if (usage.used != null && usage.size != null) {
        bits.push(`${formatTokens(usage.used)}/${formatTokens(usage.size)}`);
      } else if (remaining != null) {
        bits.push(`${formatTokens(remaining)}${limit != null ? `/${formatTokens(limit)}` : ''} left`);
      }
      if (credits != null) bits.push(`${credits} cr`);
      if (bits.length) state.providerUsageLabel = bits.join(' · ');
    }
    updateUsageStrip();
    const rail = $('#token-usage');
    if (rail) rail.textContent = `${formatTokens(state.sessionTokens)} this chat`;
  }

  function resetSessionUsage() {
    state.sessionTokens = 0;
    state.lastTurnTokens = 0;
    state.providerUsageLabel = '';
    updateUsageStrip();
    const rail = $('#token-usage');
    if (rail) rail.textContent = '';
  }

  function activityTime() {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  function toast(message, type = '') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    $('#toasts').append(node);
    setTimeout(() => node.remove(), 5000);
  }

  function setConnected(connected, label = connected ? 'Grok connected' : 'Reconnecting') {
    $('#connection-dot').classList.toggle('online', connected);
    $('#connection-label').textContent = label;
  }

  function resetPlan() {
    state.currentPlan = [];
    state.currentPlanExplanation = '';
    $('#plan-panel').classList.add('hidden');
    $('#plan-list').replaceChildren();
    $('#plan-explanation').textContent = '';
  }

  function resetActivity({ preservePlan = true } = {}) {
    state.activityEntries.clear();
    $('#activity-feed').replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Activity appears here as Grok reasons, uses tools, edits files, and runs checks.';
    $('#activity-feed').append(empty);
    if (!preservePlan) resetPlan();
    $('#token-usage').textContent = '';
  }

  function ensureActivityEntry(id, title, kind = '') {
    const key = id || `${kind}-${Date.now()}-${Math.random()}`;
    let entry = state.activityEntries.get(key);
    if (entry) return entry;
    $('#activity-feed .activity-empty')?.remove();
    const node = document.createElement('article');
    node.className = `activity-entry ${kind} running`;
    const header = document.createElement('header');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const time = document.createElement('time');
    time.textContent = activityTime();
    const detail = document.createElement(kind === 'reasoning' ? 'p' : 'pre');
    header.append(heading, time);
    node.append(header, detail);
    $('#activity-feed').append(node);
    entry = { node, heading, detail };
    state.activityEntries.set(key, entry);
    $('#activity-feed').scrollTop = $('#activity-feed').scrollHeight;
    return entry;
  }

  function shortActivityTitle(title) {
    const raw = String(title || 'Tool').replace(/\s+/g, ' ').trim();
    // "Execute `huge shell...`" → keep a readable head, not the full command in the chat rail header
    if (/^Execute\s+`/.test(raw) && raw.length > 90) {
      const inner = raw.slice(raw.indexOf('`') + 1);
      const firstLine = inner.split(/\n/)[0].replace(/`+$/, '').trim();
      return `Shell: ${firstLine.slice(0, 72)}${firstLine.length > 72 ? '…' : ''}`;
    }
    return raw.length > 100 ? `${raw.slice(0, 97)}…` : raw;
  }

  function updateActivity(id, { title, detail, append, kind = '', status = 'running' }) {
    const entry = ensureActivityEntry(id, title ? shortActivityTitle(title) : 'Working', kind);
    if (title) entry.heading.textContent = shortActivityTitle(title);
    // Keep activity text small — long tool dumps were a major mobile memory killer.
    const detailCap = isMobileLayout() ? 2500 : 4000;
    if (detail !== undefined) entry.detail.textContent = String(detail).slice(-detailCap);
    if (append) entry.detail.textContent = `${entry.detail.textContent}${append}`.slice(-detailCap);
    entry.node.classList.remove('running', 'done', 'error');
    entry.node.classList.add(status);
    $('#activity-feed').scrollTop = $('#activity-feed').scrollHeight;
  }

  function capActivityFeedDom() {
    const maxEntries = isMobileLayout() ? 40 : 80;
    const feed = $('#activity-feed');
    if (!feed) return;
    const nodes = [...feed.querySelectorAll('.activity-entry')];
    if (nodes.length <= maxEntries) return;
    const drop = nodes.length - maxEntries;
    for (let i = 0; i < drop; i += 1) {
      const node = nodes[i];
      for (const [key, entry] of state.activityEntries) {
        if (entry.node === node) state.activityEntries.delete(key);
      }
      node.remove();
    }
  }

  function normalizePlanStatus(status) {
    const value = String(status || 'pending').toLowerCase().replace(/[_\s-]/g, '');
    if (['completed', 'complete', 'done'].includes(value)) return 'completed';
    if (['inprogress', 'active', 'current', 'running'].includes(value)) return 'in-progress';
    return 'pending';
  }

  function renderPlan(entries = [], explanation = '') {
    if (!entries.length) return;
    state.currentPlan = entries.map((item) => ({ ...item }));
    state.currentPlanExplanation = explanation || state.currentPlanExplanation || '';
    $('#plan-panel').classList.remove('hidden');
    const normalized = entries.map((item) => normalizePlanStatus(item.status));
    const complete = normalized.filter((status) => status === 'completed').length;
    const currentIndex = normalized.indexOf('in-progress');
    $('#plan-explanation').textContent = explanation || (currentIndex >= 0
      ? `${complete} of ${entries.length} complete · Step ${currentIndex + 1} is active`
      : `${complete} of ${entries.length} complete`);
    const list = $('#plan-list');
    list.replaceChildren();
    for (const [index, item] of entries.entries()) {
      const status = normalized[index];
      const row = document.createElement('li');
      row.className = `plan-step ${status}`;
      row.setAttribute('aria-current', status === 'in-progress' ? 'step' : 'false');
      const marker = document.createElement('span');
      marker.className = 'plan-marker';
      marker.textContent = status === 'completed' ? '✓' : status === 'in-progress' ? '→' : '○';
      const copy = document.createElement('span');
      copy.className = 'plan-copy';
      const text = document.createElement('strong');
      text.textContent = item.content || item.step || item.title || `Step ${index + 1}`;
      const label = document.createElement('small');
      label.textContent = status === 'completed' ? 'Done' : status === 'in-progress' ? 'Now' : 'Next';
      copy.append(text, label);
      row.append(marker, copy);
      list.append(row);
    }
  }

  function nearConversationBottom() {
    const conversation = $('#conversation');
    return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
  }

  function updateJumpButton() {
    $('#jump-latest').classList.toggle('hidden', nearConversationBottom() || $('#conversation').classList.contains('hidden'));
  }

  function scrollToLatest(behavior = 'auto') {
    state.followOutput = true;
    requestAnimationFrame(() => {
      const conversation = $('#conversation');
      conversation.scrollTo({ top: conversation.scrollHeight, behavior });
      requestAnimationFrame(updateJumpButton);
    });
  }

  function keepLatestVisibleWhileTyping() {
    const input = $('#message');
    let followDuringKeyboard = false;
    const restoreLatest = () => {
      if (document.activeElement === input && followDuringKeyboard) scrollToLatest();
    };
    input.addEventListener('pointerdown', () => {
      followDuringKeyboard = state.followOutput || nearConversationBottom();
    }, { passive: true });
    input.addEventListener('focus', () => {
      followDuringKeyboard = followDuringKeyboard || state.followOutput || nearConversationBottom();
      restoreLatest();
      setTimeout(restoreLatest, 150);
      setTimeout(restoreLatest, 350);
    });
    input.addEventListener('blur', () => {
      followDuringKeyboard = false;
    });
    window.visualViewport?.addEventListener('resize', restoreLatest);
    window.visualViewport?.addEventListener('scroll', restoreLatest);
  }

  keepLatestVisibleWhileTyping();

  function updateRunStatus() {
    const currentRunning = state.sessionId && state.activeSessionIds.has(state.sessionId);
    const backgroundCount = [...state.activeSessionIds].filter((id) => id !== state.sessionId).length;
    const pill = $('#run-status');
    pill.classList.toggle('online', state.activeSessionIds.size > 0);
    if (currentRunning) pill.lastChild.textContent = ' Working in this chat';
    else if (backgroundCount) pill.lastChild.textContent = ` ${backgroundCount} running in background`;
    else pill.lastChild.textContent = ' Ready';
    $('.workspace').classList.toggle('has-activity', state.activeSessionIds.size > 0);
  }

  /** Matches the mobile CSS breakpoint where the activity rail is full-screen. */
  function isMobileLayout() {
    return window.matchMedia('(max-width: 760px)').matches;
  }

  function setActivityOpen(open, { persist = true } = {}) {
    $('.workspace').classList.toggle('activity-open', open);
    $('#activity-toggle').classList.toggle('active', open);
    if (persist) {
      localStorage.setItem('grok-webui-activity-panel', open ? 'open' : 'closed');
    }
  }

  /**
   * Auto-open the activity rail only on desktop.
   * On mobile the rail covers the whole chat — tools/reasoning should not steal focus.
   * Users can still open it via the Activity toggle.
   */
  function maybeAutoOpenActivity() {
    if (isMobileLayout()) return;
    const prefs = state.prefs || loadPrefs();
    if (prefs.autoActivity === false) return;
    setActivityOpen(true);
  }

  function setRunning(running) {
    state.running = running;
    if (state.sessionId) {
      if (running) state.activeSessionIds.add(state.sessionId);
      else state.activeSessionIds.delete(state.sessionId);
    }
    updateRunStatus();
    $('#interrupt').classList.toggle('hidden', !running);
    $('.send-button').disabled = false; // allow queue while running for slash commands, etc.
    $('#activity-state-label').textContent = running ? 'Working now' : 'Waiting for work';
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.valueOf())
      ? ''
      : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function sessionTitle(session) {
    return session.title || session.summary || 'Untitled session';
  }

  function loadPinnedIds(key = 'grok-webui-pinned') {
    try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
    catch { return new Set(); }
  }
  function savePinnedIds(set, key = 'grok-webui-pinned') {
    localStorage.setItem(key, JSON.stringify([...set]));
  }
  function isPinned(id) {
    return loadPinnedIds().has(id);
  }
  function togglePin(id, event) {
    event.stopPropagation();
    const set = loadPinnedIds();
    if (set.has(id)) set.delete(id);
    else set.add(id);
    savePinnedIds(set);
    renderSessions();
  }

  function updateFleetStrip() {
    const working = state.sessions.filter((s) => state.activeSessionIds.has(s.id) || s.active).length;
    const idle = Math.max(0, state.sessions.length - working);
    if ($('#fleet-working')) $('#fleet-working').textContent = `${working} working`;
    if ($('#fleet-idle')) $('#fleet-idle').textContent = `${idle} idle`;
  }

  function renderSessions() {
    const list = $('#session-list');
    list.replaceChildren();
    const query = ($('#session-search')?.value || '').trim().toLowerCase();
    let sessions = [...state.sessions];
    if (query) {
      sessions = sessions.filter((s) => {
        const hay = `${sessionTitle(s)} ${s.cwd || ''} ${s.id || ''}`.toLowerCase();
        return hay.includes(query);
      });
    }
    const pinned = loadPinnedIds();
    sessions.sort((a, b) => {
      const ap = pinned.has(a.id) ? 0 : 1;
      const bp = pinned.has(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const aw = (state.activeSessionIds.has(a.id) || a.active) ? 0 : 1;
      const bw = (state.activeSessionIds.has(b.id) || b.active) ? 0 : 1;
      if (aw !== bw) return aw - bw;
      return 0;
    });
    updateFleetStrip();
    if (!sessions.length) {
      const empty = document.createElement('p');
      empty.className = 'thread-item';
      empty.textContent = query ? 'No matching sessions' : 'No sessions yet';
      list.append(empty);
      return;
    }
    for (const session of sessions) {
      const button = document.createElement('button');
      button.className = `thread-item${session.id === state.sessionId ? ' active' : ''}`;
      const row = document.createElement('div');
      row.className = 'item-row';
      const title = document.createElement('strong');
      title.textContent = sessionTitle(session);
      if (state.activeSessionIds.has(session.id) || session.active) {
        const activity = document.createElement('i');
        activity.className = 'thread-activity';
        activity.title = 'Grok is working in this chat';
        title.append(activity);
      }
      const pin = document.createElement('span');
      pin.className = `pin-btn${pinned.has(session.id) ? ' pinned' : ''}`;
      pin.textContent = pinned.has(session.id) ? '★' : '☆';
      pin.title = pinned.has(session.id) ? 'Unpin' : 'Pin';
      pin.addEventListener('click', (e) => togglePin(session.id, e));
      row.append(title, pin);
      const meta = document.createElement('span');
      const folder = session.cwd ? session.cwd.split('/').pop() : '';
      const status = (state.activeSessionIds.has(session.id) || session.active) ? 'working' : 'idle';
      meta.textContent = [status, formatDate(session.updatedAt), folder].filter(Boolean).join(' · ');
      button.append(row, meta);
      button.addEventListener('click', () => openSession(session.id));
      list.append(button);
    }
  }

  function draftKey() {
    return `grok-webui-draft:${state.sessionId || 'new'}`;
  }
  function saveDraft() {
    const text = $('#message')?.value || '';
    try {
      if (text.trim()) localStorage.setItem(draftKey(), text);
      else localStorage.removeItem(draftKey());
    } catch { /* ignore */ }
  }
  function restoreDraft() {
    try {
      const text = localStorage.getItem(draftKey()) || '';
      if ($('#message') && text) {
        $('#message').value = text;
        $('#message').dispatchEvent(new Event('input'));
      }
    } catch { /* ignore */ }
  }
  function clearDraft() {
    try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
  }

  function notifyTurnComplete(title = 'Grok finished') {
    const prefs = state.prefs || loadPrefs();
    if (!prefs.notifyOnComplete) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      try { new Notification(title, { body: sessionTitle({ title: $('#session-title')?.textContent }) || 'Your turn is complete', silent: false }); }
      catch { /* ignore */ }
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }

  function copyLastAssistant() {
    const nodes = $$('#conversation .message.assistant .message-body');
    const last = nodes[nodes.length - 1];
    const text = last?.innerText || last?.textContent || '';
    if (!text.trim()) {
      toast('No assistant message to copy', 'error');
      return;
    }
    navigator.clipboard.writeText(text).then(() => toast('Copied last reply')).catch(() => toast('Copy failed', 'error'));
  }

  function exportThreadMarkdown() {
    const parts = [`# ${$('#session-title')?.textContent || 'Grok chat'}\n`];
    $$('#conversation .message').forEach((m) => {
      const role = m.classList.contains('user') ? 'You' : 'Grok';
      const body = m.querySelector('.message-body');
      const text = body?.innerText || body?.textContent || '';
      if (text.trim()) parts.push(`## ${role}\n\n${text.trim()}\n`);
    });
    if (parts.length < 2) {
      toast('Nothing to export', 'error');
      return;
    }
    const blob = new Blob([parts.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `grok-chat-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exported Markdown');
  }

  async function loadSessions() {
    try {
      const [result, activity] = await Promise.all([
        request('/api/sessions'),
        request('/api/activity'),
      ]);
      state.sessions = result.sessions || [];
      state.activeSessionIds.clear();
      for (const active of activity.activeSessions || []) state.activeSessionIds.add(active.sessionId);
      for (const session of state.sessions) {
        if (session.active) state.activeSessionIds.add(session.id);
      }
      renderSessions();
      updateRunStatus();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  const IMAGE_MARKDOWN = /!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g;
  // Absolute paths under workspace or ~/.grok (agent artifacts / generated media)
  const ABS_PATH = /(\/(?:home\/eric\/workspace|home\/eric\/\.grok)\/[^\s`'"<>]+)/g;
  const REL_IMAGE_PATH = /(?<![\w/])((?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:png|jpe?g|gif|webp|avif|svg))\b/gi;
  const CODE_FENCE = /```([\w+-]*)\n([\s\S]*?)```/g;
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

  /** Resolve a chat path to an absolute filesystem path the /api/image endpoint can serve. */
  function resolveLocalPath(value) {
    if (typeof value !== 'string') return null;
    let raw = value.trim();
    if (!raw) return null;
    // Strip optional angle brackets / surrounding quotes left by markdown variants
    if ((raw.startsWith('<') && raw.endsWith('>')) || (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1).trim();
    }
    if (raw.startsWith('file://')) {
      try { raw = decodeURIComponent(raw.slice('file://'.length)); }
      catch { raw = raw.slice('file://'.length); }
    }
    // Already absolute
    if (raw.startsWith('/')) return raw;
    // Relative to the active session workspace (e.g. images/foo.jpg from image_gen / gen.py)
    if (!state.cwd) return null;
    // Normalize ./foo and bar/baz without allowing protocol-looking strings
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
    const joined = `${state.cwd.replace(/\/+$/, '')}/${raw.replace(/^\.\/+/, '')}`.replace(/\/{2,}/g, '/');
    return joined;
  }

  function localMediaUrl(value) {
    if (typeof value !== 'string') return null;
    if (value.startsWith('data:image/')) return value;
    if (value.startsWith('blob:')) return value;
    if (value.startsWith('/api/image?') || value.startsWith('/api/file?')) return value;
    const resolved = resolveLocalPath(value);
    if (!resolved) return null;
    return `/api/image?path=${encodeURIComponent(resolved)}`;
  }

  function localFileUrl(value) {
    if (typeof value !== 'string') return null;
    if (value.startsWith('/api/file?') || value.startsWith('/api/image?')) return value;
    const resolved = resolveLocalPath(value);
    if (!resolved) return null;
    return `/api/file?path=${encodeURIComponent(resolved)}`;
  }

  function appendImage(container, source, alt = 'Image') {
    const url = localMediaUrl(source);
    if (!url) return false;
    const link = document.createElement('a');
    link.className = 'message-image-link';
    link.href = url.startsWith('data:') || url.startsWith('blob:') ? url : url;
    link.target = '_blank';
    link.rel = 'noopener';
    const image = document.createElement('img');
    image.className = 'message-image';
    image.src = url;
    image.alt = alt || 'Image';
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      const resolved = resolveLocalPath(source);
      const hint = resolved && resolved !== source ? ` (${resolved})` : '';
      link.replaceWith(document.createTextNode(`[Image unavailable: ${alt || 'image'}${hint}]`));
    }, { once: true });
    link.append(image);
    container.append(link);
    return true;
  }

  function appendFileChip(container, filePath, label) {
    const url = localFileUrl(filePath);
    if (!url) return;
    const link = document.createElement('a');
    link.className = 'file-chip';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = `📄 ${label || filePath.split('/').pop()}`;
    container.append(link);
  }

  function safeHref(href) {
    if (typeof href !== 'string') return null;
    const value = href.trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('#') || (value.startsWith('/') && !value.startsWith('//'))) return value;
    return null;
  }

  function appendCodeBlock(container, lang, code) {
    const wrap = document.createElement('div');
    wrap.className = 'md-code-block';
    if (lang) {
      const label = document.createElement('div');
      label.className = 'md-code-lang';
      label.textContent = lang;
      wrap.append(label);
    }
    const pre = document.createElement('pre');
    pre.textContent = String(code || '').replace(/\n$/, '');
    wrap.append(pre);
    container.append(wrap);
  }

  function appendPlainWithPaths(parent, text) {
    if (!text) return;
    let pathCursor = 0;
    const spans = [];
    const pathRe = new RegExp(ABS_PATH.source, 'g');
    let pathMatch;
    while ((pathMatch = pathRe.exec(text))) {
      spans.push({ index: pathMatch.index, raw: pathMatch[1], kind: 'abs' });
    }
    const relRe = new RegExp(REL_IMAGE_PATH.source, 'gi');
    let relMatch;
    while ((relMatch = relRe.exec(text))) {
      const insideAbs = spans.some((s) => relMatch.index >= s.index && relMatch.index < s.index + s.raw.length);
      if (insideAbs) continue;
      const before = text.slice(Math.max(0, relMatch.index - 8), relMatch.index);
      if (/https?:\/\/$/i.test(before) || /data:$/i.test(before)) continue;
      spans.push({ index: relMatch.index, raw: relMatch[1], kind: 'rel' });
    }
    spans.sort((a, b) => a.index - b.index || b.raw.length - a.raw.length);
    const picked = [];
    for (const span of spans) {
      const end = span.index + span.raw.length;
      if (picked.some((p) => !(end <= p.index || span.index >= p.index + p.raw.length))) continue;
      picked.push(span);
    }
    for (const span of picked) {
      if (span.index > pathCursor) parent.append(document.createTextNode(text.slice(pathCursor, span.index)));
      const p = span.raw.replace(/[.,;:!?)]+$/, '');
      const isImg = IMAGE_EXT.test(p);
      if (isImg) appendImage(parent, p, p.split('/').pop());
      else if (span.kind === 'abs') appendFileChip(parent, p, p.split('/').pop());
      else parent.append(document.createTextNode(span.raw));
      pathCursor = span.index + span.raw.length;
      if (p.length < span.raw.length) parent.append(document.createTextNode(span.raw.slice(p.length)));
    }
    if (pathCursor < text.length) parent.append(document.createTextNode(text.slice(pathCursor)));
  }

  /** Lightweight markdown → DOM (no innerHTML). Safe for agent output. */
  function appendInlineMarkdown(parent, text) {
    if (!text) return;
    const re = /(!\[([^\]]*)\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\))|(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`\n]+)`)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*\n]+)\*)|(_([^_\n]+)_)/g;
    let cursor = 0;
    let match;
    while ((match = re.exec(text))) {
      if (match.index > cursor) appendPlainWithPaths(parent, text.slice(cursor, match.index));
      if (match[1]) {
        const alt = match[2] || '';
        const src = match[3] || match[4];
        if (!appendImage(parent, src, alt)) parent.append(document.createTextNode(match[0]));
      } else if (match[5]) {
        const href = safeHref(match[7]);
        if (href) {
          const a = document.createElement('a');
          a.className = 'md-link';
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = match[6];
          parent.append(a);
        } else {
          parent.append(document.createTextNode(match[0]));
        }
      } else if (match[8]) {
        const code = document.createElement('code');
        code.className = 'md-inline';
        code.textContent = match[9];
        parent.append(code);
      } else if (match[10] || match[12]) {
        const strong = document.createElement('strong');
        strong.textContent = match[11] || match[13];
        parent.append(strong);
      } else if (match[14] || match[16]) {
        const em = document.createElement('em');
        em.textContent = match[15] || match[17];
        parent.append(em);
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) appendPlainWithPaths(parent, text.slice(cursor));
  }

  function isBlockStart(line) {
    return /^(#{1,3}\s|```|~~~|[-*+]\s+|\d+\.\s+|>\s?|---+\s*$|\*\*\*+\s*$)/.test(line);
  }

  function renderMarkdownBlocks(container, text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) {
        i += 1;
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        container.append(document.createElement('hr'));
        i += 1;
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+?)\s*$/);
      if (heading) {
        const level = Math.min(3, heading[1].length);
        const h = document.createElement(`h${level}`);
        h.className = `md-h md-h${level}`;
        appendInlineMarkdown(h, heading[2]);
        container.append(h);
        i += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        const quote = document.createElement('blockquote');
        const chunks = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          chunks.push(lines[i].replace(/^>\s?/, ''));
          i += 1;
        }
        chunks.join('\n').split(/\n{2,}/).forEach((chunk) => {
          const p = document.createElement('p');
          const rows = chunk.split('\n');
          rows.forEach((row, idx) => {
            if (idx) p.append(document.createElement('br'));
            appendInlineMarkdown(p, row);
          });
          quote.append(p);
        });
        container.append(quote);
        continue;
      }
      if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
        const ordered = /^\d+\.\s+/.test(line);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        list.className = 'md-list';
        const itemRe = ordered ? /^\d+\.\s+/ : /^[-*+]\s+/;
        while (i < lines.length && itemRe.test(lines[i])) {
          const li = document.createElement('li');
          appendInlineMarkdown(li, lines[i].replace(itemRe, ''));
          list.append(li);
          i += 1;
        }
        container.append(list);
        continue;
      }
      const paraLines = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
        paraLines.push(lines[i]);
        i += 1;
      }
      if (!paraLines.length) {
        i += 1;
        continue;
      }
      const p = document.createElement('p');
      paraLines.forEach((row, idx) => {
        if (idx) p.append(document.createElement('br'));
        appendInlineMarkdown(p, row);
      });
      container.append(p);
    }
  }

  function renderRichText(body, text) {
    body.classList.remove('streaming');
    body.replaceChildren();
    const value = text || '';
    let cursor = 0;
    const fenceRe = new RegExp(CODE_FENCE.source, 'g');
    let match;
    const segments = [];
    while ((match = fenceRe.exec(value))) {
      if (match.index > cursor) segments.push({ type: 'text', value: value.slice(cursor, match.index) });
      segments.push({ type: 'code', lang: match[1], value: match[2] });
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) segments.push({ type: 'text', value: value.slice(cursor) });
    if (!segments.length) segments.push({ type: 'text', value });

    for (const segment of segments) {
      if (segment.type === 'code') {
        appendCodeBlock(body, segment.lang, segment.value);
        continue;
      }
      renderMarkdownBlocks(body, segment.value);
    }
    if (!body.childNodes.length && value) {
      const p = document.createElement('p');
      appendInlineMarkdown(p, value);
      body.append(p);
    }
  }

  function addMessage(role, text, streaming = false, extras = {}) {
    $('#empty-state').classList.add('hidden');
    $('#conversation').classList.remove('hidden');
    const article = buildMessageNode(role, text, streaming, extras);
    $('#conversation').append(article);
    if (state.followOutput) scrollToLatest();
    const body = article.querySelector('.message-body');
    if (streaming) state.streamingNode = body;
    return body;
  }

  function addEvent(title, detail = '') {
    const card = document.createElement('div');
    card.className = 'event-card';
    const strong = document.createElement('strong');
    strong.textContent = title;
    card.append(strong);
    if (detail) card.append(document.createTextNode(` · ${detail}`));
    $('#conversation').append(card);
    if (state.followOutput) scrollToLatest();
  }

  function historyFingerprint(messages = [], tools = []) {
    // Cheap signature so we only re-paint when disk history actually moved forward.
    let sig = `m${messages.length}:t${tools.length}`;
    for (const message of messages) {
      sig += `|${message.role}:${(message.text || '').length}:${(message.entries || []).length}`;
    }
    for (const tool of tools) {
      sig += `|tool:${tool.id || ''}:${tool.status || ''}:${(tool.detail || '').length}`;
    }
    return sig;
  }

  function normalizeMsgText(text) {
    return String(text || '').trim().replace(/\s+/g, ' ');
  }

  function diskHasUserMessage(messages, opt) {
    const want = normalizeMsgText(opt.text);
    if (!want) return false;
    // Prefer matching the latest user message(s) so older identical texts
    // do not prematurely drop a new optimistic bubble.
    const users = (messages || []).filter((m) => m.role === 'user');
    for (let i = users.length - 1; i >= Math.max(0, users.length - 3); i -= 1) {
      if (normalizeMsgText(users[i].text) === want) return true;
    }
    return false;
  }

  function pruneOptimisticUsers(messages) {
    state.optimisticUsers = (state.optimisticUsers || []).filter((opt) => !diskHasUserMessage(messages, opt));
  }

  function reapplyOptimisticUsers() {
    for (const opt of state.optimisticUsers || []) {
      addMessage('user', opt.text, false, { attachments: opt.attachments || [] });
    }
  }

  function isSystemReminderText(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (t.startsWith('<system-reminder')) return true;
    if (/^Background task\s+"[^"]+"\s+completed/i.test(t)) return true;
    if (t.includes('<system-reminder>') && /Background task/i.test(t)) return true;
    return false;
  }

  function renderOlderBanner() {
    const conversation = $('#conversation');
    if (!conversation || !state.historyHasOlder || !state.sessionId) return;
    const existing = $('#load-older-history');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.className = 'event-card load-older';
    wrap.id = 'load-older-history';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost-btn';
    const olderCount = state.historyMessageOffset;
    btn.textContent = state.historyLoadingOlder
      ? 'Loading earlier messages…'
      : `Load earlier messages (${olderCount} older)`;
    btn.disabled = state.historyLoadingOlder;
    btn.addEventListener('click', () => loadOlderHistory());
    wrap.append(btn);
    conversation.prepend(wrap);
  }

  async function loadOlderHistory() {
    if (!state.sessionId || !state.historyHasOlder || state.historyLoadingOlder) return;
    state.historyLoadingOlder = true;
    renderOlderBanner();
    try {
      const newerCount = Math.max(0, state.historyTotalMessages - state.historyMessageOffset);
      const result = await request(sessionHistoryUrl(state.sessionId, {
        before: newerCount,
        messages: historyPageSize(),
        tools: 0,
      }));
      const older = result.messages || [];
      if (!older.length) {
        state.historyHasOlder = false;
        noteHistoryMeta(result);
        renderOlderBanner();
        return;
      }
      const conversation = $('#conversation');
      const prevHeight = conversation.scrollHeight;
      const prevTop = conversation.scrollTop;
      // Insert older messages above the current transcript (after the banner).
      const fragment = document.createDocumentFragment();
      for (const message of older) {
        if (message.role === 'user') {
          if (isSystemReminderText(message.text)) continue;
          fragment.append(buildMessageNode('user', message.text, false, { images: message.images }));
        } else if (message.role === 'assistant') {
          fragment.append(buildMessageNode('assistant', message.text));
        }
        // Older plan cards are skipped — they are noisy when paging.
      }
      const banner = $('#load-older-history');
      if (banner) banner.after(fragment);
      else conversation.prepend(fragment);
      noteHistoryMeta(result);
      // messageOffset from this page is the start of the older slice — that is the new offset.
      state.historyMessageOffset = Number(result.messageOffset) || 0;
      state.historyHasOlder = state.historyMessageOffset > 0;
      state.historyLoadingOlder = false;
      renderOlderBanner();
      // Preserve scroll position so the viewport does not jump.
      conversation.scrollTop = conversation.scrollHeight - prevHeight + prevTop;
    } catch (error) {
      state.historyLoadingOlder = false;
      renderOlderBanner();
      toast(error.message || 'Could not load earlier messages', 'error');
    }
  }

  function buildMessageNode(role, text, streaming = false, extras = {}) {
    const article = document.createElement('article');
    article.className = `message ${role}`;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? 'Y' : 'G';
    const wrapper = document.createElement('div');
    wrapper.className = 'message-main';
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = role === 'user' ? 'YOU' : 'GROK';
    const body = document.createElement('div');
    body.className = 'message-body';
    if (streaming) {
      body.classList.add('streaming');
      body.textContent = text || '';
    } else {
      renderRichText(body, text || '');
    }
    if (Array.isArray(extras.attachments)) {
      for (const file of extras.attachments) {
        if (file.isImage || /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file.path || file.name || '')) {
          appendImage(body, file.preview || file.path, file.name || 'Attachment');
        } else if (file.path) {
          appendFileChip(body, file.path, file.name);
        }
      }
    }
    if (Array.isArray(extras.images)) {
      for (const image of extras.images) {
        if (image?.omitted) {
          const note = document.createElement('p');
          note.className = 'image-omitted';
          note.textContent = image.alt || 'Large image omitted to save memory';
          body.append(note);
          continue;
        }
        appendImage(body, image.source || image.dataUrl, image.alt || 'Image');
      }
    }
    wrapper.append(label, body);
    article.append(avatar, wrapper);
    return article;
  }

  function renderHistory(messages = [], tools = []) {
    const conversation = $('#conversation');
    conversation.replaceChildren();
    state.streamingNode = null;
    state.streamingMessageId = null;
    resetActivity({ preservePlan: true });
    for (const message of messages) {
      if (message.role === 'user') {
        if (isSystemReminderText(message.text)) {
          // Compact system event — not a real "You" message
          const title = String(message.text).match(/Background task\s+"([^"]+)"/)?.[1]
            ? 'Background task finished'
            : 'System notice';
          addEvent(title, 'Hidden system reminder (not your message)');
          continue;
        }
        addMessage('user', message.text, false, { images: message.images });
      } else if (message.role === 'assistant') addMessage('assistant', message.text);
      else if (message.role === 'plan' && message.entries) renderPlan(message.entries, message.explanation || '');
    }
    // Keep unsent-to-disk user bubbles visible across history reloads.
    reapplyOptimisticUsers();
    // Only paint a bounded tail of tools — full tool history can be 800+ rows.
    const toolCap = historyToolLimit();
    const toolSlice = tools.length > toolCap ? tools.slice(-toolCap) : tools;
    for (const tool of toolSlice) {
      const status = /fail|error/i.test(tool.status || '') ? 'error'
        : /complete|done|success/i.test(tool.status || '') ? 'done' : 'done';
      let detail = tool.detail || '';
      if (!detail && tool.rawInput) {
        try { detail = typeof tool.rawInput === 'string' ? tool.rawInput : JSON.stringify(tool.rawInput, null, 2); }
        catch { detail = String(tool.rawInput); }
      }
      updateActivity(tool.id, { title: tool.title || 'Tool', detail, status });
    }
    capActivityFeedDom();
    state.historyFingerprint = historyFingerprint(messages, tools);
    renderOlderBanner();
    if (!conversation.querySelector('.message') && !conversation.querySelector('.event-card:not(.load-older)')) {
      addEvent('Session opened', 'No prior messages found');
    }
    if (state.followOutput) scrollToLatest();
    else updateJumpButton();
  }

  function finalizeStreamingMessage() {
    if (!state.streamingNode) return;
    renderRichText(state.streamingNode, state.streamingNode.textContent);
    state.streamingNode = null;
    state.streamingMessageId = null;
  }

  /**
   * Append one live stream piece. ACP chunks are normally deltas; rarely a
   * cumulative snapshot. Never invent paragraph breaks between tokens — that
   * used to spam the UI with one word/letter per line.
   */
  function appendStreamPiece(node, piece) {
    if (!node || !piece) return;
    const current = node.textContent || '';
    // Cumulative snapshot: replace instead of appending.
    if (current && piece.length > current.length && piece.startsWith(current)) {
      node.textContent = piece;
      return;
    }
    // Exact duplicate (reconnect / rebroadcast).
    if (piece === current) return;
    // Duplicate tail event.
    if (current && piece.length > 12 && current.endsWith(piece)) return;
    node.textContent = current + piece;
  }

  let scrollRaf = 0;
  function scheduleScrollToLatest() {
    if (!state.followOutput) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      scrollToLatest();
    });
  }

  function lastAssistantText(messages = []) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i].text || '';
    }
    return '';
  }

  /** Only the assistant reply after the latest user message (ignore prior turns). */
  function currentTurnAssistantText(messages = []) {
    let lastUserIdx = -1;
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i].role === 'user') lastUserIdx = i;
    }
    for (let i = messages.length - 1; i > lastUserIdx; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i].text || '';
    }
    return '';
  }

  function syncActivityTools(tools = []) {
    const toolCap = historyToolLimit();
    const toolSlice = tools.length > toolCap ? tools.slice(-toolCap) : tools;
    for (const tool of toolSlice) {
      const status = /fail|error/i.test(tool.status || '') ? 'error'
        : /complete|done|success/i.test(tool.status || '') ? 'done' : 'running';
      let detail = tool.detail || '';
      if (!detail && tool.rawInput) {
        try { detail = typeof tool.rawInput === 'string' ? tool.rawInput : JSON.stringify(tool.rawInput, null, 2); }
        catch { detail = String(tool.rawInput); }
      }
      updateActivity(tool.id, { title: tool.title || 'Tool', detail, status });
    }
    capActivityFeedDom();
  }

  async function resyncSession({ force = false, full = false } = {}) {
    if (!state.sessionId) return;
    // Coalesce concurrent pulls so we never drop a catch-up after a turn ends.
    if (state.resyncInFlight) {
      state.resyncPending = {
        force: Boolean(force || state.resyncPending?.force),
        full: Boolean(full || state.resyncPending?.full),
      };
      return;
    }
    state.resyncInFlight = true;
    try {
      const turnInFlight = state.running || state.awaitingTurn;
      // Mid-turn polls use a tiny tail payload so phones are not re-downloading multi-MB history every 2s.
      const useLite = turnInFlight && !full;
      const result = await request(sessionHistoryUrl(state.sessionId, {
        lite: useLite,
        messages: historyPageSize(),
        tools: historyToolLimit(),
      }));
      const messages = result.messages || [];
      const tools = result.tools || [];
      if (!useLite) noteHistoryMeta(result);
      const nextFp = historyFingerprint(messages, tools);
      const liveText = state.streamingNode ? state.streamingNode.textContent : '';
      const turnAssistant = currentTurnAssistantText(messages);
      const diskAssistant = lastAssistantText(messages);
      const diskAheadOfUi = nextFp !== state.historyFingerprint;
      const diskHasMoreText = turnAssistant.length > (liveText || '').length + 8;

      // Confirm optimistics against disk without requiring a full wipe.
      pruneOptimisticUsers(messages);
      // Keep activity tools fresh even when we skip conversation repaint.
      if (tools.length) syncActivityTools(tools);

      if (turnInFlight) {
        // Critical: never rebuild the conversation mid-turn. Disk history lags and
        // replaceChildren() was wiping the optimistic user bubble until the turn finished.
        // Only soft-catch the stream when disk is clearly ahead and compatible with live text.
        if (
          state.streamingNode
          && turnAssistant.length > (liveText || '').length + 24
          && (!liveText || turnAssistant.startsWith(liveText.slice(0, Math.min(48, liveText.length))))
        ) {
          state.streamingNode.classList.add('streaming');
          state.streamingNode.textContent = turnAssistant;
          scheduleScrollToLatest();
        }
      } else if (diskAheadOfUi || diskHasMoreText || force) {
        const keepFollow = state.followOutput || nearConversationBottom();
        state.followOutput = keepFollow;
        const preserveLive = liveText
          && liveText.length > turnAssistant.length
          && (!turnAssistant || liveText.includes(turnAssistant.slice(0, Math.min(80, turnAssistant.length))) || turnAssistant.length < 40);

        renderHistory(messages, tools);

        if (preserveLive) {
          addMessage('assistant', liveText, true);
        }
      }
      if (result.models) applyModels(result.models);
      // Fresh session history is authoritative. Mobile Safari can keep an
      // apparently-open SSE connection after missing its completion event.
      const active = Boolean(result.active);
      if (active) state.activeSessionIds.add(state.sessionId);
      else state.activeSessionIds.delete(state.sessionId);
      setRunning(active);
      if (!active && state.awaitingTurn && (turnAssistant || diskAssistant)) {
        // Turn finished on disk — stop waiting even if a completion event was missed.
        state.awaitingTurn = false;
        stopResyncLoop();
        // One clean rebuild now that the turn is done and disk should be complete.
        // Prefer a full (bounded) history window rather than the lite tail.
        const fullResult = useLite
          ? await request(sessionHistoryUrl(state.sessionId, {
            messages: historyPageSize(),
            tools: historyToolLimit(),
          }))
          : result;
        const fullMessages = fullResult.messages || messages;
        const fullTools = fullResult.tools || tools;
        noteHistoryMeta(fullResult);
        pruneOptimisticUsers(fullMessages);
        renderHistory(fullMessages, fullTools);
      }
      if (Array.isArray(result.commands) && result.commands.length) state.commands = result.commands;
    } catch (error) {
      // Non-fatal — live SSE may still be working.
      console.warn('resyncSession', error.message);
    } finally {
      state.resyncInFlight = false;
      if (state.resyncPending) {
        const pending = state.resyncPending;
        state.resyncPending = null;
        resyncSession(pending);
      }
    }
  }

  function noteLiveEvent() {
    state.lastEventAt = Date.now();
  }

  function clearCatchupTimers() {
    for (const id of state.catchupTimers) clearTimeout(id);
    state.catchupTimers = [];
  }

  /** Disk history often lags the ACP "turn done" signal — retry a few times. */
  function scheduleCatchupResync() {
    clearCatchupTimers();
    for (const delay of [300, 900, 2000, 4500, 9000]) {
      state.catchupTimers.push(setTimeout(() => {
        resyncSession({ force: true, full: true });
      }, delay));
    }
  }

  function startResyncLoop() {
    stopResyncLoop();
    state.lastEventAt = Date.now();
    // While a turn is open, pull a *lite* disk tail on a short interval.
    // Full history re-downloads were crashing mobile Safari on long sessions.
    state.resyncTimer = setInterval(() => {
      if (!state.sessionId) return;
      if (!state.running && !state.awaitingTurn) return;
      resyncSession({ force: true, full: false });
    }, 2000);
  }

  function stopResyncLoop() {
    if (state.resyncTimer) {
      clearInterval(state.resyncTimer);
      state.resyncTimer = null;
    }
  }

  function applyModels(models) {
    state.models = models;
    const select = $('#model');
    const current = select.value;
    const prefs = state.prefs || loadPrefs();
    select.replaceChildren();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Default model';
    select.append(def);
    const available = models?.availableModels || [];
    for (const model of available) {
      const option = document.createElement('option');
      option.value = model.modelId;
      option.textContent = model.name || model.modelId;
      select.append(option);
    }
    const preferred = current
      || models?.currentModelId
      || prefs.defaultModel
      || '';
    if (preferred && [...select.options].some((o) => o.value === preferred)) select.value = preferred;
    syncPrefModelOptions();
  }

  async function openSession(id) {
    try {
      resetPlan();
      // Bounded history only — long media-tool sessions are multi-MB with 800+ tools.
      const result = await request(sessionHistoryUrl(id, {
        messages: historyPageSize(),
        tools: historyToolLimit(),
      }));
      const session = result.session || {};
      state.sessionId = session.id || id;
      renderMessageQueue();
      localStorage.setItem('grok-webui-active-session', state.sessionId);
      state.optimisticUsers = [];
      state.historyLoadingOlder = false;
      resetSessionUsage();
      state.cwd = session.cwd || state.cwd;
      $('#session-title').textContent = sessionTitle(session);
      $('#session-path').textContent = state.cwd || 'Local workspace';
      $('#active-workspace').textContent = state.cwd || '';
      if (state.cwd && $('#workspace-select')) {
        const option = [...$('#workspace-select').options].find((o) => o.value === state.cwd);
        if (option) $('#workspace-select').value = state.cwd;
      }
      if ($('#pref-system-prompt')) $('#pref-system-prompt').value = workspaceSystemPrompt();
      noteHistoryMeta(result);
      renderHistory(result.messages || [], result.tools || []);
      state.commands = result.commands || state.commands;
      if (result.models) applyModels(result.models);
      if (result.active) state.activeSessionIds.add(state.sessionId);
      else state.activeSessionIds.delete(state.sessionId);
      setRunning(Boolean(result.active));
      renderSessions();
      restoreDraft();
      $('#sidebar').classList.remove('open');
      if (result.messagesTruncated || result.toolsTruncated) {
        const parts = [];
        if (result.totalMessages) parts.push(`${result.messages?.length || 0}/${result.totalMessages} messages`);
        if (result.totalTools) parts.push(`${result.tools?.length || 0}/${result.totalTools} tools`);
        if (parts.length) toast(`Loaded recent history (${parts.join(', ')})`);
      }

      // Load into agent for continued conversation (async; history already painted)
      request(`/api/sessions/${encodeURIComponent(id)}/load`, {
        method: 'POST',
        body: JSON.stringify({ cwd: state.cwd }),
      }).then((loaded) => {
        if (loaded.models) applyModels(loaded.models);
      }).catch((error) => {
        // Session may already be loaded or transient
        console.warn('load session', error.message);
      });
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function newSession() {
    state.sessionId = null;
    localStorage.removeItem('grok-webui-active-session');
    state.streamingNode = null;
    state.streamingMessageId = null;
    state.optimisticUsers = [];
    state.historyFingerprint = '';
    state.historyTotalMessages = 0;
    state.historyMessageOffset = 0;
    state.historyHasOlder = false;
    state.historyLoadingOlder = false;
    resetSessionUsage();
    setRunning(false);
    $('#conversation').replaceChildren();
    resetActivity({ preservePlan: false });
    $('#conversation').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    $('#session-title').textContent = 'New chat';
    state.cwd = $('#workspace-select').value || state.cwd;
    $('#session-path').textContent = state.cwd || 'Choose a workspace to begin';
    $('#active-workspace').textContent = state.cwd || '';
    clearAttachments();
    renderSessions();
    if ($('#message')) $('#message').value = '';
    restoreDraft();
    $('#message').focus();
    $('#sidebar').classList.remove('open');
  }

  async function ensureSession() {
    if (state.sessionId) return state.sessionId;
    const result = await request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        cwd: state.cwd || $('#workspace-select').value,
        modelId: $('#model').value || null,
        permissionMode: (state.prefs || loadPrefs()).permissionMode,
      }),
    });
    state.sessionId = result.sessionId;
    if (!state.sessionId) throw new Error('Grok did not return a session ID');
    localStorage.setItem('grok-webui-active-session', state.sessionId);
    if (result.models) applyModels(result.models);
    if (Array.isArray(result.commands) && result.commands.length) state.commands = result.commands;
    $('#session-path').textContent = state.cwd;
    return state.sessionId;
  }

  async function ensureCommands() {
    if (state.commands.length) return state.commands;
    if (state.commandLoadPromise) return state.commandLoadPromise;
    state.commandLoadPromise = (async () => {
      const sessionId = await ensureSession();
      // Some Grok versions publish commands just after session/new resolves.
      for (const delay of [0, 80, 200, 500]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/commands`);
        if (Array.isArray(result.commands) && result.commands.length) {
          state.commands = result.commands;
          break;
        }
      }
      return state.commands;
    })().finally(() => {
      state.commandLoadPromise = null;
    });
    return state.commandLoadPromise;
  }

  function renderAttachments() {
    const preview = $('#attach-preview');
    preview.replaceChildren();
    if (!state.attachments.length) {
      preview.classList.add('hidden');
      return;
    }
    preview.classList.remove('hidden');
    for (const [index, file] of state.attachments.entries()) {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      if (file.preview) {
        const img = document.createElement('img');
        img.src = file.preview;
        img.alt = file.name;
        chip.append(img);
      }
      const label = document.createElement('span');
      label.textContent = file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        if (file.preview) URL.revokeObjectURL(file.preview);
        state.attachments.splice(index, 1);
        renderAttachments();
      });
      chip.append(label, remove);
      preview.append(chip);
    }
  }

  function clearAttachments() {
    for (const file of state.attachments) {
      if (file.preview) URL.revokeObjectURL(file.preview);
    }
    state.attachments = [];
    renderAttachments();
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function queueFiles(fileList) {
    const files = [...fileList].slice(0, 10);
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) {
        toast(`${file.name} is larger than 25MB`, 'error');
        continue;
      }
      try {
        const dataBase64 = await readFileAsBase64(file);
        const uploaded = await request('/api/upload', {
          method: 'POST',
          body: JSON.stringify({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataBase64,
          }),
        });
        const saved = uploaded.file;
        state.attachments.push({
          name: saved.name,
          path: saved.path,
          mimeType: saved.mimeType,
          isImage: saved.isImage,
          preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        });
      } catch (error) {
        toast(error.message, 'error');
      }
    }
    renderAttachments();
  }

  function hideCommands() {
    $('#command-menu').classList.add('hidden');
    $('#command-menu').replaceChildren();
    state.commandIndex = 0;
  }

  function showCommands(filter = '') {
    const needle = filter.replace(/^\//, '').toLowerCase();
    const matches = (state.commands || [])
      .filter((cmd) => !needle || cmd.name.toLowerCase().includes(needle) || (cmd.description || '').toLowerCase().includes(needle))
      .slice(0, 12);
    const menu = $('#command-menu');
    menu.replaceChildren();
    if (!matches.length) {
      menu.classList.add('hidden');
      return;
    }
    menu.classList.remove('hidden');
    state.commandIndex = 0;
    matches.forEach((cmd, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `command-item${index === 0 ? ' active' : ''}`;
      button.dataset.name = cmd.name;
      const strong = document.createElement('strong');
      strong.textContent = `/${cmd.name}`;
      const span = document.createElement('span');
      span.textContent = cmd.description || '';
      button.append(strong, span);
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        insertCommand(cmd.name);
      });
      menu.append(button);
    });
  }

  function insertCommand(name) {
    const input = $('#message');
    const value = input.value;
    const cursor = input.selectionStart || value.length;
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    const replaced = before.replace(/(^|\s)\/[^\s]*$/, `$1/${name} `);
    input.value = replaced + after;
    input.focus();
    const pos = replaced.length;
    input.setSelectionRange(pos, pos);
    hideCommands();
  }

  async function sendMessage(text) {
    const cleaned = text.trim();
    if ((!cleaned && !state.attachments.length) || state.running) {
      if (state.running && cleaned) toast('Wait for the current turn to finish, or press Stop', 'error');
      return;
    }
    const attachments = state.attachments.map((a) => ({
      name: a.name,
      path: a.path,
      mimeType: a.mimeType,
      isImage: a.isImage,
      preview: a.preview,
    }));
    const optimistic = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: cleaned,
      attachments,
    };
    try {
      const sessionId = await ensureSession();
      state.optimisticUsers.push(optimistic);
      addMessage('user', cleaned, false, { attachments });
      state.followOutput = true;
      scrollToLatest();
      if ($('#session-title').textContent === 'New chat') {
        $('#session-title').textContent = (cleaned || attachments[0]?.name || 'New chat').slice(0, 70);
      }
      setRunning(true);
      state.awaitingTurn = true;
      state.streamingNode = null;
      state.streamingMessageId = null;
      resetActivity({ preservePlan: false });
      updateActivity('turn', { title: 'Turn started', detail: 'Grok is analyzing your request.', kind: 'reasoning', status: 'running' });
      clearCatchupTimers();
      startResyncLoop();
      // Soft pull soon after send — only repaints if disk history actually advanced.
      setTimeout(() => resyncSession({ force: false }), 1200);

      const prefs = state.prefs || loadPrefs();
      const modelId = $('#model').value || prefs.defaultModel || null;
      if (modelId) {
        try { localStorage.setItem('grok-webui-last-model', modelId); } catch { /* ignore */ }
      }
      await request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text: cleaned,
          cwd: state.cwd,
          modelId,
          systemPrompt: workspaceSystemPrompt(),
          amtToolsEnabled: Boolean(prefs.amtToolsEnabled),
          permissionMode: prefs.permissionMode,
          attachments: attachments.map(({ name, path, mimeType }) => ({ name, path, mimeType })),
        }),
      });
      clearAttachments();
      clearDraft();
      setTimeout(loadSessions, 1500);
    } catch (error) {
      state.optimisticUsers = (state.optimisticUsers || []).filter((item) => item.id !== optimistic.id);
      setRunning(false);
      state.awaitingTurn = false;
      stopResyncLoop();
      clearCatchupTimers();
      toast(error.message, 'error');
      if (state.sessionId) resyncSession({ force: true });
    }
  }

  function markTurnComplete(params = {}) {
    const usage = params.update?.usage || params.usage;
    noteTokenUsage(usage);
    const reason = params.stopReason || params.update?.stop_reason || params.update?.stopReason || '';
    updateActivity('turn', { title: 'Turn completed', detail: reason, status: 'done' });
    finalizeStreamingMessage();
    setRunning(false);
    state.awaitingTurn = false;
    stopResyncLoop();
    notifyTurnComplete('Grok finished');
    // Immediate + delayed pulls — disk jsonl often lands slightly after "done".
    resyncSession({ force: true });
    scheduleCatchupResync();
    loadSessions();
    flushMessageQueue();
  }

  function handleGrokEvent(message) {
    noteLiveEvent();
    const method = message.method || '';
    const params = message.params || {};
    const sessionId = params.sessionId;
    const update = params.update || {};
    const updateType = update.sessionUpdate || '';

    if (sessionId && state.sessionId && sessionId !== state.sessionId) {
      // Still track activity for other sessions
      if (method === '_x.ai/queue/changed' && params.runningPromptId) {
        state.activeSessionIds.add(sessionId);
        renderSessions();
        updateRunStatus();
      }
      if (
        method === '_x.ai/session/prompt_complete'
        || updateType === 'turn_completed'
      ) {
        state.activeSessionIds.delete(sessionId);
        renderSessions();
        updateRunStatus();
      }
      return;
    }

    // Live session/update stream (and xAI-prefixed variants)
    if (method === 'session/update' || method === '_x.ai/session/update') {
      if (updateType === 'agent_message_chunk') {
        setRunning(true);
        const piece = update.content?.text || '';
        if (!piece) return;
        const messageId = update.messageId || update.message_id || update.content?.id
          || update.content?.messageId || update.content?.message_id || null;
        if (state.streamingNode && messageId && state.streamingMessageId && messageId !== state.streamingMessageId) {
          finalizeStreamingMessage();
        }
        if (!state.streamingNode) addMessage('assistant', '', true);
        if (messageId) state.streamingMessageId = messageId;
        appendStreamPiece(state.streamingNode, piece);
        scheduleScrollToLatest();
      } else if (updateType === 'agent_thought_chunk') {
        setRunning(true);
        updateActivity('thought', {
          title: 'Reasoning',
          append: update.content?.text || '',
          kind: 'reasoning',
          status: 'running',
        });
        maybeAutoOpenActivity();
      } else if (updateType === 'user_message_chunk') {
        // Real user turns are painted optimistically on send.
        // Grok also injects <system-reminder> blocks as user_message_chunk — ignore those.
        const piece = update.content?.text || '';
        if (isSystemReminderText(piece) || String(piece).trim().startsWith('<system-reminder')) {
          // no-op: do not paint as "You"
        }
      } else if (updateType === 'tool_call') {
        // Close the open assistant bubble so the next status becomes its own message (matches disk history).
        finalizeStreamingMessage();
        setRunning(true);
        const id = update.toolCallId || 'tool';
        const detail = update.rawInput ? JSON.stringify(update.rawInput, null, 2) : '';
        updateActivity(id, {
          title: update.title || update.kind || 'Tool',
          detail,
          kind: 'tool',
          status: update.status === 'failed' ? 'error' : 'running',
        });
        maybeAutoOpenActivity();
      } else if (updateType === 'tool_call_update') {
        setRunning(true);
        const id = update.toolCallId || 'tool';
        let detail;
        if (Array.isArray(update.content)) {
          detail = update.content.map((block) => {
            if (block?.type === 'content' && block.content?.text) return block.content.text;
            if (block?.type === 'text') return block.text || '';
            if (block?._truncated && block.summary) return block.summary;
            return '';
          }).filter(Boolean).join('\n');
        }
        const status = update.status === 'failed' ? 'error'
          : update.status === 'completed' ? 'done' : 'running';
        updateActivity(id, {
          title: update.title || update.kind || 'Tool',
          detail: detail !== undefined ? detail : undefined,
          append: detail === undefined && update.rawInput ? JSON.stringify(update.rawInput) : undefined,
          kind: 'tool',
          status,
        });
      } else if (updateType === 'plan') {
        renderPlan(update.entries || [], update.explanation || '');
        updateActivity('plan', { title: 'Plan', detail: (update.entries || []).map((e) => e.content).join('\n'), kind: 'reasoning' });
      } else if (updateType === 'available_commands_update') {
        state.commands = update.availableCommands || [];
      } else if (updateType === 'usage_update') {
        noteTokenUsage({
          used: update.used,
          totalTokens: update.used,
          size: update.size,
          limit: update.size,
          remaining: update.size != null && update.used != null
            ? Math.max(0, Number(update.size) - Number(update.used))
            : undefined,
          ...update,
        }, { cumulative: true });
      } else if (updateType === 'turn_completed' || updateType === 'task_completed') {
        markTurnComplete(params);
      } else if (updateType === 'task_backgrounded') {
        // Long work continues server-side — keep polling disk so the final reply appears.
        setRunning(true);
        state.awaitingTurn = true;
        startResyncLoop();
        updateActivity('turn', {
          title: 'Running in background',
          detail: 'Still working — updates will appear here',
          kind: 'reasoning',
          status: 'running',
        });
      }
      return;
    }

    if (method === '_x.ai/queue/changed') {
      if (params.runningPromptId) {
        setRunning(true);
        state.awaitingTurn = true;
        startResyncLoop();
      } else if (Array.isArray(params.entries) && params.entries.length === 0 && !params.runningPromptId) {
        // Queue drained — may lag disk; schedule catch-up without treating as hard stop yet.
        scheduleCatchupResync();
      }
      return;
    }

    if (
      method === '_x.ai/session/prompt_complete'
      || (method === '_x.ai/session_notification' && (updateType === 'turn_completed' || updateType === 'task_completed'))
    ) {
      markTurnComplete(params);
      return;
    }

    if (method === '_x.ai/session_notification' && updateType === 'model_changed') {
      if (update.model_id) {
        const select = $('#model');
        if ([...select.options].some((o) => o.value === update.model_id)) {
          select.value = update.model_id;
        }
      }
    }
  }

  function connectEvents() {
    if (state.eventSource) {
      try { state.eventSource.close(); } catch { /* ignore */ }
      state.eventSource = null;
    }
    const source = new EventSource('/api/events');
    state.eventSource = source;
    source.onopen = () => {
      setConnected(true);
      // Catch up on anything missed while the stream was down.
      if (state.sessionId) resyncSession({ force: true });
    };
    source.onerror = () => {
      setConnected(false, 'Reconnecting…');
      // EventSource reconnects automatically; also pull history while offline.
      if (state.sessionId) resyncSession();
    };
    source.onmessage = ({ data }) => {
      let payload;
      try { payload = JSON.parse(data); }
      catch { return; }
      noteLiveEvent();
      if (payload.type === 'connected') {
        state.activeSessionIds = new Set((payload.activeSessions || []).map((s) => s.sessionId));
        renderSessions();
        updateRunStatus();
        if (state.sessionId) resyncSession();
      } else if (payload.type === 'grok_event') {
        handleGrokEvent(payload.event);
      } else if (payload.type === 'prompt_started' && payload.sessionId === state.sessionId) {
        setRunning(true);
        state.awaitingTurn = true;
        startResyncLoop();
      } else if (payload.type === 'prompt_finished' && payload.sessionId === state.sessionId) {
        finalizeStreamingMessage();
        setRunning(false);
        state.awaitingTurn = false;
        stopResyncLoop();
        const usage = payload.result?._meta?.usage || payload.result?.usage;
        noteTokenUsage(usage);
        notifyTurnComplete('Grok finished');
        resyncSession({ force: true });
        scheduleCatchupResync();
        loadSessions();
      } else if (payload.type === 'prompt_error' && payload.sessionId === state.sessionId) {
        setRunning(false);
        state.awaitingTurn = false;
        stopResyncLoop();
        resyncSession({ force: true });
        scheduleCatchupResync();
        toast(payload.message || 'Prompt failed', 'error');
      } else if (payload.type === 'prompt_cancelled' && payload.sessionId === state.sessionId) {
        setRunning(false);
        state.awaitingTurn = false;
        stopResyncLoop();
        clearCatchupTimers();
        finalizeStreamingMessage();
        resyncSession({ force: true });
        updateActivity('turn', { title: 'Turn interrupted', detail: 'Stopped by user', kind: 'reasoning', status: 'error' });
      } else if (payload.type === 'bridge_error') {
        toast(payload.message, 'error');
        setConnected(false, 'Agent offline');
      } else if (payload.type === 'permission_auto') {
        // Auto-approved according to the selected permission preset.
      } else if (payload.type === 'permission_request') {
        state.pendingPermission = payload.request;
        const params = payload.request?.params || {};
        $('#approval-summary').textContent = params.toolCall?.title || params.title || params.toolName || 'Grok wants to run a protected action.';
        $('#approval-drawer').classList.remove('hidden');
      } else if (payload.type === 'ask_user_question') {
        openAskUserModal(payload.request);
      } else if (payload.type === 'exit_plan_mode') {
        openPlanApprovalModal(payload.request, payload.planText || '', payload.planPath || null);
      }
    };
  }

  function hideAskUserModal() {
    $('#ask-user-modal')?.classList.add('hidden');
    state.pendingAskUser = null;
  }

  function hidePlanApprovalModal() {
    $('#plan-approval-modal')?.classList.add('hidden');
    state.pendingPlanApproval = null;
    const feedback = $('#plan-approval-feedback');
    if (feedback) feedback.value = '';
  }

  function openAskUserModal(request) {
    state.pendingAskUser = request;
    const questions = request?.params?.questions || [];
    const root = $('#ask-user-questions');
    if (!root) return;
    root.replaceChildren();
    questions.forEach((q, qi) => {
      const card = document.createElement('article');
      card.className = 'ask-question';
      card.dataset.qi = String(qi);
      const title = document.createElement('h3');
      title.textContent = q.question || q.prompt || `Question ${qi + 1}`;
      card.append(title);
      const optionsWrap = document.createElement('div');
      optionsWrap.className = 'ask-options';
      const multi = Boolean(q.multiSelect || q.multi_select);
      (q.options || []).forEach((opt, oi) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ask-option';
        btn.dataset.label = opt.label || opt.name || `Option ${oi + 1}`;
        btn.dataset.multi = multi ? '1' : '0';
        const label = document.createElement('span');
        label.textContent = opt.label || opt.name || `Option ${oi + 1}`;
        btn.append(label);
        if (opt.description) {
          const desc = document.createElement('small');
          desc.textContent = opt.description;
          btn.append(desc);
        }
        btn.addEventListener('click', () => {
          if (multi) btn.classList.toggle('selected');
          else {
            optionsWrap.querySelectorAll('.ask-option').forEach((el) => el.classList.remove('selected'));
            btn.classList.add('selected');
          }
        });
        optionsWrap.append(btn);
      });
      card.append(optionsWrap);
      const other = document.createElement('input');
      other.type = 'text';
      other.className = 'ask-other';
      other.placeholder = 'Other (optional)';
      other.autocomplete = 'off';
      card.append(other);
      root.append(card);
    });
    $('#ask-user-modal')?.classList.remove('hidden');
  }

  function collectAskUserAnswers() {
    const cards = [...($$('#ask-user-questions .ask-question'))];
    return cards.map((card) => {
      const selected = [...card.querySelectorAll('.ask-option.selected')].map((btn) => btn.dataset.label || btn.textContent.trim());
      const otherRaw = card.querySelector('.ask-other')?.value?.trim() || '';
      return { selected, other: otherRaw || null };
    });
  }

  async function submitAskUser(body) {
    if (!state.pendingAskUser) return;
    const id = state.pendingAskUser.id;
    try {
      await request(`/api/ask-user/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      hideAskUserModal();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function openPlanApprovalModal(request, planText, planPath) {
    state.pendingPlanApproval = request;
    const preview = $('#plan-approval-text');
    if (preview) {
      preview.textContent = planText?.trim()
        || (planPath ? `(No plan content loaded from ${planPath})` : 'No plan written yet.');
    }
    const feedback = $('#plan-approval-feedback');
    if (feedback) feedback.value = '';
    $('#plan-approval-modal')?.classList.remove('hidden');
  }

  async function submitPlanApproval(decision) {
    if (!state.pendingPlanApproval) return;
    const id = state.pendingPlanApproval.id;
    const feedback = $('#plan-approval-feedback')?.value || '';
    try {
      await request(`/api/plan-approval/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify({ decision, feedback }),
      });
      hidePlanApprovalModal();
      toast(decision === 'approve' ? 'Plan approved' : decision === 'quit' ? 'Plan quit' : 'Requested plan changes');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function initialize() {
    try {
      loadPrefs();
      applyPrefsToUi();
      updateUsageStrip();
      const [session, workspaces] = await Promise.all([
        request('/api/session'),
        request('/api/workspaces'),
      ]);
      const select = $('#workspace-select');
      for (const workspace of workspaces.workspaces) {
        const option = document.createElement('option');
        option.value = workspace.path;
        option.textContent = workspace.name;
        select.append(option);
      }
      const preferred = workspaces.workspaces.find((w) => w.name === 'media-tool')
        || workspaces.workspaces[0];
      select.value = preferred.path;
      state.cwd = preferred.path;
      $('#active-workspace').textContent = state.cwd;
      $('#session-path').textContent = state.cwd;
      await request('/api/status');
      setConnected(true);
      connectEvents();
      await loadSessions();
      // Desktop: restore last panel preference. Mobile: stay closed so tools don't cover chat.
      if (isMobileLayout()) {
        setActivityOpen(false, { persist: false });
      } else {
        const prefs = state.prefs || loadPrefs();
        const savedPanel = localStorage.getItem('grok-webui-activity-panel');
        if (prefs.autoActivity === false) setActivityOpen(false, { persist: false });
        else setActivityOpen(savedPanel !== 'closed');
      }
      const saved = localStorage.getItem('grok-webui-active-session');
      const resumable = state.sessions.find((s) => s.id === saved)
        || state.sessions.find((s) => state.activeSessionIds.has(s.id));
      if (resumable) await openSession(resumable.id);
      refreshAmtStatus().catch(() => {});

      // Mobile / background tabs often pause SSE; refresh chat when the page is visible again.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.sessionId) {
          // Prefer lite when a turn is open; full bounded window when idle.
          resyncSession({ force: true, full: !(state.running || state.awaitingTurn) });
          if (state.eventSource?.readyState === EventSource.CLOSED) connectEvents();
        }
      });
      window.addEventListener('focus', () => {
        if (state.sessionId) resyncSession();
      });
      window.addEventListener('pageshow', () => {
        if (state.sessionId) resyncSession({ force: true, full: true });
        connectEvents();
      });
      window.addEventListener('online', () => {
        setConnected(true);
        if (state.eventSource?.readyState === EventSource.CLOSED) connectEvents();
        else if (state.sessionId) resyncSession({ force: true });
      });
    } catch (error) {
      setConnected(false, 'Connection failed');
      toast(error.message, 'error');
    }
  }

  $('#composer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    hideCommands();
    const input = $('#message');
    const text = input.value;
    if (state.running) {
      if (!text.trim() && !state.attachments.length) return;
      state.stagedMessage = { text, attachments: state.attachments.map((file) => ({ ...file })) };
      input.value = '';
      input.style.height = '';
      $('#queue-choice').classList.remove('hidden');
      return;
    }
    input.value = '';
    input.style.height = '';
    sendMessage(text);
  });
  $('#queue-later')?.addEventListener('click', () => enqueueStaged());
  $('#interrupt-send')?.addEventListener('click', () => enqueueStaged({ interrupt: true }));
  $('#cancel-queue-choice')?.addEventListener('click', () => {
    if (state.stagedMessage) $('#message').value = state.stagedMessage.text || '';
    state.stagedMessage = null;
    $('#queue-choice').classList.add('hidden');
  });

  $('#message').addEventListener('keydown', (event) => {
    const menu = $('#command-menu');
    const open = !menu.classList.contains('hidden');
    if (open && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      const items = [...menu.querySelectorAll('.command-item')];
      if (event.key === 'Escape') {
        event.preventDefault();
        hideCommands();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        state.commandIndex = Math.min(items.length - 1, state.commandIndex + 1);
        items.forEach((el, i) => el.classList.toggle('active', i === state.commandIndex));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        state.commandIndex = Math.max(0, state.commandIndex - 1);
        items.forEach((el, i) => el.classList.toggle('active', i === state.commandIndex));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const active = items[state.commandIndex];
        if (active) insertCommand(active.dataset.name);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#composer-form').requestSubmit();
    }
  });

  $('#message').addEventListener('input', async (event) => {
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 190)}px`;
    const value = event.target.value;
    const cursor = event.target.selectionStart || value.length;
    const before = value.slice(0, cursor);
    const slash = before.match(/(?:^|\s)(\/[^\s]*)$/);
    if (slash) {
      try {
        await ensureCommands();
        const currentCursor = event.target.selectionStart || event.target.value.length;
        const currentSlash = event.target.value.slice(0, currentCursor).match(/(?:^|\s)(\/[^\s]*)$/);
        if (currentSlash) showCommands(currentSlash[1]);
      } catch (error) {
        toast(error.message, 'error');
        hideCommands();
      }
    }
    else hideCommands();
  });

  $('#conversation').addEventListener('scroll', () => {
    state.followOutput = nearConversationBottom();
    updateJumpButton();
  }, { passive: true });

  $('#jump-latest').addEventListener('click', () => scrollToLatest('smooth'));
  $('#activity-toggle').addEventListener('click', () => {
    setActivityOpen(!$('.workspace').classList.contains('activity-open'));
  });
  $('#close-activity').addEventListener('click', () => setActivityOpen(false));
  $('#workspace-select').addEventListener('change', (event) => {
    state.cwd = event.target.value;
    $('#session-path').textContent = state.cwd;
    $('#active-workspace').textContent = state.cwd;
  });
  $('#new-thread').addEventListener('click', newSession);
  $('#refresh-sessions').addEventListener('click', loadSessions);
  $('#open-sidebar').addEventListener('click', () => $('#sidebar').classList.add('open'));
  $('#close-sidebar').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  $('#session-search')?.addEventListener('input', () => renderSessions());
  $('#copy-last')?.addEventListener('click', copyLastAssistant);
  $('#export-thread')?.addEventListener('click', exportThreadMarkdown);
  $('#message')?.addEventListener('input', () => saveDraft());
  const TIP_BASE = 'https://agentmediatools.com/tip';
  const tipModal = $('#tip-modal');
  const prefsModal = $('#prefs-modal');
  const galleryModal = $('#gallery-modal');
  let galleryItems = [];

  function humanSize(bytes) {
    return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }
  function renderGallery() {
    const grid = $('#gallery-grid');
    if (!grid) return;
    const filter = $('#gallery-filter')?.value || 'all';
    const files = galleryItems.filter((file) => filter === 'all' || (filter === 'images' ? file.isImage : !file.isImage));
    grid.replaceChildren();
    if (!files.length) {
      const empty = document.createElement('p'); empty.className = 'prefs-hint'; empty.textContent = 'No matching files yet.'; grid.append(empty); return;
    }
    for (const file of files) {
      const card = document.createElement('article'); card.className = 'gallery-card';
      const preview = document.createElement('a'); preview.className = 'gallery-preview';
      preview.href = file.isImage ? `/api/image?path=${encodeURIComponent(file.path)}` : `/api/file?path=${encodeURIComponent(file.path)}`;
      preview.target = '_blank'; preview.rel = 'noopener';
      if (file.isImage && file.mimeType !== 'image/svg+xml') {
        const img = document.createElement('img'); img.src = preview.href; img.alt = file.name; img.loading = 'lazy'; preview.append(img);
      } else preview.textContent = file.isImage ? '▧' : '▤';
      const meta = document.createElement('div'); meta.className = 'gallery-meta';
      const name = document.createElement('div'); name.className = 'gallery-name'; name.title = file.name; name.textContent = file.name;
      const detail = document.createElement('div'); detail.className = 'gallery-detail'; detail.textContent = `${file.source} · ${humanSize(file.size)}`;
      const actions = document.createElement('div'); actions.className = 'gallery-actions';
      for (const [label, href] of [['Open', preview.href], ['Download', `/api/file?path=${encodeURIComponent(file.path)}`]]) {
        const link = document.createElement('a'); link.href = href; link.textContent = label;
        if (label === 'Open') { link.target = '_blank'; link.rel = 'noopener'; }
        actions.append(link);
      }
      meta.append(name, detail, actions); card.append(preview, meta); grid.append(card);
    }
  }
  async function loadGallery() {
    const result = await request(`/api/gallery?cwd=${encodeURIComponent(state.cwd || $('#workspace-select')?.value || '')}`);
    galleryItems = result.files || [];
    renderGallery();
  }

  function openTipModal() {
    if (!tipModal) return;
    tipModal.classList.remove('hidden');
    $('#close-tip')?.focus();
  }
  function closeTipModal() {
    tipModal?.classList.add('hidden');
  }
  function openTipCheckout(amountDollars) {
    const url = new URL(TIP_BASE);
    url.searchParams.set('from', 'grok-webui');
    if (amountDollars) url.searchParams.set('amount', String(amountDollars));
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
    closeTipModal();
  }

  function openPrefsModal() {
    if (!prefsModal) return;
    applyPrefsToUi();
    refreshAmtStatus().catch(() => {});
    prefsModal.classList.remove('hidden');
    $('#close-prefs')?.focus();
  }
  function closePrefsModal() {
    prefsModal?.classList.add('hidden');
  }

  function collectPrefsFromForm() {
    return {
      defaultModel: $('#pref-default-model')?.value || '',
      defaultEffort: $('#pref-default-effort')?.value || '',
      autoScroll: Boolean($('#pref-auto-scroll')?.checked),
      autoActivity: Boolean($('#pref-auto-activity')?.checked),
      density: $('#pref-density')?.value || 'comfortable',
      theme: $('#pref-theme')?.value || 'dark',
      accent: $('#pref-accent')?.value || 'blue',
      amtToolsEnabled: Boolean($('#pref-amt-tools-enabled')?.checked),
      notifyOnComplete: Boolean($('#pref-notify-complete')?.checked),
      permissionMode: $('#pref-permission-mode')?.value || 'moderate',
    };
  }

  function savePrefsFromForm() {
    const partial = collectPrefsFromForm();
    const systemPrompt = $('#pref-system-prompt')?.value || '';
    setWorkspaceSystemPrompt(systemPrompt);
    savePrefs(partial);
    if (partial.defaultModel && $('#model') && [...$('#model').options].some((o) => o.value === partial.defaultModel)) {
      $('#model').value = partial.defaultModel;
    }
    if (partial.defaultEffort && $('#effort')) $('#effort').value = partial.defaultEffort;
    if (partial.notifyOnComplete && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    toast('Preferences saved');
  }

  async function refreshAmtStatus() {
    const statusEl = $('#pref-amt-status');
    const toolsWrap = $('#pref-amt-tools');
    const toolsList = $('#pref-amt-tools-list');
    try {
      const result = await request('/api/amt/status');
      if (!result.connected) {
        state.amtStatus = { connected: false };
        if (statusEl) {
          statusEl.className = 'prefs-amt-status';
          statusEl.textContent = result.message || 'Not connected';
        }
        toolsWrap?.classList.add('hidden');
        updateUsageStrip();
        return result;
      }
      state.amtStatus = { connected: true, ...result };
      if (statusEl) {
        statusEl.className = 'prefs-amt-status ok';
        const rem = result.usage?.remaining ?? '—';
        const lim = result.usage?.limit ?? '—';
        const used = result.usage?.used_today ?? '—';
        const cr = result.credit_balance?.total ?? result.usage_credits ?? '—';
        statusEl.textContent = `Connected (${result.key_prefix || 'key'}) · plan ${result.plan || 'free'} · ${used}/${lim} today (${rem} left) · ${cr} credits`;
      }
      if (toolsWrap && toolsList && Array.isArray(result.tools)) {
        toolsWrap.classList.remove('hidden');
        toolsList.replaceChildren();
        for (const tool of result.tools.slice(0, 40)) {
          const row = document.createElement('div');
          row.className = 'prefs-tool';
          const left = document.createElement('div');
          const name = document.createElement('b');
          name.textContent = tool.id || tool.name || 'tool';
          const desc = document.createElement('div');
          desc.style.color = 'var(--muted)';
          desc.style.fontSize = '.72rem';
          desc.textContent = tool.description || '';
          left.append(name, desc);
          const tier = document.createElement('span');
          const t = String(tool.tier || 'free').toLowerCase();
          tier.className = `tier ${t === 'free' ? 'free' : 'paid'}`;
          tier.textContent = t;
          row.append(left, tier);
          toolsList.append(row);
        }
      }
      updateUsageStrip();
      return result;
    } catch (error) {
      state.amtStatus = { connected: false };
      if (statusEl) {
        statusEl.className = 'prefs-amt-status err';
        statusEl.textContent = error.message || 'Could not load AMT status (restart WebUI if routes are new)';
      }
      updateUsageStrip();
      throw error;
    }
  }

  async function saveAmtKey() {
    const key = ($('#pref-amt-key')?.value || '').trim();
    if (!key) {
      toast('Paste an mt_ agent key first', 'error');
      return;
    }
    await request('/api/amt/connect', { method: 'POST', body: JSON.stringify({ key }) });
    if ($('#pref-amt-key')) $('#pref-amt-key').value = '';
    toast('AMT key saved on this machine');
    await refreshAmtStatus();
  }

  async function clearAmtKey() {
    await request('/api/amt/connect', { method: 'DELETE', body: '{}' });
    state.amtStatus = { connected: false };
    $('#pref-amt-tools')?.classList.add('hidden');
    const statusEl = $('#pref-amt-status');
    if (statusEl) {
      statusEl.className = 'prefs-amt-status';
      statusEl.textContent = 'Disconnected';
    }
    updateUsageStrip();
    toast('AMT disconnected');
  }

  $('#open-tip')?.addEventListener('click', openTipModal);
  $('#close-tip')?.addEventListener('click', closeTipModal);
  tipModal?.addEventListener('click', (event) => {
    if (event.target === tipModal) closeTipModal();
  });
  $('#open-prefs')?.addEventListener('click', openPrefsModal);
  $('#open-gallery')?.addEventListener('click', () => {
    galleryModal?.classList.remove('hidden');
    loadGallery().catch((error) => toast(error.message, 'error'));
  });
  $('#close-gallery')?.addEventListener('click', () => galleryModal?.classList.add('hidden'));
  $('#refresh-gallery')?.addEventListener('click', () => loadGallery().catch((error) => toast(error.message, 'error')));
  $('#gallery-filter')?.addEventListener('change', renderGallery);
  galleryModal?.addEventListener('click', (event) => { if (event.target === galleryModal) galleryModal.classList.add('hidden'); });
  $$('[data-permission]').forEach((button) => button.addEventListener('click', async () => {
    if (!state.pendingPermission) return;
    try {
      await request(`/api/permissions/${encodeURIComponent(state.pendingPermission.id)}`, {
        method: 'POST', body: JSON.stringify({ decision: button.dataset.permission }),
      });
      state.pendingPermission = null;
      $('#approval-drawer').classList.add('hidden');
    } catch (error) { toast(error.message, 'error'); }
  }));

  $('#ask-user-submit')?.addEventListener('click', () => {
    submitAskUser({ answers: collectAskUserAnswers(), partial_answers: [] });
  });
  $('#ask-user-skip')?.addEventListener('click', () => submitAskUser({ skip: true }));
  $('#ask-user-dismiss')?.addEventListener('click', () => submitAskUser({ skip: true }));
  $('#ask-user-chat')?.addEventListener('click', () => submitAskUser({ chatAboutThis: true }));
  $('#ask-user-modal')?.addEventListener('click', (event) => {
    if (event.target === $('#ask-user-modal')) submitAskUser({ skip: true });
  });

  $('#plan-approve')?.addEventListener('click', () => submitPlanApproval('approve'));
  $('#plan-request-changes')?.addEventListener('click', () => submitPlanApproval('request_changes'));
  $('#plan-quit')?.addEventListener('click', () => submitPlanApproval('quit'));
  $('#plan-approval-dismiss')?.addEventListener('click', () => submitPlanApproval('quit'));
  $('#plan-approval-modal')?.addEventListener('click', (event) => {
    if (event.target === $('#plan-approval-modal')) submitPlanApproval('quit');
  });

  $('#close-prefs')?.addEventListener('click', closePrefsModal);
  prefsModal?.addEventListener('click', (event) => {
    if (event.target === prefsModal) closePrefsModal();
  });
  $('#pref-save')?.addEventListener('click', () => {
    savePrefsFromForm();
    closePrefsModal();
  });
  $('#pref-amt-save')?.addEventListener('click', () => {
    saveAmtKey().catch((e) => toast(e.message, 'error'));
  });
  $('#pref-amt-clear')?.addEventListener('click', () => {
    clearAmtKey().catch((e) => toast(e.message, 'error'));
  });
  $('#pref-amt-refresh')?.addEventListener('click', () => {
    refreshAmtStatus().catch((e) => toast(e.message, 'error'));
  });
  $('#pref-theme')?.addEventListener('change', () => {
    document.body.dataset.theme = $('#pref-theme').value === 'light' ? 'light' : 'dark';
  });
  $('#pref-accent')?.addEventListener('change', () => {
    document.body.dataset.accent = $('#pref-accent').value || 'blue';
  });
  $('#model')?.addEventListener('change', () => {
    const value = $('#model').value || '';
    if (value) savePrefs({ defaultModel: value });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (tipModal && !tipModal.classList.contains('hidden')) closeTipModal();
    if (prefsModal && !prefsModal.classList.contains('hidden')) closePrefsModal();
    if ($('#ask-user-modal') && !$('#ask-user-modal').classList.contains('hidden')) {
      submitAskUser({ skip: true });
    }
    if ($('#plan-approval-modal') && !$('#plan-approval-modal').classList.contains('hidden')) {
      submitPlanApproval('quit');
    }
  });
  $$('[data-tip-amount]').forEach((button) => {
    button.addEventListener('click', () => openTipCheckout(button.dataset.tipAmount));
  });
  $('#tip-custom')?.addEventListener('click', () => openTipCheckout());

  $('#logout').addEventListener('click', async () => {
    await request('/api/logout', { method: 'POST', body: '{}' });
    location.href = '/login.html';
  });
  $('#interrupt').addEventListener('click', async () => {
    if (!state.sessionId) return;
    try {
      await request(`/api/sessions/${encodeURIComponent(state.sessionId)}/cancel`, {
        method: 'POST',
        body: '{}',
      });
      setRunning(false);
      updateActivity('turn', { title: 'Turn interrupted', detail: 'Stopped by user', kind: 'reasoning', status: 'error' });
      maybeAutoOpenActivity();
      flushMessageQueue();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#attach-button').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (event) => {
    await queueFiles(event.target.files || []);
    event.target.value = '';
  });

  // Drag & drop + paste images
  const composer = $('#composer-form');
  composer.addEventListener('dragover', (event) => {
    event.preventDefault();
    composer.classList.add('drag');
  });
  composer.addEventListener('dragleave', () => composer.classList.remove('drag'));
  composer.addEventListener('drop', async (event) => {
    event.preventDefault();
    composer.classList.remove('drag');
    if (event.dataTransfer?.files?.length) await queueFiles(event.dataTransfer.files);
  });
  $('#message').addEventListener('paste', async (event) => {
    const items = [...(event.clipboardData?.items || [])];
    const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) {
      event.preventDefault();
      await queueFiles(files);
    }
  });

  $$('.suggestions button').forEach((button) => {
    button.addEventListener('click', () => sendMessage(button.dataset.prompt));
  });

  loadMessageQueue();
  initialize();
}
