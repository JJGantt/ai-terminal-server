import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import OpenAI from 'openai';

// ── Config ────────────────────────────────────────────────────────────────────
const HOME         = os.homedir();
const WS_PORT      = Number(process.env.WS_PORT || 27183);
const HOOK_PORT    = Number(process.env.HOOK_PORT || 27184);
const HISTORY_DIR  = process.env.HISTORY_DIR  || path.join(HOME, 'data/history');
const DEFAULT_CWD  = process.env.DEFAULT_CWD  || HOME;
const PROJECTS_ROOT = path.join(HOME, '.claude/projects');
const NAME_CACHE_PATH = path.join(HISTORY_DIR, 'tab-names.json');
const MAX_SCROLLBACK  = 100 * 1024;

// ── Logging ───────────────────────────────────────────────────────────────────
const LOG_PATH = '/tmp/ai-terminal-server.log';
fs.writeFileSync(LOG_PATH, '');
const log = (...args: unknown[]) => {
  const line = `[server] ${args.join(' ')}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_PATH, line);
};

fs.mkdirSync(HISTORY_DIR, { recursive: true });

// ── State ─────────────────────────────────────────────────────────────────────
const ptySessions  = new Map<string, ReturnType<typeof pty.spawn>>();
const scrollback   = new Map<string, string>();
const wsClients    = new Map<string, Set<WebSocket>>();
const tabNames     = new Map<string, string>();
const tabWorking   = new Map<string, boolean>();
const tabSessionIds = new Map<string, string>();  // tabId → sessionId
const pendingTabs = new Map<string, string | undefined>();  // tabId → resumeSessionId (awaiting first resize)
const wsTranscriptWatchers = new Map<string, string>(); // key → jsonlPath

let nameCache: Record<string, string> = {};
try { nameCache = JSON.parse(fs.readFileSync(NAME_CACHE_PATH, 'utf-8')); } catch { }
function saveNameCache() {
  try { fs.writeFileSync(NAME_CACHE_PATH, JSON.stringify(nameCache, null, 2)); } catch { }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getTabList() {
  const ids = new Set([...ptySessions.keys(), ...pendingTabs.keys()]);
  return [...ids].map(id => ({
    id,
    name: tabNames.get(id) || 'New Session',
    working: tabWorking.get(id) || false,
  }));
}

function broadcastSessions() {
  const msg = JSON.stringify({ type: 'sessions', tabs: getTabList() });
  wsServer.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function appendScrollback(tabId: string, data: string) {
  const cur  = scrollback.get(tabId) || '';
  const next = cur + data;
  scrollback.set(tabId, next.length > MAX_SCROLLBACK ? next.slice(-MAX_SCROLLBACK) : next);
}

function broadcastData(tabId: string, data: string) {
  const subs = wsClients.get(tabId);
  if (!subs?.size) return;
  const msg = JSON.stringify({ type: 'data', tabId, data });
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ── Environment ───────────────────────────────────────────────────────────────
function getCleanEnv(tabId?: string) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_SESSION_ID;
  if (tabId) env.AI_TERMINAL_TAB_ID = tabId;
  return env;
}

// ── CWD resolution ────────────────────────────────────────────────────────────
function resolveSessionCwd(sessionId: string): string {
  try {
    const dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const dir of dirs) {
      const filePath = path.join(PROJECTS_ROOT, dir.name, `${sessionId}.jsonl`);
      if (!fs.existsSync(filePath)) continue;
      // scan backwards for a cwd field
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.cwd && fs.existsSync(msg.cwd)) return msg.cwd;
        } catch { }
      }
      // try decoding dir name as a path
      const decoded = '/' + dir.name.replace(/-/g, '/');
      if (fs.existsSync(decoded)) return decoded;
    }
  } catch { }
  return DEFAULT_CWD;
}

// ── Transcript parser ────────────────────────────────────────────────────────
interface TranscriptMessage { role: 'user' | 'assistant'; text: string; }

function parseTranscript(sessionId: string): TranscriptMessage[] {
  const jsonlPath = findSessionJSONL(sessionId);
  if (!jsonlPath) return [];
  const messages: TranscriptMessage[] = [];
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'user' && msg.message?.role === 'user' && !msg.isMeta) {
          const c = msg.message.content;
          let text = '';
          if (typeof c === 'string') {
            if (!c.trimStart().startsWith('<')) text = c;
          } else if (Array.isArray(c)) {
            text = c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
          }
          if (text.trim()) messages.push({ role: 'user', text: text.trim() });
        } else if (msg.type === 'assistant' && msg.message?.role === 'assistant') {
          const c = msg.message.content;
          if (Array.isArray(c)) {
            const text = c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
            if (text) messages.push({ role: 'assistant', text });
          }
        }
      } catch { }
    }
  } catch { }
  return messages;
}

// ── Session JSONL lookup ────────────────────────────────────────────────────
function findSessionJSONL(sessionId: string): string | null {
  try {
    const dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const filePath = path.join(PROJECTS_ROOT, dir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) return filePath;
    }
  } catch { }
  return null;
}

// ── Tab naming (via stop hook) ───────────────────────────────────────────────
function readConversationPairs(jsonlPath: string, maxPairs = 1): { user: string; assistant: string }[] {
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim());
    const pairs: { user: string; assistant: string }[] = [];
    let lastUser = '';
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'user' && msg.message?.role === 'user') {
          const text = typeof msg.message?.content === 'string'
            ? msg.message.content
            : Array.isArray(msg.message?.content)
              ? msg.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
              : '';
          if (text) lastUser = text.slice(0, 500);
        } else if (msg.type === 'assistant' && msg.message?.role === 'assistant' && lastUser) {
          const text = typeof msg.message?.content === 'string'
            ? msg.message.content
            : Array.isArray(msg.message?.content)
              ? msg.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
              : '';
          pairs.push({ user: lastUser, assistant: (text || '').slice(0, 500) });
          lastUser = '';
          if (pairs.length >= maxPairs) break;
        }
      } catch { }
    }
    return pairs;
  } catch { return []; }
}

function generateName(sessionId: string, tabId: string, transcriptPath: string, forceRegenerate = false) {
  // Check cache first (skip if regenerating)
  if (!forceRegenerate && nameCache[sessionId]) {
    log('tab naming: cached', sessionId, '→', nameCache[sessionId]);
    tabNames.set(tabId, nameCache[sessionId]);
    broadcastSessions();
    return;
  }

  const maxPairs = forceRegenerate ? 5 : 1;
  log('tab naming: reading', transcriptPath, `(${maxPairs} pairs)`);
  const pairs = readConversationPairs(transcriptPath, maxPairs);
  if (!pairs.length) { log('tab naming: no conversation pairs found in', transcriptPath); return; }
  log('tab naming: found pair, user:', pairs[0].user.slice(0, 80));

  let prompt: string;
  if (pairs.length === 1) {
    prompt = `Give a 2-3 word tab title for this user message. Output ONLY the title, nothing else. No quotes. No punctuation.\n\nUser message: ${pairs[0].user}`;
  } else {
    const conversation = pairs.map(p => `User: ${p.user}\nAssistant: ${p.assistant}`).join('\n\n');
    prompt = `Give a 2-3 word tab title for this conversation. Output ONLY the title, nothing else. No quotes. No punctuation.\n\n${conversation}`;
  }

  log('tab naming: asking haiku for', sessionId);
  const proc = execFile('claude', ['-p', '--model', 'haiku', '--permission-mode', 'bypassPermissions'], {
    env: getCleanEnv(),
    timeout: 30000,
  }, (err, stdout) => {
    if (err) { log('tab naming: haiku failed:', err.message); return; }
    const name = stdout.trim();
    if (!name || name.length > 40) { log('tab naming: bad result:', name); return; }
    log('tab naming:', sessionId, '→', name);
    tabNames.set(tabId, name);
    nameCache[sessionId] = name;
    saveNameCache();
    broadcastSessions();
  });
  proc.stdin!.end(prompt);
}

// ── PTY spawn ─────────────────────────────────────────────────────────────────
function spawnPty(id: string, resumeSessionId?: string, cols = 80, rows = 24) {
  log('spawning pty:', id, `${cols}x${rows}`, resumeSessionId ? `(resuming ${resumeSessionId})` : '');
  const cwd  = resumeSessionId ? resolveSessionCwd(resumeSessionId) : DEFAULT_CWD;
  const args = ['--permission-mode', 'bypassPermissions'];
  if (resumeSessionId) args.push('--resume', resumeSessionId);

  const ptyProcess = pty.spawn('claude', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: getCleanEnv(id),
  });

  ptySessions.set(id, ptyProcess);
  tabNames.set(id, (resumeSessionId && nameCache[resumeSessionId]) || 'New Session');
  tabWorking.set(id, false);
  broadcastSessions();

  let hasBeenIdle = false;
  let wasWorking  = false;

  ptyProcess.onData((data) => {
    appendScrollback(id, data);
    broadcastData(id, data);
    const m = data.match(/\x1b\]0;(.*?)\x07/);
    if (m) {
      const title = m[1];
      if (title.startsWith('\u2733')) {
        if (wasWorking) { wasWorking = false; tabWorking.set(id, false); broadcastSessions(); }
        hasBeenIdle = true;
      } else if (hasBeenIdle && !wasWorking) {
        wasWorking = true; tabWorking.set(id, true); broadcastSessions();
      }
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    log(`pty exited: ${id} code=${exitCode} sig=${signal}`);
    ptySessions.delete(id);
    tabNames.delete(id);
    tabWorking.delete(id);
    scrollback.delete(id);
    wsClients.delete(id);
    tabSessionIds.delete(id);
    broadcastSessions();
  });
}

// ── Voice transcription ───────────────────────────────────────────────────────
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI(); // reads OPENAI_API_KEY from env
  return _openai;
}

async function transcribeAudio(audioPath: string, cb: (text: string | null) => void) {
  try {
    const resp = await getOpenAI().audio.transcriptions.create({
      file: fs.createReadStream(audioPath) as any,
      model: 'whisper-1',
    });
    cb(resp.text?.trim() || null);
  } catch (err) {
    log('transcription error:', (err as Error).message);
    cb(null);
  }
}

// ── History ───────────────────────────────────────────────────────────────────
interface SessionInfo { id: string; title: string; timestamp: string; mtime: number; source: string; }

function getHistorySessions(since = 0): SessionInfo[] {
  const sessions = new Map<string, SessionInfo>();
  try {
    const files = fs.readdirSync(HISTORY_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    for (const file of files) {
      const raw     = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf-8'));
      const entries = Array.isArray(raw) ? raw : [];
      for (const entry of entries) {
        const sessionId = entry.session_id || entry.sessionId;
        if (!sessionId) continue;
        if (entry.source === 'system' || entry.source === 'system-error') continue;
        const t = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        if (t < since) continue;
        const title = entry.summary || entry.title || (entry.user || entry.user_prompt || '').slice(0, 60);
        if (!title || title.startsWith('Give a 2-3 word tab title')) continue;
        const existing = sessions.get(sessionId);
        if (!existing || t > existing.mtime) {
          sessions.set(sessionId, { id: sessionId, title, timestamp: entry.timestamp || '', mtime: t, source: entry.source || '' });
        }
      }
    }
  } catch (err) {
    log('getHistorySessions error:', (err as Error).message);
  }
  return [...sessions.values()];
}

// ── HTTP server (for stop hook callbacks) ────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/hook') {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { tabId, sessionId, transcriptPath } = JSON.parse(body);
        log('hook:', tabId, '→', sessionId);

        if (tabId && sessionId) {
          tabSessionIds.set(tabId, sessionId);

          // Only generate name if still "New Session"
          if (tabNames.get(tabId) === 'New Session' && transcriptPath) {
            generateName(sessionId, tabId, transcriptPath);
          }
        }

        res.writeHead(200);
        res.end('ok');
      } catch (err) {
        log('hook error:', (err as Error).message);
        res.writeHead(400);
        res.end('bad request');
      }
    });
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});
httpServer.listen(HOOK_PORT, '127.0.0.1', () => log(`Hook server on :${HOOK_PORT}`));

// ── WebSocket server ──────────────────────────────────────────────────────────
const wsServer = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' });
wsServer.on('listening', () => log(`WS server on :${WS_PORT} | history: ${HISTORY_DIR}`));

wsServer.on('connection', (ws: WebSocket) => {
  log('client connected');
  let currentTab: string | null = null;
  let clientCols = 0;
  let clientRows = 0;
  ws.send(JSON.stringify({ type: 'sessions', tabs: getTabList() }));

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'subscribe': {
          if (currentTab) wsClients.get(currentTab)?.delete(ws);
          currentTab = msg.tabId;
          if (!wsClients.has(currentTab!)) wsClients.set(currentTab!, new Set());
          wsClients.get(currentTab!)!.add(ws);
          const buf = scrollback.get(currentTab!);
          if (buf) ws.send(JSON.stringify({ type: 'scrollback', tabId: currentTab, data: buf }));
          // Auto-resize the subscribed tab to this client's terminal size
          if (clientCols > 0 && clientRows > 0) {
            ptySessions.get(currentTab!)?.resize(clientCols, clientRows);
          }
          break;
        }
        case 'input':
          ptySessions.get(msg.tabId)?.write(msg.data);
          break;
        case 'resize':
          clientCols = msg.cols;
          clientRows = msg.rows;
          // If this tab is pending (awaiting dimensions), spawn it now
          if (pendingTabs.has(msg.tabId)) {
            const resumeId = pendingTabs.get(msg.tabId);
            pendingTabs.delete(msg.tabId);
            spawnPty(msg.tabId, resumeId, msg.cols, msg.rows);
          } else {
            ptySessions.get(msg.tabId)?.resize(msg.cols, msg.rows);
          }
          break;
        case 'list':
          ws.send(JSON.stringify({ type: 'sessions', tabs: getTabList() }));
          break;
        case 'voice_audio': {
          const { tabId, data, durationS } = msg;
          const audioPath = '/tmp/ai-terminal-server-voice.wav';
          fs.writeFileSync(audioPath, Buffer.from(data, 'base64'));
          log(`voice: ${durationS?.toFixed(1)}s for tab ${tabId}`);
          transcribeAudio(audioPath, (text) => {
            if (!text) { log('voice: empty transcription'); return; }
            const cleaned = text.replace(/[\r\n]+/g, ' ').trim();
            log('voice transcribed:', cleaned.slice(0, 100));
            ptySessions.get(tabId)?.write(cleaned + '\r');
          });
          break;
        }
        case 'new_tab': {
          const tabId = `pi-${Date.now()}`;
          if (clientCols > 0 && clientRows > 0) {
            // Already know phone dimensions from a prior resize — spawn immediately
            spawnPty(tabId, undefined, clientCols, clientRows);
          } else {
            // First tab — defer spawn until phone sends resize with actual dimensions
            log('deferring pty spawn for', tabId, '(awaiting resize)');
            pendingTabs.set(tabId, undefined);
            tabNames.set(tabId, 'New Session');
          }
          ws.send(JSON.stringify({ type: 'tab_created', tabId }));
          broadcastSessions();
          break;
        }
        case 'resume_tab': {
          const tabId = `pi-${Date.now()}`;
          if (clientCols > 0 && clientRows > 0) {
            spawnPty(tabId, msg.sessionId, clientCols, clientRows);
          } else {
            log('deferring pty spawn for', tabId, '(awaiting resize, resume:', msg.sessionId, ')');
            pendingTabs.set(tabId, msg.sessionId);
            tabNames.set(tabId, nameCache[msg.sessionId] || 'New Session');
          }
          ws.send(JSON.stringify({ type: 'tab_created', tabId }));
          broadcastSessions();
          break;
        }
        case 'kill_tab': {
          const p = ptySessions.get(msg.tabId);
          if (p) {
            log('killing tab:', msg.tabId);
            p.kill();
          }
          break;
        }
        case 'cache_name': {
          // Mac pushes its generated names to Pi in real-time
          const { sessionId: cacheId, name: cacheName } = msg;
          if (cacheId && cacheName) {
            nameCache[cacheId] = cacheName;
            saveNameCache();
            log(`cache_name: ${cacheId} → ${cacheName}`);
          }
          break;
        }
        case 'history_request': {
          const sessions = getHistorySessions(Date.now() - 7 * 86400000)
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 50)
            .map(s => ({ id: s.id, title: nameCache[s.id] || s.title, timestamp: s.timestamp, source: s.source }));
          log(`history_request: returning ${sessions.length} sessions (${sessions.filter(s => s.source?.includes('pi')).length} pi)`);
          ws.send(JSON.stringify({ type: 'history', sessions }));
          // Retroactively name any sessions missing from the cache
          for (const s of sessions) {
            if (nameCache[s.id]) continue;
            const jsonlPath = findSessionJSONL(s.id);
            if (jsonlPath) generateName(s.id, `history-${s.id}`, jsonlPath);
          }
          break;
        }
        case 'regenerate_name': {
          const { sessionId } = msg;
          if (!sessionId) break;
          const jsonlPath = findSessionJSONL(sessionId);
          if (!jsonlPath) { log('regenerate: no JSONL found for', sessionId); break; }
          // Use a synthetic tabId — if this session has a live tab, find it
          const liveTabId = [...tabSessionIds.entries()].find(([, sid]) => sid === sessionId)?.[0];
          generateName(sessionId, liveTabId || `regen-${sessionId}`, jsonlPath, true);
          break;
        }
        case 'transcript_subscribe': {
          const sessionId = tabSessionIds.get(msg.tabId);
          if (!sessionId) { ws.send(JSON.stringify({ type: 'transcript', tabId: msg.tabId, messages: [] })); break; }
          const messages = parseTranscript(sessionId);
          ws.send(JSON.stringify({ type: 'transcript', tabId: msg.tabId, messages }));
          const jsonlPath = findSessionJSONL(sessionId);
          if (jsonlPath) {
            const key = `ws:${msg.tabId}`;
            if (!wsTranscriptWatchers.has(key)) {
              let lastSize = 0;
              try { lastSize = fs.statSync(jsonlPath).size; } catch {}
              fs.watchFile(jsonlPath, { interval: 500 }, (curr) => {
                if (curr.size <= lastSize) return;
                lastSize = curr.size;
                const updated = parseTranscript(sessionId);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'transcript_update', tabId: msg.tabId, messages: updated }));
                }
              });
              wsTranscriptWatchers.set(key, jsonlPath);
            }
          }
          break;
        }
        case 'transcript_unsubscribe': {
          const key = `ws:${msg.tabId}`;
          const p = wsTranscriptWatchers.get(key);
          if (p) { fs.unwatchFile(p); wsTranscriptWatchers.delete(key); }
          break;
        }
      }
    } catch (e) {
      log('ws error:', (e as Error).message);
    }
  });

  ws.on('close', () => {
    log('client disconnected');
    if (currentTab) wsClients.get(currentTab)?.delete(ws);
    for (const [key, p] of wsTranscriptWatchers) {
      if (key.startsWith('ws:')) { fs.unwatchFile(p); wsTranscriptWatchers.delete(key); }
    }
  });
});

process.on('SIGTERM', () => {
  log('shutting down');
  for (const p of ptySessions.values()) p.kill();
  process.exit(0);
});
