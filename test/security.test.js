'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

test('server binds to an explicitly configured host and uses local stdio agent', () => {
  assert.match(server, /server\.listen\(PORT, HOST/);
  assert.match(server, /spawn\(grokBin, \['agent', '--no-leader', 'stdio'\]/);
  assert.doesNotMatch(server, /--always-approve/);
  assert.doesNotMatch(server, /0\.0\.0\.0/);
});

test('authentication uses a timing-safe password hash and HttpOnly strict cookies', () => {
  assert.match(server, /crypto\.scryptSync/);
  assert.match(server, /crypto\.timingSafeEqual/);
  assert.match(server, /HttpOnly; SameSite=Strict/);
  assert.match(server, /grok_webui_session/);
  assert.match(server, /function setupRequired/);
  assert.match(server, /pathname === '\/api\/setup'/);
  assert.match(server, /pathname === '\/api\/auth-status'/);
  assert.match(server, /function verifyCredentials/);
  // Must not hard-exit when credentials are missing — first-run setup is allowed.
  assert.doesNotMatch(server, /Missing PASSWORD_SALT or PASSWORD_HASH/);
});

test('hashed login sessions persist across service restarts', () => {
  assert.match(server, /auth-sessions\.json/);
  assert.match(server, /createHash\('sha256'\)/);
  assert.match(server, /function loadSessions\(\)/);
  assert.match(server, /function saveSessions\(\)/);
});

test('system-reminder user_message chunks are filtered from chat transcript', () => {
  assert.match(app, /function isSystemReminderText/);
  assert.match(app, /Hidden system reminder/);
  assert.match(server, /function isSystemReminderText/);
  assert.match(server, /system-reminder/);
});

test('ship-quality session board, export, and draft helpers exist', () => {
  assert.match(html, /id="fleet-strip"/);
  assert.match(html, /id="session-search"/);
  assert.match(html, /id="export-thread"/);
  assert.match(html, /id="copy-last"/);
  assert.match(app, /function updateFleetStrip/);
  assert.match(app, /function exportThreadMarkdown/);
  assert.match(app, /function notifyTurnComplete/);
  assert.match(app, /function saveDraft/);
});

test('preferences, usage strip, and AMT bridge surfaces exist', () => {
  assert.match(html, /id="prefs-modal"/);
  assert.match(html, /id="session-tokens"/);
  assert.match(html, /id="provider-usage"/);
  assert.match(html, /id="amt-usage"/);
  assert.match(html, /id="pref-system-prompt"/);
  assert.match(html, /id="pref-theme"/);
  assert.match(app, /function loadPrefs/);
  assert.match(app, /function noteTokenUsage/);
  assert.match(app, /function workspaceSystemPrompt/);
  assert.match(app, /\/api\/amt\/status/);
  assert.match(server, /pathname === '\/api\/amt\/status'/);
  assert.match(server, /pathname === '\/api\/amt\/connect'/);
  assert.match(server, /systemPrompt/);
  assert.match(server, /amtToolsHint/);
});

test('stream chunks append without inventing paragraph breaks between tokens', () => {
  assert.match(app, /function appendStreamPiece/);
  assert.match(app, /Never invent paragraph breaks between tokens/);
  assert.doesNotMatch(app, /Separate paragraph-style status chunks that arrive without tools/);
  assert.doesNotMatch(app, /textContent \+= '\\\\n\\\\n'/);
});

test('optimistic user messages survive history resync until disk catches up', () => {
  assert.match(app, /optimisticUsers/);
  assert.match(app, /function pruneOptimisticUsers/);
  assert.match(app, /function reapplyOptimisticUsers/);
  assert.match(app, /function currentTurnAssistantText/);
  assert.match(app, /never rebuild the conversation mid-turn/i);
  assert.match(app, /const turnInFlight = state\.running \|\| state\.awaitingTurn/);
});

test('chat messages render lightweight markdown into safe DOM (not raw pre-wrap only)', () => {
  assert.match(app, /function renderRichText/);
  assert.match(app, /function appendInlineMarkdown/);
  assert.match(app, /function renderMarkdownBlocks/);
  assert.match(app, /md-code-block/);
  assert.match(app, /safeHref/);
  assert.doesNotMatch(app, /body\.innerHTML\s*=/);
  const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
  assert.match(css, /\.message-body\.streaming/);
  assert.match(css, /\.md-code-block/);
});

test('optional tip modal is free framing and opens AMT tip page externally', () => {
  assert.match(html, /id="tip-modal"/);
  assert.match(html, /Free forever — optional tip/);
  assert.match(html, /Nothing unlocks; no account required/);
  assert.match(html, /data-tip-amount="3"/);
  assert.match(html, /data-tip-amount="7"/);
  assert.match(html, /data-tip-amount="15"/);
  assert.match(app, /agentmediatools\.com\/tip/);
  assert.match(app, /from', 'grok-webui'/);
  assert.doesNotMatch(html, /premium tier|pro plan|paywall/i);
});

test('login page supports first-run setup and saved username/password', () => {
  const loginHtml = fs.readFileSync(path.join(root, 'public/login.html'), 'utf8');
  assert.match(loginHtml, /id="setup-form"/);
  assert.match(loginHtml, /id="login-form"/);
  assert.match(loginHtml, /id="username"/);
  assert.match(loginHtml, /autocomplete="username"/);
  assert.match(loginHtml, /autocomplete="new-password"/);
  assert.match(loginHtml, /autocomplete="current-password"/);
  assert.match(app, /initAuthPage/);
  assert.match(app, /\/api\/auth-status/);
  assert.match(app, /\/api\/setup/);
});

test('state-changing requests enforce same-origin checks', () => {
  assert.match(server, /function sameOrigin/);
  assert.match(server, /Origin rejected/);
});

test('workspaces and uploads are constrained to allowed roots', () => {
  assert.match(server, /startsWith\(`\$\{WORKSPACE_ROOT\}\$\{path\.sep\}`\)/);
  assert.match(server, /Workspace is outside the allowed root/);
  assert.match(server, /Path is outside the allowed workspace/);
});

test('UI does not load third-party scripts', () => {
  assert.doesNotMatch(html, /<script[^>]+https?:/);
  assert.match(html, /id="attach-button"/);
  assert.match(html, /id="command-menu"/);
  assert.match(html, /id="activity-rail"/);
});

test('UI restores the selected session and tracks activity', () => {
  assert.match(app, /localStorage\.setItem\('grok-webui-active-session'/);
  assert.match(app, /\/api\/activity/);
  assert.match(app, /running in background/);
  assert.match(server, /activeSessions = new Map/);
});

test('execution plans remain legible and survive history resyncs for the full turn', () => {
  const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
  assert.match(html, /Execution plan/);
  assert.match(app, /currentPlan/);
  assert.match(app, /normalizePlanStatus/);
  assert.match(app, /resetActivity\(\{ preservePlan: true \}\)/);
  assert.match(app, /aria-current/);
  assert.match(css, /\.plan-step\.in-progress/);
  assert.match(css, /\.plan-step\.completed/);
  assert.doesNotMatch(css, /\.plan-step\.completed[^}]*text-decoration:\s*line-through/s);
});

test('session history payloads are bounded for mobile-safe loading', () => {
  assert.match(server, /HISTORY_DEFAULT_MESSAGES/);
  assert.match(server, /HISTORY_DEFAULT_TOOLS/);
  assert.match(server, /HISTORY_LITE_MESSAGES/);
  assert.match(server, /function coalesceHistory/);
  assert.match(server, /messagesTruncated/);
  assert.match(server, /toolsTruncated/);
  assert.match(server, /searchParams\.get\('lite'\)/);
  assert.match(app, /function sessionHistoryUrl/);
  assert.match(app, /function loadOlderHistory/);
  assert.match(app, /function capActivityFeedDom/);
  assert.match(app, /historyToolLimit/);
  assert.match(app, /lite: useLite/);
  assert.match(app, /Full history re-downloads were crashing mobile Safari/);
});

test('live chat resyncs when SSE stalls and handles turn_completed', () => {
  assert.match(app, /function resyncSession/);
  assert.match(app, /function startResyncLoop/);
  assert.match(app, /turn_completed/);
  assert.match(app, /_x\.ai\/session\/update/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /Fresh session history is authoritative/);
  assert.doesNotMatch(app, /Boolean\(result\.active\) \|\| state\.activeSessionIds\.has/);
  assert.match(app, /window\.addEventListener\('pageshow'/);
  assert.match(server, /function slimGrokEvent/);
  assert.match(server, /X-Accel-Buffering/);
});

test('tool activity stays in the activity rail, not the chat transcript', () => {
  assert.match(app, /function updateActivity/);
  assert.match(app, /kind: 'tool'/);
  // Live tool_call must not inject event cards into #conversation
  assert.doesNotMatch(app, /tool_call[\s\S]{0,400}addEvent\(/);
});

test('routine reasoning and file activity never spam the chat transcript', () => {
  assert.match(app, /updateActivity\('thought'/);
  assert.match(app, /updateActivity\(id,/);
  assert.doesNotMatch(app, /addEvent\(`Started \$\{type\}`\)/);
  assert.doesNotMatch(app, /addEvent\('Command completed'/);
  assert.match(app, /agent_message_chunk/);
  assert.match(app, /addMessage\('assistant'/);
});

test('live assistant chunks keep provider message boundaries when available', () => {
  assert.match(app, /streamingMessageId/);
  assert.match(app, /messageId !== state\.streamingMessageId/);
  assert.match(app, /finalizeStreamingMessage\(\)/);
  assert.match(server, /openAgent\.messageId/);
});

test('mobile does not auto-open the full-screen activity rail on tool use', () => {
  assert.match(app, /function isMobileLayout/);
  assert.match(app, /function maybeAutoOpenActivity/);
  assert.match(app, /max-width: 760px/);
  // Tool/thought streams must auto-open via the mobile-gated helper, not setActivityOpen(true)
  assert.match(app, /updateType === 'tool_call'[\s\S]{0,800}maybeAutoOpenActivity\(\)/);
  assert.match(app, /updateType === 'agent_thought_chunk'[\s\S]{0,400}maybeAutoOpenActivity\(\)/);
  assert.doesNotMatch(app, /updateType === 'tool_call'[\s\S]{0,800}setActivityOpen\(true\)/);
  assert.doesNotMatch(app, /updateType === 'agent_thought_chunk'[\s\S]{0,400}setActivityOpen\(true\)/);
  // Mobile init keeps the rail closed without clobbering desktop localStorage preference
  assert.match(app, /isMobileLayout\(\)[\s\S]{0,120}setActivityOpen\(false,\s*\{\s*persist:\s*false\s*\}\)/);
});

test('mobile keyboard panning keeps the composer inside the visible viewport', () => {
  const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
  const viewport = fs.readFileSync(path.join(root, 'public/viewport.js'), 'utf8');
  assert.match(css, /top: var\(--app-top, 0px\)/);
  assert.match(css, /width: var\(--app-width, 100vw\)/);
  assert.match(css, /overflow-anchor: none/);
  assert.match(viewport, /visualViewport/);
  assert.match(viewport, /offsetTop/);
  assert.match(app, /function keepLatestVisibleWhileTyping/);
  assert.match(app, /visualViewport\?\.addEventListener\('resize', restoreLatest\)/);
});

test('attachments and media stay on authenticated endpoints', () => {
  assert.match(server, /pathname === '\/api\/upload'/);
  assert.match(server, /pathname === '\/api\/image'/);
  assert.match(server, /pathname === '\/api\/file'/);
  assert.match(app, /\/api\/image\?path=/);
  assert.match(app, /\/api\/file\?path=/);
  assert.doesNotMatch(app, /innerHTML\s*=/);
});

test('gallery and real permission presets are wired through server and UI', () => {
  assert.match(server, /function normalizePermissionMode/);
  assert.match(server, /permission_request/);
  assert.match(server, /pathname\.match\(\/\^\\\/api\\\/permissions/);
  assert.match(server, /pathname === '\/api\/gallery'/);
  assert.match(html, /id="pref-permission-mode"/);
  assert.match(html, /id="gallery-modal"/);
  assert.match(html, /id="approval-drawer"/);
  assert.match(app, /permissionMode/);
  assert.match(app, /function renderGallery/);
});

test('ask_user_question and exit_plan_mode are handled interactively', () => {
  assert.match(server, /askUserQuestion:\s*true/);
  assert.match(server, /_x\.ai\/ask_user_question/);
  assert.match(server, /_x\.ai\/exit_plan_mode/);
  assert.match(server, /pathname\.match\(\/\^\\\/api\\\/ask-user/);
  assert.match(server, /pathname\.match\(\/\^\\\/api\\\/plan-approval/);
  assert.match(server, /function buildAskUserResult/);
  assert.match(server, /function buildPlanApprovalResult/);
  assert.match(server, /partial_answers/);
  assert.match(server, /type: 'ask_user_question'/);
  assert.match(server, /type: 'exit_plan_mode'/);
  // JSON-RPC id type must match the agent request (use pending.id, not URL string).
  assert.match(server, /bridge\.respond\(pending\.id,/);
  assert.match(server, /typeof=\s*',\s*typeof pending\.id/);
  assert.match(html, /id="ask-user-modal"/);
  assert.match(html, /id="plan-approval-modal"/);
  assert.match(html, /id="ask-user-submit"/);
  assert.match(html, /id="plan-approve"/);
  assert.match(app, /openAskUserModal/);
  assert.match(app, /openPlanApprovalModal/);
  assert.match(app, /\/api\/ask-user\//);
  assert.match(app, /\/api\/plan-approval\//);
  assert.match(app, /ask_user_question/);
  assert.match(app, /exit_plan_mode/);
});

test('exit_plan_mode ExtResponse uses Grok 1.0.52 outcome tokens', () => {
  const start = server.indexOf('function buildPlanApprovalResult');
  const end = server.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const body = server.slice(start, end);
  assert.match(body, /outcome:\s*'approved'/);
  assert.match(body, /outcome:\s*'cancelled'/);
  assert.match(body, /outcome:\s*'abandoned'/);
  assert.match(body, /fail open as cancelled/);
  assert.doesNotMatch(body, /return \{ decision,\s*feedback \}/);

  const fn = new Function(`${body}; return buildPlanApprovalResult;`)();
  assert.deepEqual(fn({ decision: 'approve' }), { outcome: 'approved' });
  assert.deepEqual(fn({ decision: 'approve', feedback: '  ' }), { outcome: 'approved' });
  assert.deepEqual(fn({ decision: 'approve', feedback: 'ship it' }), {
    outcome: 'approved',
    feedback: 'ship it',
  });
  assert.deepEqual(fn({ decision: 'request_changes', feedback: 'add tests' }), {
    outcome: 'cancelled',
    feedback: 'add tests',
  });
  assert.deepEqual(fn({ decision: 'quit' }), { outcome: 'abandoned' });
  assert.deepEqual(fn({ outcome: 'abandoned' }), { outcome: 'abandoned' });
  assert.deepEqual(fn({}), { outcome: 'cancelled' });
  assert.deepEqual(fn({ decision: 'nope' }), { outcome: 'cancelled' });

  assert.match(app, /JSON\.stringify\(\{ decision, feedback \}\)/);
});

test('chat media resolves session-relative paths and serves GROK_HOME artifacts', () => {
  assert.match(app, /function resolveLocalPath/);
  assert.match(app, /state\.cwd/);
  assert.match(app, /file:\/\//);
  assert.match(server, /function mediaRoots/);
  assert.match(server, /GROK_HOME/);
});

test('slash commands and file paste/drag are supported in the composer', () => {
  assert.match(app, /function showCommands/);
  assert.match(app, /async function ensureCommands/);
  assert.match(app, /await ensureCommands\(\)/);
  assert.match(server, /commands: bridge\.availableCommands\.get\(result\.sessionId\)/);
  assert.match(app, /function queueFiles/);
  assert.match(app, /clipboardData/);
  assert.match(app, /dataTransfer/);
});

test('long conversations remain scrollable with jump-to-latest', () => {
  assert.match(html, /id="jump-latest"/);
  assert.match(app, /function scrollToLatest/);
  assert.match(app, /followOutput/);
});

test('messages can be queued or interrupt the active turn without being lost on refresh', () => {
  assert.match(html, /id="message-queue"/);
  assert.match(html, /id="interrupt-send"/);
  assert.match(app, /QUEUE_KEY/);
  assert.match(app, /function enqueueStaged/);
  assert.match(app, /function flushMessageQueue/);
  assert.match(app, /localStorage\.setItem\(QUEUE_KEY/);
});

test('cancel is exposed for in-flight turns', () => {
  assert.match(server, /session\/cancel/);
  assert.match(app, /\/cancel/);
  assert.match(html, /id="interrupt"/);
});

function loadSessionCloseHelpers() {
  const start = server.indexOf('function isSessionCloseUnsupportedError');
  const end = server.indexOf('\nclass GrokBridge');
  assert.ok(start >= 0 && end > start, 'session close helpers should sit above GrokBridge');
  const body = server.slice(start, end);
  return new Function(`${body}; return { isSessionCloseUnsupportedError, dropLoadedSessionMaps, closeOrDropSession };`)();
}

test('session/close helper closes ACP tokens, skips in-flight, and falls back when the method is missing', async () => {
  assert.match(server, /session\/close/);
  assert.match(server, /request\('session\/close', \{ sessionId: id \}/);
  assert.match(server, /type: 'session_unloaded'/);
  assert.match(server, /unloadLoadedSessions/);
  assert.match(server, /reason: 'logout'/);
  assert.match(server, /reason: 'shutdown'/);
  assert.match(server, /unloadMatch/);
  assert.match(server, /\/unload\$/);
  assert.match(app, /\/unload/);
  assert.match(app, /session_unloaded/);
  assert.doesNotMatch(app, /session\/close/);
  assert.doesNotMatch(server, /sessionMatch && req\.method === 'DELETE'/);

  const {
    isSessionCloseUnsupportedError,
    dropLoadedSessionMaps,
    closeOrDropSession,
  } = loadSessionCloseHelpers();

  assert.equal(isSessionCloseUnsupportedError({ rpc: { code: -32601, message: 'Method not found' } }), true);
  assert.equal(isSessionCloseUnsupportedError(Object.assign(new Error('Unknown method: session/close'), { code: -32601 })), true);
  assert.equal(isSessionCloseUnsupportedError(new Error('Grok request timed out: session/close')), false);

  const maps = {
    loadedSessions: new Set(['keep']),
    availableCommands: new Map([['keep', []], ['gone', []]]),
    modelsBySession: new Map([['gone', { id: 1 }]]),
    permissionModes: new Map([['gone', 'moderate']]),
  };
  dropLoadedSessionMaps(maps, 'gone');
  assert.equal(maps.availableCommands.has('gone'), false);
  assert.equal(maps.loadedSessions.has('keep'), true);

  const closed = [];
  const target = {
    activeSessions: new Map(),
    loadedSessions: new Set(['abc']),
    availableCommands: new Map([['abc', []]]),
    modelsBySession: new Map([['abc', {}]]),
    permissionModes: new Map([['abc', 'moderate']]),
    sessionCloseUnsupported: false,
  };

  const ok = await closeOrDropSession(target, 'abc', {
    requestClose: async (id) => { closed.push({ sessionId: id }); },
  });
  assert.equal(ok.skipped, false);
  assert.equal(ok.closed, true);
  assert.deepEqual(closed, [{ sessionId: 'abc' }]);
  assert.equal(target.loadedSessions.has('abc'), false);
  assert.equal(target.availableCommands.has('abc'), false);

  target.activeSessions.set('busy', { sessionId: 'busy' });
  target.loadedSessions.add('busy');
  const skip = await closeOrDropSession(target, 'busy', {
    requestClose: async () => { throw new Error('should not close in-flight'); },
  });
  assert.equal(skip.skipped, true);
  assert.equal(skip.reason, 'in_flight');
  assert.equal(target.loadedSessions.has('busy'), true);

  target.loadedSessions.add('old');
  const missing = await closeOrDropSession(target, 'old', {
    requestClose: async () => {
      throw Object.assign(new Error('Method not found'), {
        rpc: { code: -32601, message: 'Method not found' },
      });
    },
  });
  assert.equal(missing.closed, false);
  assert.equal(missing.unsupported, true);
  assert.equal(target.sessionCloseUnsupported, true);
  assert.equal(target.loadedSessions.has('old'), false);

  let laterCalls = 0;
  target.loadedSessions.add('later');
  const remembered = await closeOrDropSession(target, 'later', {
    requestClose: async () => { laterCalls += 1; },
  });
  assert.equal(laterCalls, 0);
  assert.equal(remembered.closed, false);
  assert.equal(target.loadedSessions.has('later'), false);
});

test('idle unload times out loaded sessions, skips in-flight prompts, and honors SESSION_IDLE_MS', () => {
  assert.match(server, /SESSION_IDLE_MS/);
  assert.match(server, /lastActivityAt/);
  assert.match(server, /unloadIdleSessions/);
  assert.match(server, /reason: 'idle'/);
  assert.match(server, /touchActivity/);
  assert.match(server, /startSessionIdleWatcher/);

  const eventsStart = server.indexOf("pathname === '/api/events'");
  const eventsEnd = server.indexOf("pathname === '/api/image'");
  assert.ok(eventsStart >= 0 && eventsEnd > eventsStart);
  const events = server.slice(eventsStart, eventsEnd);
  assert.match(events, /: ping /);
  assert.doesNotMatch(events, /touchActivity|lastActivityAt/);

  const start = server.indexOf('function parseSessionIdleMs');
  const end = server.indexOf('\nclass GrokBridge');
  assert.ok(start >= 0 && end > start);
  const body = server.slice(start, end);
  const { parseSessionIdleMs, idleUnloadCandidates } = new Function(
    `${body}; return { parseSessionIdleMs, idleUnloadCandidates };`,
  )();

  assert.equal(parseSessionIdleMs(undefined), 20 * 60 * 1000);
  assert.equal(parseSessionIdleMs('not-a-number'), 20 * 60 * 1000);
  assert.equal(parseSessionIdleMs('600000'), 600000);
  assert.equal(parseSessionIdleMs('60000'), 5 * 60 * 1000);
  assert.equal(parseSessionIdleMs('7200000'), 60 * 60 * 1000);

  const now = 1_000_000;
  const idleMs = 20 * 60 * 1000;
  const target = {
    loadedSessions: new Set(['idle', 'fresh', 'busy']),
    activeSessions: new Map([['busy', { sessionId: 'busy' }]]),
    lastActivityAt: new Map([
      ['idle', now - idleMs - 1],
      ['fresh', now - 1000],
      ['busy', now - idleMs - 1],
    ]),
  };
  assert.deepEqual(idleUnloadCandidates(target, { idleMs, now }), ['idle']);
});
