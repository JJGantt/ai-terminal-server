#!/usr/bin/env node
// Stop hook for Claude Code sessions spawned by ai-terminal-server.
// Reads hook payload from stdin, POSTs session info to the server's HTTP endpoint.

const http = require('http');
const path = require('path');

const HOOK_PORT = process.env.HOOK_PORT || 27184;
const tabId = process.env.AI_TERMINAL_TAB_ID;

if (!tabId) process.exit(0); // Not spawned by our server

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input);
    const transcriptPath = payload.transcript_path || '';
    const sessionId = transcriptPath
      ? path.basename(transcriptPath, '.jsonl')
      : null;

    if (!sessionId) process.exit(0);

    // Skip naming sessions (avoid infinite loop)
    const userMsg = payload.last_user_message || '';
    if (userMsg.includes('Give a 2-3 word tab title')) process.exit(0);

    const body = JSON.stringify({ tabId, sessionId, transcriptPath });
    const req = http.request({
      hostname: '127.0.0.1',
      port: HOOK_PORT,
      path: '/hook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    }, () => process.exit(0));

    req.on('error', () => process.exit(0));
    req.end(body);
  } catch {
    process.exit(0);
  }
});
