'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = __dirname;
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const UPLOAD_ROOT = path.join(PROJECT_ROOT, 'data', 'uploads');
const SESSION_STORE = path.join(PROJECT_ROOT, 'data', 'auth-sessions.json');
const AMT_STORE = path.join(PROJECT_ROOT, 'data', 'amt.json');
const AMT_BASE = process.env.AMT_BASE_URL || 'https://agentmediatools.com';

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

loadEnv(path.join(PROJECT_ROOT, '.env'));

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4546);
const WORKSPACE_ROOT = fs.realpathSync(process.env.WORKSPACE_ROOT || os.homedir());
const GROK_HOME = process.env.GROK_HOME || path.join(process.env.HOME || '', '.grok');
const SESSIONS_ROOT = path.join(GROK_HOME, 'sessions');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const SESSION_HOURS = Math.min(168, Math.max(1, Number(process.env.SESSION_HOURS || 24)));
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_GALLERY_FILES = 200;
const USERNAME_RE = /^[A-Za-z0-9._@+-]{1,64}$/;

// Mutable auth state — can be filled at first-run setup without restarting.
let authUsername = String(process.env.WEBUI_USERNAME || '').trim();
let passwordSalt = process.env.PASSWORD_SALT || '';
let passwordHash = process.env.PASSWORD_HASH || '';

const sessions = new Map();
const loginAttempts = new Map();
const sseClients = new Set();

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

function sessionKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function saveSessions() {
  const now = Date.now();
  for (const [key, expires] of sessions) if (expires < now) sessions.delete(key);
  const temporary = `${SESSION_STORE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...sessions]), { mode: 0o600 });
  fs.renameSync(temporary, SESSION_STORE);
}

function loadSessions() {
  try {
    const saved = JSON.parse(fs.readFileSync(SESSION_STORE, 'utf8'));
    const now = Date.now();
    for (const entry of saved) {
      if (Array.isArray(entry) && /^[a-f0-9]{64}$/.test(entry[0]) && Number(entry[1]) > now) {
        sessions.set(entry[0], Number(entry[1]));
      }
    }
    saveSessions();
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not restore login sessions: ${error.message}`);
  }
}

loadSessions();

function setupRequired() {
  return !passwordSalt || !passwordHash;
}

function timingSafeEqualHex(a, b) {
  try {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // Compare against self so length leaks don't short-circuit into a fast path only.
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function verifyPassword(password) {
  if (setupRequired()) return false;
  const actual = crypto.scryptSync(String(password), passwordSalt, 64).toString('hex');
  return timingSafeEqualHex(actual, passwordHash);
}

function verifyCredentials(username, password) {
  if (setupRequired()) return false;
  // Always hash the password (expensive) before returning, even if username is wrong.
  const passOk = verifyPassword(password);
  if (!authUsername) return passOk;
  return timingSafeEqualString(String(username || ''), authUsername) && passOk;
}

function normalizeUsername(input) {
  const username = String(input || '').trim();
  if (!USERNAME_RE.test(username)) {
    throw Object.assign(
      new Error('Username must be 1–64 characters: letters, numbers, . _ @ + -'),
      { status: 400 },
    );
  }
  return username;
}

function validateNewPassword(password, confirm) {
  const value = String(password || '');
  if (value.length < 12 || value.length > 200) {
    throw Object.assign(new Error('Password must be 12–200 characters'), { status: 400 });
  }
  if (value !== String(confirm || '')) {
    throw Object.assign(new Error('Passwords do not match'), { status: 400 });
  }
  return value;
}

function persistAuth({ username, salt, hash }) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  if (text && !text.endsWith('\n')) text += '\n';
  const setKey = (key, value) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${key}=${value}`);
    else text += `${key}=${value}\n`;
  };
  setKey('WEBUI_USERNAME', username);
  setKey('PASSWORD_SALT', salt);
  setKey('PASSWORD_HASH', hash);
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
  authUsername = username;
  passwordSalt = salt;
  passwordHash = hash;
}

function issueSession(res) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(sessionKey(token), Date.now() + SESSION_HOURS * 3600000);
  saveSessions();
  return json(res, 200, { ok: true }, {
    'Set-Cookie': `grok_webui_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
  });
}

function rateLimitLogin(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const attempts = loginAttempts.get(key) || { count: 0, reset: Date.now() + 60000 };
  if (attempts.reset < Date.now()) Object.assign(attempts, { count: 0, reset: Date.now() + 60000 });
  if (attempts.count >= 6) {
    const err = Object.assign(new Error('Too many attempts. Try again shortly.'), { status: 429 });
    throw err;
  }
  return attempts;
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }).filter(([key]) => key));
}

function authenticated(req) {
  const token = parseCookies(req).grok_webui_session;
  const key = token && sessionKey(token);
  const expires = key && sessions.get(key);
  if (!expires || expires < Date.now()) {
    if (key && sessions.delete(key)) saveSessions();
    return false;
  }
  return true;
}

function secureHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, secureHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...headers }));
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function sameOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  const origin = req.headers.origin;
  return origin === `http://${HOST}:${PORT}` || origin === `https://${HOST}:${PORT}`;
}

function allowedWorkspace(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw Object.assign(new Error('Invalid workspace'), { status: 400 });
  }
  let resolved;
  try { resolved = fs.realpathSync(input); }
  catch { throw Object.assign(new Error('Workspace does not exist'), { status: 400 }); }
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}${path.sep}`)) {
    throw Object.assign(new Error('Workspace is outside the allowed root'), { status: 403 });
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw Object.assign(new Error('Workspace is not a directory'), { status: 400 });
  }
  return resolved;
}

function listWorkspaces() {
  const skip = new Set(['__pycache__', 'node_modules', 'comfy-ab-output', 'comfyui-outputs']);
  const entries = fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !skip.has(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(WORKSPACE_ROOT, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [{ name: 'workspace', path: WORKSPACE_ROOT }, ...entries];
}

const IMAGE_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
]);

const TEXT_MIME = new Map([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
  ['.js', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/tsx'],
  ['.jsx', 'text/jsx'],
  ['.py', 'text/x-python'],
  ['.html', 'text/html'],
  ['.css', 'text/css'],
  ['.yml', 'text/yaml'],
  ['.yaml', 'text/yaml'],
  ['.toml', 'text/toml'],
  ['.sh', 'text/x-shellscript'],
  ['.csv', 'text/csv'],
  ['.xml', 'application/xml'],
  ['.sql', 'application/sql'],
  ['.rs', 'text/x-rust'],
  ['.go', 'text/x-go'],
  ['.c', 'text/x-c'],
  ['.h', 'text/x-c'],
  ['.cpp', 'text/x-c++'],
  ['.java', 'text/x-java'],
  ['.rb', 'text/x-ruby'],
  ['.php', 'text/x-php'],
  ['.env', 'text/plain'],
  ['.log', 'text/plain'],
]);
const GALLERY_TYPES = new Map([
  ...IMAGE_TYPES, ['.pdf', 'application/pdf'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],
  ['.csv', 'text/csv'], ['.json', 'application/json'], ['.zip', 'application/zip'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);

function normalizePermissionMode(value) {
  return ['restrictive', 'moderate', 'yolo'].includes(value) ? value : 'moderate';
}

function galleryFiles(cwd) {
  const roots = [{ root: UPLOAD_ROOT, source: 'upload' }, { root: cwd, source: 'workspace' }];
  const found = [];
  const ignored = new Set(['.git', '.cache', '.next', 'node_modules', 'vendor', 'data', 'uploads', 'downloads']);
  for (const item of roots) {
    const queue = [{ dir: item.root, depth: 0 }];
    while (queue.length && found.length < MAX_GALLERY_FILES * 3) {
      const { dir, depth } = queue.shift();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 5) queue.push({ dir: target, depth: depth + 1 });
        if (!entry.isFile()) continue;
        const mimeType = GALLERY_TYPES.get(path.extname(entry.name).toLowerCase());
        if (!mimeType) continue;
        try {
          const stat = fs.statSync(target);
          if (stat.size > 100 * 1024 * 1024) continue;
          found.push({ name: entry.name, path: target, size: stat.size, modifiedAt: stat.mtimeMs, mimeType, isImage: mimeType.startsWith('image/'), source: item.source });
        } catch { /* file changed while scanning */ }
      }
    }
  }
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, MAX_GALLERY_FILES);
}

function mediaRoots() {
  const roots = [WORKSPACE_ROOT, UPLOAD_ROOT];
  // Agent-generated assets (image_gen, session artifacts) live under GROK_HOME
  for (const candidate of [GROK_HOME, path.join(process.env.HOME || '', '.grok')]) {
    if (!candidate) continue;
    try {
      const real = fs.realpathSync(candidate);
      if (!roots.includes(real)) roots.push(real);
    } catch { /* missing dir is fine */ }
  }
  return roots;
}

function isUnderRoot(resolved, root) {
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function allowedFilePath(input, { forWrite = false } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw Object.assign(new Error('Invalid file path'), { status: 400 });
  }
  let resolved;
  try { resolved = fs.realpathSync(input); }
  catch {
    if (!forWrite) throw Object.assign(new Error('File does not exist'), { status: 404 });
    // For write of a new file, resolve parent
    const parent = path.dirname(input);
    let parentResolved;
    try { parentResolved = fs.realpathSync(parent); }
    catch { throw Object.assign(new Error('Parent directory does not exist'), { status: 400 }); }
    // Writes stay under workspace only (uploads go through saveUpload)
    if (!isUnderRoot(parentResolved, WORKSPACE_ROOT)) {
      throw Object.assign(new Error('Path is outside the allowed workspace'), { status: 403 });
    }
    return path.join(parentResolved, path.basename(input));
  }
  const ok = mediaRoots().some((root) => isUnderRoot(resolved, root));
  if (!ok) throw Object.assign(new Error('Path is outside the allowed workspace'), { status: 403 });
  return resolved;
}

function allowedImage(input) {
  const resolved = allowedFilePath(input);
  const stat = fs.statSync(resolved);
  const contentType = IMAGE_TYPES.get(path.extname(resolved).toLowerCase());
  if (!stat.isFile() || !contentType) throw Object.assign(new Error('Unsupported image'), { status: 415 });
  if (stat.size > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Image is too large'), { status: 413 });
  return { resolved, stat, contentType };
}

function allowedDownload(input) {
  const resolved = allowedFilePath(input);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw Object.assign(new Error('Not a file'), { status: 400 });
  if (stat.size > 100 * 1024 * 1024) throw Object.assign(new Error('File is too large'), { status: 413 });
  return { resolved, stat };
}

/** Cap oversized tool payloads so SSE stays responsive for chat chunks. */
function slimGrokEvent(message) {
  if (!message || typeof message !== 'object') return message;
  const update = message.params?.update;
  if (!update || typeof update !== 'object') return message;
  const type = update.sessionUpdate;
  if (type !== 'tool_call' && type !== 'tool_call_update') return message;

  const clone = {
    ...message,
    params: {
      ...message.params,
      update: { ...update },
    },
  };
  const slim = clone.params.update;
  // Keep titles/status for the activity rail; drop multi‑MB tool bodies.
  if (slim.rawInput != null) {
    try {
      const raw = typeof slim.rawInput === 'string' ? slim.rawInput : JSON.stringify(slim.rawInput);
      if (raw.length > 4000) slim.rawInput = { _truncated: true, preview: raw.slice(0, 1500) };
    } catch {
      slim.rawInput = { _truncated: true };
    }
  }
  if (slim.rawOutput != null) {
    slim.rawOutput = { _truncated: true };
  }
  if (Array.isArray(slim.content)) {
    slim.content = slim.content.map((block) => {
      if (!block || typeof block !== 'object') return block;
      if (block.type === 'content' && block.content?.text && String(block.content.text).length > 2500) {
        return {
          ...block,
          content: {
            ...block.content,
            text: `${String(block.content.text).slice(0, 2500)}\n…[truncated for live stream]`,
          },
        };
      }
      if (block.type === 'diff') {
        return {
          type: 'diff',
          path: block.path,
          _truncated: true,
          summary: `${(block.oldText || block.old_string || '').length}→${(block.newText || block.new_string || '').length} chars`,
        };
      }
      if (typeof block.text === 'string' && block.text.length > 2500) {
        return { ...block, text: `${block.text.slice(0, 2500)}\n…[truncated for live stream]` };
      }
      return block;
    });
  }
  return clone;
}

function broadcast(payload) {
  let body = payload;
  if (payload?.type === 'grok_event' && payload.event) {
    body = { ...payload, event: slimGrokEvent(payload.event) };
  }
  const frame = `data: ${JSON.stringify(body)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
      // Express/Node may buffer; flush when available so chat text appears live.
      if (typeof client.flush === 'function') client.flush();
    } catch {
      sseClients.delete(client);
    }
  }
}

function safeSessionId(id) {
  if (typeof id !== 'string' || !/^[0-9a-fA-F-]{8,64}$/.test(id)) {
    throw Object.assign(new Error('Invalid session id'), { status: 400 });
  }
  return id;
}

function findSessionDir(sessionId) {
  if (!fs.existsSync(SESSIONS_ROOT)) return null;
  for (const group of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!group.isDirectory() || group.name.startsWith('.')) continue;
    const candidate = path.join(SESSIONS_ROOT, group.name, sessionId);
    if (fs.existsSync(path.join(candidate, 'summary.json'))) return candidate;
  }
  return null;
}

function readPlanForExit(params = {}) {
  const inline = params.planContent ?? params.plan_content ?? params.planText ?? params.plan_text;
  if (typeof inline === 'string' && inline.trim()) {
    return { planText: inline, planPath: params.planPath || params.plan_path || null };
  }

  let planPath = params.planPath || params.plan_path || params.path || null;
  if (!planPath && params.sessionId) {
    const dir = findSessionDir(params.sessionId);
    if (dir) planPath = path.join(dir, 'plan.md');
  }

  if (typeof planPath === 'string' && planPath) {
    try {
      const resolved = fs.realpathSync(planPath);
      const grokRoot = fs.realpathSync(GROK_HOME);
      if (resolved === grokRoot || resolved.startsWith(`${grokRoot}${path.sep}`)) {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          return { planText: fs.readFileSync(resolved, 'utf8'), planPath: resolved };
        }
      }
    } catch {
      // Fall through to empty plan.
    }
  }

  return { planText: '', planPath: planPath || null };
}

/** Build ExtResponse for ask_user_question from the browser POST body. */
function askUserAnswerKey(q, i) {
  return (q && (q.question || q.prompt || q.id)) || String(i);
}

/** Map UI {selected,other} (or raw string/array) to Grok StringOrVec. */
function askUserStringOrVec(raw, q) {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(String);
  if (!raw || typeof raw !== 'object') return '';
  const selected = Array.isArray(raw.selected) ? raw.selected.map(String) : [];
  const other = raw.other != null && String(raw.other).trim() ? String(raw.other).trim() : '';
  const multi = !!(q && (q.multi_select || q.multiSelect));
  if (other && !selected.length) return other;
  if (other && selected.length) {
    const vals = selected.concat([other]);
    return multi || vals.length > 1 ? vals : vals[0];
  }
  if (!selected.length) return multi ? [] : '';
  return multi || selected.length > 1 ? selected : selected[0];
}

/** Build answers map keyed by question text (Grok HashMap, not an array). */
function askUserAnswersMap(list, questions, { fillDefaults = false } = {}) {
  const map = {};
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    for (const [key, value] of Object.entries(list)) {
      const qi = questions.findIndex((q, idx) => askUserAnswerKey(q, idx) === key || q?.question === key);
      map[key] = askUserStringOrVec(value, qi >= 0 ? questions[qi] : null);
    }
    return map;
  }
  const arr = Array.isArray(list) ? list : [];
  const n = fillDefaults ? Math.max(arr.length, questions.length) : arr.length;
  for (let i = 0; i < n; i += 1) {
    const q = questions[i] || {};
    const key = askUserAnswerKey(q, i);
    if (i < arr.length) {
      map[key] = askUserStringOrVec(arr[i], q);
    } else if (fillDefaults) {
      const first = q?.options?.[0]?.label || q?.options?.[0]?.name || '';
      const multi = !!(q.multi_select || q.multiSelect);
      map[key] = multi ? (first ? [first] : []) : first;
    }
  }
  return map;
}

function buildAskUserResult(body = {}, pendingParams = {}) {
  // Grok AskUserQuestionExtResponse: internally tagged on outcome (snake_case).
  if (body.skip || body.skipInterview || body.skip_interview) {
    return { outcome: 'skip_interview' };
  }
  if (body.chatAboutThis || body.chat_about_this) {
    return { outcome: 'chat_about_this' };
  }
  if (body.cancelled || body.cancel || body.canceled) {
    return { outcome: 'cancelled' };
  }

  const questions = Array.isArray(pendingParams.questions) ? pendingParams.questions : [];
  const answers = body.answers == null
    ? askUserAnswersMap([], questions, { fillDefaults: true })
    : askUserAnswersMap(body.answers, questions, {
      fillDefaults: Array.isArray(body.answers) && body.answers.length === 0,
    });

  // UI sends partial_answers: [] on a normal accept — keep {}.
  const rawPartial = body.partial_answers != null ? body.partial_answers : body.partialAnswers;
  let partial_answers = {};
  if (Array.isArray(rawPartial)) {
    if (rawPartial.length) partial_answers = askUserAnswersMap(rawPartial, questions);
  } else if (rawPartial && typeof rawPartial === 'object') {
    partial_answers = askUserAnswersMap(rawPartial, questions);
  }

  return { outcome: 'accepted', answers, partial_answers };
}

function buildPlanApprovalResult(body = {}) {
  const raw = String(body.decision || body.action || 'approve').toLowerCase().replace(/[\s-]+/g, '_');
  let decision = 'approve';
  if (raw === 'request_changes' || raw === 'requestchanges' || raw === 'changes') decision = 'request_changes';
  else if (raw === 'quit' || raw === 'reject' || raw === 'abandon' || raw === 'deny') decision = 'quit';
  else if (raw === 'approve' || raw === 'accept' || raw === 'yes') decision = 'approve';
  const feedback = body.feedback != null ? String(body.feedback) : (body.message != null ? String(body.message) : '');
  return { decision, feedback };
}

function readSummary(sessionDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, 'summary.json'), 'utf8'));
    const info = raw.info || {};
    return {
      id: info.id || path.basename(sessionDir),
      cwd: info.cwd || null,
      title: raw.generated_title || raw.session_summary || 'Untitled session',
      summary: raw.session_summary || '',
      modelId: raw.current_model_id || null,
      createdAt: raw.created_at || null,
      updatedAt: raw.updated_at || raw.last_active_at || null,
      numMessages: raw.num_chat_messages || raw.num_messages || 0,
    };
  } catch {
    return null;
  }
}

function listDiskSessions({ cwd = null, limit = 100 } = {}) {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const results = [];
  const groups = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'session_search.sqlite');

  for (const group of groups) {
    const groupPath = path.join(SESSIONS_ROOT, group.name);
    let groupCwd = null;
    try {
      const cwdFile = path.join(groupPath, '.cwd');
      if (fs.existsSync(cwdFile)) groupCwd = fs.readFileSync(cwdFile, 'utf8').trim();
      else groupCwd = decodeURIComponent(group.name);
    } catch {
      groupCwd = group.name;
    }
    if (cwd && groupCwd !== cwd) continue;

    for (const entry of fs.readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const summary = readSummary(path.join(groupPath, entry.name));
      if (summary) {
        if (!summary.cwd) summary.cwd = groupCwd;
        results.push(summary);
      }
    }
  }

  results.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return results.slice(0, limit);
}

// Mobile Safari (and constrained phones) OOM when a long session ships every tool
// call + multi-MB file contents. Keep history payloads bounded for the WebUI.
const HISTORY_DEFAULT_MESSAGES = 80;
const HISTORY_DEFAULT_TOOLS = 50;
const HISTORY_MAX_MESSAGES = 250;
const HISTORY_MAX_TOOLS = 150;
const HISTORY_DETAIL_CHARS = 4000;
const HISTORY_RAW_INPUT_CHARS = 1500;
const HISTORY_IMAGE_DATA_CHARS = 180_000; // ~135KB binary; skip larger inline images
const HISTORY_LITE_MESSAGES = 12;
const HISTORY_LITE_TOOLS = 20;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function truncateText(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function compactRawInput(rawInput) {
  if (rawInput == null) return null;
  let text;
  try {
    text = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
  } catch {
    text = String(rawInput);
  }
  if (!text) return null;
  if (text.length <= HISTORY_RAW_INPUT_CHARS) {
    return typeof rawInput === 'string' ? rawInput : rawInput;
  }
  return truncateText(text, HISTORY_RAW_INPUT_CHARS);
}

function toolContentBits(content) {
  if (!Array.isArray(content)) return [];
  const bits = [];
  for (const block of content) {
    if (block?.type === 'content' && block.content?.text) bits.push(block.content.text);
    else if (block?.type === 'text' && block.text) bits.push(block.text);
    else if (typeof block?.text === 'string') bits.push(block.text);
  }
  return bits.filter(Boolean);
}

function coalesceHistory(sessionDir, options = {}) {
  const updatesPath = path.join(sessionDir, 'updates.jsonl');
  if (!fs.existsSync(updatesPath)) {
    return {
      messages: [],
      tools: [],
      commands: [],
      totalMessages: 0,
      totalTools: 0,
      messagesTruncated: false,
      toolsTruncated: false,
    };
  }

  const lite = Boolean(options.lite);
  const maxMessages = lite
    ? HISTORY_LITE_MESSAGES
    : clampInt(options.maxMessages, HISTORY_DEFAULT_MESSAGES, 1, HISTORY_MAX_MESSAGES);
  const maxTools = lite
    ? HISTORY_LITE_TOOLS
    : clampInt(options.maxTools, HISTORY_DEFAULT_TOOLS, 0, HISTORY_MAX_TOOLS);
  const includeRawInput = options.includeRawInput !== false && !lite;
  // When loading older pages, skip the newest `before` messages from the tail.
  const before = clampInt(options.before, 0, 0, 100_000);

  const messages = [];
  const tools = [];
  const toolIndex = new Map();
  let openUser = null;
  let openAgent = null;
  let openThought = null;
  let commands = [];

  const flush = (kind) => {
    if (kind === 'user' && openUser) {
      messages.push(openUser);
      openUser = null;
    }
    if (kind === 'agent' && openAgent) {
      messages.push(openAgent);
      openAgent = null;
    }
    if (kind === 'thought' && openThought) {
      messages.push(openThought);
      openThought = null;
    }
  };

  // Stream line-by-line so a 25MB+ updates.jsonl does not have to live as one string.
  const lines = fs.readFileSync(updatesPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    // Skip absurd single-line blobs (usually giant tool payloads) early when possible.
    // Still try to parse moderately large lines; only refuse multi-megabyte ones.
    if (line.length > 2_500_000) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { continue; }
    const update = row.params?.update || row.update;
    if (!update) continue;
    const type = update.sessionUpdate;

    if (type === 'user_message_chunk') {
      flush('agent');
      flush('thought');
      const text = update.content?.text || '';
      if (!openUser) openUser = { role: 'user', text: '', images: [], at: row.timestamp || null };
      openUser.text += text;
      if (update.content?.type === 'image' && update.content.data) {
        const data = String(update.content.data);
        if (data.length <= HISTORY_IMAGE_DATA_CHARS) {
          openUser.images.push({
            dataUrl: `data:${update.content.mimeType || 'image/png'};base64,${data}`,
          });
        } else {
          openUser.images.push({
            omitted: true,
            alt: 'Large image omitted (open on desktop or re-attach if needed)',
          });
        }
      }
    } else if (type === 'agent_message_chunk') {
      flush('user');
      flush('thought');
      const text = update.content?.text || '';
      const messageId = update.messageId || update.message_id || update.content?.id
        || update.content?.messageId || update.content?.message_id || null;
      if (openAgent && messageId && openAgent.messageId && messageId !== openAgent.messageId) flush('agent');
      if (!openAgent) openAgent = { role: 'assistant', text: '', at: row.timestamp || null, messageId };
      else if (!openAgent.messageId && messageId) openAgent.messageId = messageId;
      openAgent.text += text;
    } else if (type === 'agent_thought_chunk') {
      flush('user');
      // Keep thought separate for activity, not main transcript
      const text = update.content?.text || '';
      if (!openThought) openThought = { role: 'thought', text: '', at: row.timestamp || null };
      openThought.text += text;
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      flush('user');
      flush('agent');
      flush('thought');
      const id = update.toolCallId || update.tool_call_id || crypto.randomUUID();
      let existing = toolIndex.get(id);
      if (!existing) {
        existing = {
          id,
          title: update.title || 'Tool',
          kind: update.kind || '',
          status: update.status || 'pending',
          detail: '',
          rawInput: null,
        };
        tools.push(existing);
        toolIndex.set(id, existing);
      }
      if (update.title) existing.title = update.title;
      if (update.kind) existing.kind = update.kind;
      if (update.status) existing.status = update.status;
      if (includeRawInput && update.rawInput != null) {
        existing.rawInput = compactRawInput(update.rawInput);
      }
      const bits = toolContentBits(update.content);
      if (bits.length) {
        // Join only a tail of the largest blocks to avoid holding multi-MB strings.
        let joined = bits.join('\n');
        if (joined.length > HISTORY_DETAIL_CHARS * 3) {
          joined = joined.slice(-(HISTORY_DETAIL_CHARS * 3));
        }
        existing.detail = `${existing.detail}${existing.detail ? '\n' : ''}${joined}`.slice(-HISTORY_DETAIL_CHARS);
      }
    } else if (type === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      commands = update.availableCommands;
    } else if (type === 'plan' && Array.isArray(update.entries)) {
      flush('user');
      flush('agent');
      messages.push({
        role: 'plan',
        entries: update.entries,
        at: row.timestamp || null,
      });
    }
  }
  flush('user');
  flush('agent');
  flush('thought');

  // Drop pure thought messages from main history (they live in tools/activity).
  // Also drop Grok "system-reminder" injections (background task completions, etc.)
  // that the agent stream labels as user_message_chunk — they are not real user turns.
  const mainMessages = messages.filter((m) => {
    if (m.role === 'thought') return false;
    if (m.role === 'user' && isSystemReminderText(m.text)) return false;
    return true;
  });

  const totalMessages = mainMessages.length;
  const totalTools = tools.length;

  // Page from the end: newest messages first for UI, then reverse back to chronological.
  const endExclusive = Math.max(0, totalMessages - before);
  const start = Math.max(0, endExclusive - maxMessages);
  const pageMessages = mainMessages.slice(start, endExclusive);
  const toolsTruncated = totalTools > maxTools;
  const pageTools = maxTools > 0 ? tools.slice(-maxTools) : [];
  // When paging older messages, tools in the activity rail still reflect the session tail
  // (most recent tool activity), which is what users care about while scrolling chat.

  for (const tool of pageTools) {
    if (tool.detail) tool.detail = truncateText(tool.detail, HISTORY_DETAIL_CHARS);
    if (!includeRawInput) delete tool.rawInput;
    else if (tool.rawInput != null) tool.rawInput = compactRawInput(tool.rawInput);
  }

  return {
    messages: pageMessages,
    tools: pageTools,
    commands,
    totalMessages,
    totalTools,
    messagesTruncated: start > 0 || endExclusive < totalMessages,
    toolsTruncated,
    messageOffset: start,
    messageEnd: endExclusive,
  };
}

function isSystemReminderText(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.startsWith('<system-reminder')) return true;
  if (t.startsWith('<user_query') && t.includes('</user_query>') && t.length < 40) return false;
  // Background-task completion wrappers sometimes omit tags after partial parse
  if (/^Background task\s+"[^"]+"\s+completed/i.test(t)) return true;
  if (t.includes('<system-reminder>') && t.includes('Background task')) return true;
  return false;
}

class GrokBridge {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.activeSessions = new Map(); // sessionId -> { sessionId, promptId, startedAt }
    this.loadedSessions = new Set();
    this.availableCommands = new Map(); // sessionId -> commands
    this.modelsBySession = new Map();
    this.permissionModes = new Map();
    this.ready = this.start();
  }

  start() {
    return new Promise((resolve, reject) => {
      const grokBin = process.env.GROK_BIN || 'grok';
      this.proc = spawn(grokBin, ['agent', '--no-leader', 'stdio'], {
        cwd: WORKSPACE_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GROK_HOME,
          // Prefer non-interactive; auth comes from ~/.grok/auth.json or XAI_API_KEY
          NO_COLOR: '1',
        },
      });
      this.proc.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.error(`[grok] ${text.slice(0, 2000)}`);
      });
      this.proc.once('error', reject);
      this.proc.once('exit', (code, signal) => {
        const error = new Error(`Grok agent exited (${code ?? signal})`);
        for (const { reject: fail } of this.pending.values()) fail(error);
        this.pending.clear();
        this.activeSessions.clear();
        broadcast({ type: 'bridge_error', message: error.message });
        // Auto-restart after brief pause
        setTimeout(() => {
          this.ready = this.start().catch((err) => {
            console.error('Failed to restart Grok agent:', err);
            throw err;
          });
        }, 1500);
      });
      readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));

      this.rawRequest('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'grok_webui', title: 'Grok WebUI', version: '0.1.0' },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          // Agent runs tools itself; client terminal protocol is not implemented.
        },
        // Advertise interactive ask-user support (agent expects a bool).
        _meta: { askUserQuestion: true },
      }).then((result) => {
        this.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        this.agentCapabilities = result?.agentCapabilities || {};
        resolve(result);
      }, reject);
    });
  }

  send(message) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('Grok agent is unavailable');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { return console.error('Ignored malformed Grok agent output'); }

    // Server request (agent -> client)
    if (message.id !== undefined && message.method) {
      this.serverRequests.set(String(message.id), message);
      this.handleServerRequest(message).catch((error) => {
        console.error('Failed handling agent request', message.method, error);
        this.respondError(message.id, error.message || 'Client handler failed');
      });
      return;
    }

    // Response to our request
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        this.pending.delete(String(message.id));
        if (message.error) {
          pending.reject(Object.assign(new Error(message.error.message || 'Agent error'), {
            rpc: message.error,
            status: 502,
          }));
        } else pending.resolve(message.result);
      }
      return;
    }

    // Notification
    if (message.method) this.onNotification(message);
  }

  onNotification(message) {
    const method = message.method;
    const params = message.params || {};
    const sessionId = params.sessionId || params.update?.sessionId;
    const update = params.update || {};
    const updateType = update.sessionUpdate || '';

    if (method === '_x.ai/queue/changed' && sessionId) {
      if (params.runningPromptId) {
        this.activeSessions.set(sessionId, {
          sessionId,
          promptId: params.runningPromptId,
          startedAt: Date.now(),
        });
      } else if (!params.entries?.length && !params.runningPromptId) {
        // may still be running; clear only when prompt_complete arrives
      }
    }

    if (method === '_x.ai/session/prompt_complete' || updateType === 'turn_completed') {
      if (sessionId) this.activeSessions.delete(sessionId);
    }

    if (method === 'session/update' && updateType === 'available_commands_update' && sessionId) {
      this.availableCommands.set(sessionId, update.availableCommands || []);
    }

    if (method === '_x.ai/sessions/changed' && Array.isArray(params.upserted)) {
      // no-op; clients re-list from disk
    }

    broadcast({ type: 'grok_event', event: message });
  }

  async handleServerRequest(message) {
    const { method, params = {}, id } = message;

    if (method === 'session/request_permission') {
      const sessionId = params.sessionId || params.toolCall?.sessionId;
      const mode = this.permissionModes.get(sessionId) || 'moderate';
      const options = params.options || [];
      const requestText = JSON.stringify(params).toLowerCase();
      const readOnly = /read|list|search|find|grep|glob|inspect/.test(requestText)
        && !/write|edit|delete|remove|terminal|command|execute/.test(requestText);
      const risky = /sudo|delete|remove|outside|network|curl|wget|terminal|command|execute|install/.test(requestText);
      const autoAllow = mode === 'yolo' || (mode === 'moderate' && !risky) || (mode === 'restrictive' && readOnly);
      if (!autoAllow) {
        broadcast({ type: 'permission_request', request: message, permissionMode: mode });
        return;
      }
      broadcast({ type: 'permission_auto', request: message, permissionMode: mode });
      const preferred = (mode === 'yolo' && options.find((o) => /always|allow_always|allow-always/i.test(o.optionId || o.id || '')))
        || options.find((o) => /allow|accept|yes/i.test(o.optionId || o.id || o.name || ''))
        || options[0];
      const optionId = preferred?.optionId || preferred?.id || 'allow_always';
      this.respond(id, { outcome: { outcome: 'selected', optionId } });
      return;
    }

    if (method === 'fs/read_text_file') {
      const filePath = params.path;
      if (typeof filePath !== 'string') throw new Error('Missing path');
      // Allow reads under workspace, uploads, and grok home (session artifacts)
      let resolved;
      try {
        resolved = fs.realpathSync(filePath);
      } catch {
        throw Object.assign(new Error('File not found'), { status: 404 });
      }
      const allowed = [WORKSPACE_ROOT, UPLOAD_ROOT, GROK_HOME, path.join(process.env.HOME || '', '.grok')];
      const ok = allowed.some((root) => {
        try {
          const real = fs.realpathSync(root);
          return resolved === real || resolved.startsWith(`${real}${path.sep}`);
        } catch { return false; }
      });
      if (!ok) throw new Error('Read path not allowed');
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) throw new Error('Not a file');
      if (stat.size > 2 * 1024 * 1024) throw new Error('File too large for text read');
      const content = fs.readFileSync(resolved, 'utf8');
      const limit = params.limit;
      const line = params.line;
      let text = content;
      if (line || limit) {
        const lines = content.split(/\n/);
        const start = Math.max(0, (line || 1) - 1);
        text = lines.slice(start, limit ? start + limit : undefined).join('\n');
      }
      this.respond(id, { content: text });
      return;
    }

    if (method === 'fs/write_text_file') {
      const filePath = params.path;
      const content = params.content ?? '';
      if (typeof filePath !== 'string') throw new Error('Missing path');
      const resolved = allowedFilePath(filePath, { forWrite: true });
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, String(content), 'utf8');
      this.respond(id, {});
      return;
    }

    if (method === '_x.ai/ask_user_question' || method === 'x.ai/ask_user_question') {
      console.log('[ask_user_question] params keys:', Object.keys(params || {}),
        'questions:', Array.isArray(params.questions) ? params.questions.length : 0);
      broadcast({ type: 'ask_user_question', request: message });
      return;
    }

    if (method === '_x.ai/exit_plan_mode' || method === 'x.ai/exit_plan_mode') {
      console.log('[exit_plan_mode] params keys:', Object.keys(params || {}));
      const { planText, planPath } = readPlanForExit(params);
      broadcast({
        type: 'exit_plan_mode',
        request: message,
        planText,
        planPath,
      });
      return;
    }

    // Unknown client capability request — decline rather than hang
    console.warn('Unhandled agent request:', method);
    this.respondError(id, `Unsupported client method: ${method}`);
  }

  respond(id, result) {
    const key = String(id);
    this.serverRequests.delete(key);
    this.send({ jsonrpc: '2.0', id, result });
  }

  respondError(id, message) {
    const key = String(id);
    this.serverRequests.delete(key);
    this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(message) } });
  }

  rawRequest(method, params = {}, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Grok request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async request(method, params = {}, timeoutMs) {
    await this.ready;
    return this.rawRequest(method, params, timeoutMs);
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async createSession(cwd, { modelId = null } = {}) {
    const result = await this.request('session/new', {
      cwd,
      mcpServers: [],
      ...(modelId ? { _meta: { modelId } } : {}),
    });
    const sessionId = result.sessionId;
    this.loadedSessions.add(sessionId);
    if (result.models) this.modelsBySession.set(sessionId, result.models);
    if (modelId) {
      try {
        await this.request('session/set_model', { sessionId, modelId }, 30000);
      } catch (error) {
        console.warn('set_model after create failed:', error.message);
      }
    }
    return result;
  }

  setPermissionMode(sessionId, mode) {
    this.permissionModes.set(sessionId, normalizePermissionMode(mode));
  }

  async loadSession(sessionId, cwd) {
    const result = await this.request('session/load', {
      sessionId,
      cwd,
      mcpServers: [],
    }, 60000);
    this.loadedSessions.add(sessionId);
    if (result?.models) this.modelsBySession.set(sessionId, result.models);
    return result;
  }

  async ensureLoaded(sessionId, cwd) {
    if (this.loadedSessions.has(sessionId)) return;
    await this.loadSession(sessionId, cwd);
  }

  async prompt(sessionId, promptBlocks, { cwd = null } = {}) {
    if (cwd) await this.ensureLoaded(sessionId, cwd);
    this.activeSessions.set(sessionId, {
      sessionId,
      promptId: null,
      startedAt: Date.now(),
    });
    try {
      const result = await this.request('session/prompt', {
        sessionId,
        prompt: promptBlocks,
      }, 30 * 60 * 1000);
      return result;
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  cancel(sessionId) {
    this.notify('session/cancel', { sessionId });
    this.activeSessions.delete(sessionId);
  }

  async setModel(sessionId, modelId) {
    return this.request('session/set_model', { sessionId, modelId }, 30000);
  }
}

const bridge = new GrokBridge();

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_ROOT, relative);
  if (!file.startsWith(`${PUBLIC_ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return false;
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  res.writeHead(200, secureHeaders({ 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }));
  fs.createReadStream(file).pipe(res);
  return true;
}

function isTextFile(filePath) {
  return TEXT_MIME.has(path.extname(filePath).toLowerCase());
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_TYPES.get(ext) || TEXT_MIME.get(ext) || 'application/octet-stream';
}

async function saveUpload({ name, dataBase64, mimeType }) {
  if (typeof dataBase64 !== 'string' || !dataBase64) {
    throw Object.assign(new Error('Missing file data'), { status: 400 });
  }
  const buffer = Buffer.from(dataBase64, 'base64');
  if (!buffer.length) throw Object.assign(new Error('Empty file'), { status: 400 });
  if (buffer.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('File too large (25MB max)'), { status: 413 });

  const safeName = String(name || 'upload.bin')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180) || 'upload.bin';
  const id = crypto.randomUUID();
  const dir = path.join(UPLOAD_ROOT, id);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, safeName);
  await fsp.writeFile(dest, buffer);
  return {
    id,
    name: safeName,
    path: dest,
    size: buffer.length,
    mimeType: mimeType || mimeFor(dest),
    isImage: IMAGE_TYPES.has(path.extname(dest).toLowerCase()),
    isText: isTextFile(dest),
  };
}

function buildPromptBlocks(text, attachments = [], { systemPrompt = '', amtToolsHint = '' } = {}) {
  const blocks = [];
  const system = String(systemPrompt || '').trim();
  if (system) {
    blocks.push({
      type: 'text',
      text: `[System instructions for this session — follow unless the user overrides]\n${system.slice(0, 8000)}`,
    });
  }
  const toolsHint = String(amtToolsHint || '').trim();
  if (toolsHint) {
    blocks.push({
      type: 'text',
      text: toolsHint.slice(0, 6000),
    });
  }
  const trimmed = String(text || '').trim();
  if (trimmed) blocks.push({ type: 'text', text: trimmed });

  for (const file of attachments) {
    if (!file?.path) continue;
    let resolved;
    try { resolved = allowedFilePath(file.path); }
    catch { continue; }

    const name = file.name || path.basename(resolved);
    const mime = file.mimeType || mimeFor(resolved);
    const isImage = IMAGE_TYPES.has(path.extname(resolved).toLowerCase());
    const isText = isTextFile(resolved);

    if (isText) {
      try {
        const content = fs.readFileSync(resolved, 'utf8');
        if (content.length <= 200_000) {
          blocks.push({
            type: 'resource',
            resource: {
              uri: `file://${resolved}`,
              mimeType: mime,
              text: content,
            },
          });
          continue;
        }
      } catch { /* fall through */ }
    }

    // Binary / large: point the agent at the absolute path so tools can read it
    const kind = isImage ? 'image' : 'file';
    blocks.push({
      type: 'text',
      text: `[User attached ${kind}: ${name}]\nAbsolute path: ${resolved}\nMIME: ${mime}\nUse tools to inspect this path if needed.`,
    });
  }

  if (!blocks.length) throw Object.assign(new Error('Message is empty'), { status: 400 });
  return blocks;
}

async function api(req, res, pathname) {
  if (pathname === '/api/auth-status' && req.method === 'GET') {
    return json(res, 200, {
      setupRequired: setupRequired(),
      authenticated: !setupRequired() && authenticated(req),
    });
  }

  if (pathname === '/api/setup' && req.method === 'POST') {
    if (!setupRequired()) {
      return json(res, 409, { error: 'Credentials already configured. Sign in instead.' });
    }
    let attempts;
    try { attempts = rateLimitLogin(req); }
    catch (error) { return json(res, error.status || 429, { error: error.message }); }
    const body = await readJson(req);
    try {
      const username = normalizeUsername(body.username);
      const password = validateNewPassword(body.password, body.confirm);
      const salt = crypto.randomBytes(24).toString('hex');
      const hash = crypto.scryptSync(password, salt, 64).toString('hex');
      persistAuth({ username, salt, hash });
      sessions.clear();
      loginAttempts.delete(req.socket.remoteAddress || 'unknown');
      return issueSession(res);
    } catch (error) {
      if (error.status === 400) return json(res, 400, { error: error.message });
      attempts.count += 1;
      loginAttempts.set(req.socket.remoteAddress || 'unknown', attempts);
      throw error;
    }
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (setupRequired()) {
      return json(res, 409, { error: 'Set a username and password first.' });
    }
    let attempts;
    try { attempts = rateLimitLogin(req); }
    catch (error) { return json(res, error.status || 429, { error: error.message }); }
    const body = await readJson(req);
    if (!verifyCredentials(body.username, body.password)) {
      attempts.count += 1;
      loginAttempts.set(req.socket.remoteAddress || 'unknown', attempts);
      return json(res, 401, { error: 'Incorrect username or password' });
    }
    loginAttempts.delete(req.socket.remoteAddress || 'unknown');
    return issueSession(res);
  }

  if (setupRequired()) return json(res, 401, { error: 'Setup required' });
  if (!authenticated(req)) return json(res, 401, { error: 'Authentication required' });

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).grok_webui_session;
    if (token) sessions.delete(sessionKey(token));
    saveSessions();
    return json(res, 200, { ok: true }, {
      'Set-Cookie': 'grok_webui_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    return json(res, 200, {
      authenticated: true,
      workspaceRoot: WORKSPACE_ROOT,
      grokHome: GROK_HOME,
    });
  }

  if (pathname === '/api/workspaces' && req.method === 'GET') {
    return json(res, 200, { workspaces: listWorkspaces() });
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    await bridge.ready;
    return json(res, 200, {
      ok: true,
      grok: 'connected',
      host: HOST,
      workspaceRoot: WORKSPACE_ROOT,
      executionMode: 'full-access',
      activeSessions: [...bridge.activeSessions.values()],
    });
  }

  if (pathname === '/api/activity' && req.method === 'GET') {
    return json(res, 200, { activeSessions: [...bridge.activeSessions.values()] });
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, secureHeaders({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }));
    // Prefer low-latency flushes for live chat over Tailscale / mobile browsers.
    try { res.socket?.setNoDelay?.(true); } catch { /* ignore */ }
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      activeSessions: [...bridge.activeSessions.values()],
    })}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); }
      catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (pathname === '/api/image' && req.method === 'GET') {
    const requested = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`).searchParams.get('path');
    const image = allowedImage(requested);
    res.writeHead(200, secureHeaders({
      'Content-Type': image.contentType,
      'Content-Length': image.stat.size,
      'Content-Disposition': 'inline',
    }));
    fs.createReadStream(image.resolved).pipe(res);
    return;
  }

  if (pathname === '/api/file' && req.method === 'GET') {
    const requested = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`).searchParams.get('path');
    const file = allowedDownload(requested);
    const contentType = mimeFor(file.resolved);
    const disposition = IMAGE_TYPES.has(path.extname(file.resolved).toLowerCase()) ? 'inline' : 'attachment';
    res.writeHead(200, secureHeaders({
      'Content-Type': contentType,
      'Content-Length': file.stat.size,
      'Content-Disposition': `${disposition}; filename="${path.basename(file.resolved).replace(/"/g, '')}"`,
    }));
    fs.createReadStream(file.resolved).pipe(res);
    return;
  }
  if (pathname === '/api/gallery' && req.method === 'GET') {
    const requested = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`).searchParams.get('cwd');
    const cwd = allowedWorkspace(requested || WORKSPACE_ROOT);
    return json(res, 200, { files: galleryFiles(cwd) });
  }

  if (pathname === '/api/upload' && req.method === 'POST') {
    const body = await readJson(req, MAX_UPLOAD_BYTES * 1.4 + 64 * 1024);
    if (Array.isArray(body.files)) {
      const saved = [];
      for (const file of body.files.slice(0, 10)) {
        saved.push(await saveUpload(file));
      }
      return json(res, 201, { files: saved });
    }
    const saved = await saveUpload(body);
    return json(res, 201, { file: saved });
  }

  if (pathname === '/api/sessions' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const cwd = url.searchParams.get('cwd');
    if (cwd) allowedWorkspace(cwd);
    const list = listDiskSessions({ cwd: cwd || null, limit: 150 });
    // Annotate with active status
    for (const item of list) {
      item.active = bridge.activeSessions.has(item.id);
    }
    return json(res, 200, { sessions: list });
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readJson(req);
    const cwd = allowedWorkspace(body.cwd || WORKSPACE_ROOT);
    const result = await bridge.createSession(cwd, { modelId: body.modelId || null });
    bridge.setPermissionMode(result.sessionId, body.permissionMode);
    return json(res, 201, {
      sessionId: result.sessionId,
      models: result.models || null,
      commands: bridge.availableCommands.get(result.sessionId) || [],
      meta: result._meta || null,
      cwd,
    });
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === 'GET') {
    const sessionId = safeSessionId(decodeURIComponent(sessionMatch[1]));
    const dir = findSessionDir(sessionId);
    if (!dir) return json(res, 404, { error: 'Session not found' });
    const summary = readSummary(dir);
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const lite = url.searchParams.get('lite') === '1' || url.searchParams.get('lite') === 'true';
    const history = coalesceHistory(dir, {
      lite,
      maxMessages: url.searchParams.get('messages'),
      maxTools: url.searchParams.get('tools'),
      before: url.searchParams.get('before'),
      includeRawInput: url.searchParams.get('raw') === '1',
    });
    return json(res, 200, {
      session: summary,
      messages: history.messages,
      tools: history.tools,
      commands: lite ? [] : history.commands,
      active: bridge.activeSessions.has(sessionId),
      models: bridge.modelsBySession.get(sessionId) || null,
      totalMessages: history.totalMessages,
      totalTools: history.totalTools,
      messagesTruncated: history.messagesTruncated,
      toolsTruncated: history.toolsTruncated,
      messageOffset: history.messageOffset,
      messageEnd: history.messageEnd,
      lite: Boolean(lite),
    });
  }

  const loadMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/load$/);
  if (loadMatch && req.method === 'POST') {
    const sessionId = safeSessionId(decodeURIComponent(loadMatch[1]));
    const body = await readJson(req);
    const dir = findSessionDir(sessionId);
    const summary = dir ? readSummary(dir) : null;
    const cwd = allowedWorkspace(body.cwd || summary?.cwd || WORKSPACE_ROOT);
    bridge.setPermissionMode(sessionId, body.permissionMode);
    const result = await bridge.loadSession(sessionId, cwd);
    return json(res, 200, {
      sessionId,
      cwd,
      models: result?.models || bridge.modelsBySession.get(sessionId) || null,
      meta: result?._meta || null,
    });
  }

  const modelMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/model$/);
  if (modelMatch && req.method === 'POST') {
    const sessionId = safeSessionId(decodeURIComponent(modelMatch[1]));
    const body = await readJson(req);
    if (!body.modelId || typeof body.modelId !== 'string') {
      return json(res, 400, { error: 'modelId required' });
    }
    const dir = findSessionDir(sessionId);
    const summary = dir ? readSummary(dir) : null;
    const cwd = allowedWorkspace(body.cwd || summary?.cwd || WORKSPACE_ROOT);
    await bridge.ensureLoaded(sessionId, cwd);
    const result = await bridge.setModel(sessionId, body.modelId);
    return json(res, 200, { ok: true, result });
  }

  const messageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messageMatch && req.method === 'POST') {
    const sessionId = safeSessionId(decodeURIComponent(messageMatch[1]));
    const body = await readJson(req, 30 * 1024 * 1024);
    if (typeof body.text !== 'string' || body.text.length > MAX_MESSAGE_CHARS) {
      return json(res, 400, { error: `Message must be 0–${MAX_MESSAGE_CHARS} characters` });
    }
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (!body.text.trim() && !attachments.length) {
      return json(res, 400, { error: 'Message or attachment required' });
    }

    const dir = findSessionDir(sessionId);
    const summary = dir ? readSummary(dir) : null;
    const cwd = allowedWorkspace(body.cwd || summary?.cwd || WORKSPACE_ROOT);

    await bridge.ensureLoaded(sessionId, cwd);
    if (body.modelId) {
      try { await bridge.setModel(sessionId, body.modelId); }
      catch (error) { console.warn('model switch failed:', error.message); }
    }

    let amtToolsHint = '';
    if (body.amtToolsEnabled) {
      try {
        const tools = await amtFetchTools();
        const free = tools.filter((t) => String(t.tier || '').toLowerCase() === 'free').slice(0, 30);
        const paid = tools.filter((t) => String(t.tier || '').toLowerCase() !== 'free').slice(0, 20);
        const lines = [
          '[Agent Media Tools — optional cloud tools]',
          'User has AMT tools enabled. Prefer free tier tools first. Paid/agent-tier tools require their linked AMT key and may spend credits.',
          `Base URL: ${AMT_BASE}`,
          free.length ? `Free tools: ${free.map((t) => t.id).join(', ')}` : 'Free tools: (catalog unavailable)',
          paid.length ? `Other tiers (gated): ${paid.map((t) => `${t.id}[${t.tier}]`).join(', ')}` : '',
          'Call tools via HTTPS REST with Authorization: Bearer <their AMT key> when appropriate; do not invent credentials.',
        ].filter(Boolean);
        amtToolsHint = lines.join('\n');
      } catch (error) {
        console.warn('AMT tools hint failed:', error.message);
      }
    }

    const promptBlocks = buildPromptBlocks(body.text, attachments, {
      systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : '',
      amtToolsHint,
    });

    // Respond immediately; stream progress over SSE. Prompt runs in background.
    bridge.activeSessions.set(sessionId, { sessionId, promptId: null, startedAt: Date.now() });
    broadcast({
      type: 'prompt_started',
      sessionId,
      text: body.text,
      attachments: attachments.map((a) => ({ name: a.name, path: a.path, mimeType: a.mimeType })),
    });

    bridge.prompt(sessionId, promptBlocks, { cwd })
      .then((result) => {
        broadcast({ type: 'prompt_finished', sessionId, result });
      })
      .catch((error) => {
        broadcast({ type: 'prompt_error', sessionId, message: error.message });
      });

    return json(res, 202, { ok: true, sessionId });
  }

  const cancelMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    const sessionId = safeSessionId(decodeURIComponent(cancelMatch[1]));
    bridge.cancel(sessionId);
    broadcast({ type: 'prompt_cancelled', sessionId });
    return json(res, 200, { ok: true });
  }

  const permissionMatch = pathname.match(/^\/api\/permissions\/([^/]+)$/);
  if (permissionMatch && req.method === 'POST') {
    const requestId = decodeURIComponent(permissionMatch[1]);
    const pending = bridge.serverRequests.get(requestId);
    if (!pending || pending.method !== 'session/request_permission') return json(res, 404, { error: 'Permission request not found' });
    const body = await readJson(req);
    const options = pending.params?.options || [];
    const pattern = body.decision === 'allow'
      ? /allow|accept|yes/i
      : /deny|decline|reject|no/i;
    const selected = options.find((option) => pattern.test(option.optionId || option.id || option.name || ''));
    if (!selected) return json(res, 400, { error: 'Requested decision is unavailable' });
    // Preserve original JSON-RPC id type (number vs string) from the agent request.
    console.log('[permissions] responding id=', pending.id, 'typeof=', typeof pending.id);
    bridge.respond(pending.id, { outcome: { outcome: 'selected', optionId: selected.optionId || selected.id } });
    return json(res, 200, { ok: true });
  }

  const askUserMatch = pathname.match(/^\/api\/ask-user\/([^/]+)$/);
  if (askUserMatch && req.method === 'POST') {
    const requestId = decodeURIComponent(askUserMatch[1]);
    const pending = bridge.serverRequests.get(requestId);
    const method = pending?.method || '';
    if (!pending || (method !== '_x.ai/ask_user_question' && method !== 'x.ai/ask_user_question')) {
      return json(res, 404, { error: 'Ask-user request not found' });
    }
    const body = await readJson(req);
    const result = buildAskUserResult(body, pending.params || {});
    // Preserve original JSON-RPC id type (number vs string) from the agent request.
    console.log('[ask_user_question] responding id=', pending.id, 'typeof=', typeof pending.id, JSON.stringify(result).slice(0, 800));
    bridge.respond(pending.id, result);
    return json(res, 200, { ok: true });
  }

  const planApprovalMatch = pathname.match(/^\/api\/plan-approval\/([^/]+)$/);
  if (planApprovalMatch && req.method === 'POST') {
    const requestId = decodeURIComponent(planApprovalMatch[1]);
    const pending = bridge.serverRequests.get(requestId);
    const method = pending?.method || '';
    if (!pending || (method !== '_x.ai/exit_plan_mode' && method !== 'x.ai/exit_plan_mode')) {
      return json(res, 404, { error: 'Plan approval request not found' });
    }
    const body = await readJson(req);
    const result = buildPlanApprovalResult(body);
    // Preserve original JSON-RPC id type (number vs string) from the agent request.
    console.log('[exit_plan_mode] responding id=', pending.id, 'typeof=', typeof pending.id, result);
    bridge.respond(pending.id, result);
    return json(res, 200, { ok: true });
  }

  const commandsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/commands$/);
  if (commandsMatch && req.method === 'GET') {
    const sessionId = safeSessionId(decodeURIComponent(commandsMatch[1]));
    return json(res, 200, {
      commands: bridge.availableCommands.get(sessionId) || [],
    });
  }

  // ─── Optional Agent Media Tools bridge (key stored only on this laptop) ───
  if (pathname === '/api/amt/connect' && req.method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    const key = String(body.key || '').trim();
    if (!key || key.length < 12 || key.length > 200) {
      return json(res, 400, { error: 'Valid AMT agent key required' });
    }
    // Verify key before saving
    const status = await amtFetchStatus(key);
    if (!status.ok) return json(res, status.status || 400, { error: status.error || 'AMT key rejected' });
    writeAmtStore({ key, savedAt: new Date().toISOString(), key_prefix: status.data?.key_prefix || key.slice(0, 8) });
    return json(res, 200, { ok: true, connected: true, key_prefix: status.data?.key_prefix || key.slice(0, 8) });
  }

  if (pathname === '/api/amt/connect' && req.method === 'DELETE') {
    writeAmtStore({});
    return json(res, 200, { ok: true, connected: false });
  }

  if (pathname === '/api/amt/status' && req.method === 'GET') {
    const store = readAmtStore();
    if (!store.key) {
      return json(res, 200, { connected: false, message: 'Not connected — paste an mt_ agent key in Preferences' });
    }
    const status = await amtFetchStatus(store.key);
    if (!status.ok) {
      return json(res, 200, {
        connected: false,
        message: status.error || 'Could not reach AMT',
        key_prefix: store.key_prefix || null,
      });
    }
    let tools = [];
    try { tools = await amtFetchTools(); } catch { tools = []; }
    const plan = String(status.data?.plan || 'free').toLowerCase();
    const paidOk = plan === 'pro' || plan === 'premium' || plan === 'builder';
    const visibleTools = tools.filter((t) => {
      const tier = String(t.tier || 'free').toLowerCase();
      if (tier === 'free') return true;
      return paidOk;
    });
    return json(res, 200, {
      connected: true,
      ...status.data,
      tools: visibleTools,
      tools_total: tools.length,
      paid_tools_unlocked: paidOk,
    });
  }

  return json(res, 404, { error: 'Not found' });
}

function readAmtStore() {
  try {
    if (!fs.existsSync(AMT_STORE)) return {};
    return JSON.parse(fs.readFileSync(AMT_STORE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeAmtStore(data) {
  fs.mkdirSync(path.dirname(AMT_STORE), { recursive: true });
  fs.writeFileSync(AMT_STORE, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(AMT_STORE, 0o600); } catch { /* ignore */ }
}

async function amtFetchStatus(key) {
  try {
    const response = await fetch(`${AMT_BASE}/api/agent/status`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': 'grok-webui-amt-bridge/1.0',
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, status: response.status, error: data.error || `AMT status ${response.status}` };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, status: 502, error: error.message || 'AMT unreachable' };
  }
}

async function amtFetchTools() {
  const response = await fetch(`${AMT_BASE}/api/tools`, {
    headers: { Accept: 'application/json', 'User-Agent': 'grok-webui-amt-bridge/1.0' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `AMT tools ${response.status}`);
  return Array.isArray(data.tools) ? data.tools : [];
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (!sameOrigin(req)) return json(res, 403, { error: 'Origin rejected' });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname);
    if (!authenticated(req)
      && url.pathname !== '/login.html'
      && url.pathname !== '/app.css'
      && url.pathname !== '/app.js') {
      res.writeHead(302, secureHeaders({ Location: '/login.html' }));
      return res.end();
    }
    if (!serveStatic(req, res, url.pathname)) json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Grok WebUI listening on http://${HOST}:${PORT}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
  console.log(`Grok home: ${GROK_HOME}`);
  if (setupRequired()) {
    console.log('No credentials configured — open the UI to set a username and password.');
  }
});

function shutdown() {
  server.close();
  if (bridge.proc && !bridge.proc.killed) bridge.proc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
