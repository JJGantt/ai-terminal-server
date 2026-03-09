import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import OpenAI from 'openai';

// ── Config ────────────────────────────────────────────────────────────────────
const HOME         = os.homedir();
const WS_PORT      = Number(process.env.WS_PORT || 27183);
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
const ptySessions = new Map<string, ReturnType<typeof pty.spawn>>();
const scrollback  = new Map<string, string>();
const wsClients   = new Map<string, Set<WebSocket>>();
const tabNames    = new Map<string, string>();
const tabWorking  = new Map<string, boolean>();

let nameCache: Record<string, string> = {};
try { nameCache = JSON.parse(fs.readFileSync(NAME_CACHE_PATH, 'utf-8')); } catch { }
function saveNameCache() {
  try { fs.writeFileSync(NAME_CACHE_PATH, JSON.stringify(nameCache, null, 2)); } catch { }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getTabList() {
  return [...ptySessions.keys()].map(id => ({
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
function getCleanEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_SESSION_ID;
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

// ── PTY spawn ─────────────────────────────────────────────────────────────────
function spawnPty(id: string, resumeSessionId?: string) {
  log('spawning pty:', id, resumeSessionId ? `(resuming ${resumeSessionId})` : '');
  const cwd  = resumeSessionId ? resolveSessionCwd(resumeSessionId) : DEFAULT_CWD;
  const args = ['--dangerously-skip-permissions'];
  if (resumeSessionId) args.push('--resume', resumeSessionId);

  const ptyProcess = pty.spawn('claude', args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: getCleanEnv(),
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
interface SessionInfo { id: string; title: string; timestamp: string; mtime: number; }

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
        const t = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        if (t < since) continue;
        const title = entry.summary || entry.title || (entry.user_prompt || '').slice(0, 60);
        if (!title) continue;
        const existing = sessions.get(sessionId);
        if (!existing || t > existing.mtime) {
          sessions.set(sessionId, { id: sessionId, title, timestamp: entry.timestamp || '', mtime: t });
        }
      }
    }
  } catch (err) {
    log('getHistorySessions error:', (err as Error).message);
  }
  return [...sessions.values()];
}

// ── WebSocket server ──────────────────────────────────────────────────────────
const wsServer = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' });
wsServer.on('listening', () => log(`WS server on :${WS_PORT} | history: ${HISTORY_DIR}`));

wsServer.on('connection', (ws: WebSocket) => {
  log('client connected');
  let currentTab: string | null = null;
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
          break;
        }
        case 'input':
          ptySessions.get(msg.tabId)?.write(msg.data);
          break;
        case 'resize':
          ptySessions.get(msg.tabId)?.resize(msg.cols, msg.rows);
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
            log('voice transcribed:', text.slice(0, 100));
            ptySessions.get(tabId)?.write(text + '\r');
          });
          break;
        }
        case 'new_tab': {
          const tabId = `pi-${Date.now()}`;
          spawnPty(tabId);
          ws.send(JSON.stringify({ type: 'tab_created', tabId }));
          break;
        }
        case 'resume_tab': {
          const tabId = `pi-${Date.now()}`;
          spawnPty(tabId, msg.sessionId);
          ws.send(JSON.stringify({ type: 'tab_created', tabId }));
          break;
        }
        case 'history_request': {
          const sessions = getHistorySessions(Date.now() - 7 * 86400000)
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 50)
            .map(s => ({ id: s.id, title: nameCache[s.id] || s.title, timestamp: s.timestamp }));
          ws.send(JSON.stringify({ type: 'history', sessions }));
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
  });
});

process.on('SIGTERM', () => {
  log('shutting down');
  for (const p of ptySessions.values()) p.kill();
  process.exit(0);
});
