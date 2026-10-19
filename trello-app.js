#!/usr/bin/env node
// datedeck Trello card creator: a small app that runs on your computer.
//
//   node tools/trello-app.js [plan.json]
//
// Opens a page at http://localhost:4321 where you check your team's Trello usernames, pick a board,
// and create every card assigned to its owner. The Trello API key and token are read from the .env file
// in this folder (TRELLO_KEY and TRELLO_TOKEN) or from the environment. They're only ever sent to
// api.trello.com, never to the page.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { client, validatePlan, applyTeam, whoAmI, listsOf, findMember, buildBoard, saveLastRun, loadLastRun, deleteLastRun, TrelloError } = require('./trello-core');

const PORT = Number(process.env.TRELLO_APP_PORT || 4321);
const HOST = '127.0.0.1';
const PAGE = path.join(__dirname, 'trello-app.html');
const ENV_FILE = path.join(__dirname, '.env');

// Read KEY=value lines from .env. Values already in the environment win.
function loadEnv() {
  let text;
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnv();
const KEY = (process.env.TRELLO_KEY || '').trim();
const TOKEN = (process.env.TRELLO_TOKEN || '').trim();

// Plan: the file given on the command line, else datedeck-trello.json in the current folder, else the default.
function findPlanFile() {
  const arg = process.argv[2];
  if (arg) return arg;
  const here = path.resolve('datedeck-trello.json');
  if (fs.existsSync(here)) return here;
  return path.join(__dirname, 'datedeck-trello.json');
}
let planFile = findPlanFile();
let plan;
try {
  plan = validatePlan(JSON.parse(fs.readFileSync(planFile, 'utf8')));
} catch (e) {
  console.error(`\nCouldn't load the plan from ${planFile}: ${e.message}\n`);
  process.exit(1);
}

// ---------- helpers ----------
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function readJson(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(Object.assign(new Error('That file is too large.'), { status: 413 })); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(Object.assign(new Error('The request was not valid JSON.'), { status: 400 })); } });
    req.on('error', reject);
  });
}
// Only accept requests from this app's own page, so other websites can't drive it.
// The Host check stops other websites from reaching this server through DNS tricks.
function sameOrigin(req) {
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] ? req.headers['sec-fetch-site'] === 'same-origin' : true;
  return origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
}
function creds() {
  if (!KEY || !TOKEN) throw new TrelloError('No Trello key and token yet. Put TRELLO_KEY and TRELLO_TOKEN in the .env file in this folder, then restart the app.', 400);
  return client({ key: KEY, token: TOKEN });
}
function stream(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  return (e) => res.write(JSON.stringify(e) + '\n');
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/plan') return send(res, 200, { plan, file: path.basename(planFile) });
    if (req.method === 'GET' && url.pathname === '/api/last-run') return send(res, 200, { run: loadLastRun() });

    if (req.method !== 'POST') return send(res, 404, { error: 'Not found.' });
    if (!sameOrigin(req)) return send(res, 403, { error: 'This app only accepts requests from its own page.' });
    const body = await readJson(req);

    if (url.pathname === '/plan') {
      plan = validatePlan(body.plan);
      planFile = body.name || 'uploaded plan';
      return send(res, 200, { plan, file: planFile });
    }
    if (url.pathname === '/api/connect') return send(res, 200, await whoAmI(creds()));
    if (url.pathname === '/api/lists') return send(res, 200, { lists: await listsOf(creds(), body.boardId) });
    if (url.pathname === '/api/member') return send(res, 200, await findMember(creds(), body.username));

    if (url.pathname === '/api/undo') {
      const trello = creds();
      const emit = stream(res);
      try { await deleteLastRun(trello, emit); } catch (e) { emit({ type: 'fatal', text: e.message }); }
      return res.end();
    }

    if (url.pathname === '/api/create') {
      const trello = creds();
      const ready = applyTeam(plan, body.team);
      const emit = stream(res);
      try {
        const result = await buildBoard(trello, ready, {
          boardId: body.board?.mode === 'existing' ? body.board.id : undefined,
          boardName: body.board?.name,
          workspaceId: body.board?.workspace || undefined,
          listId: body.board?.mode === 'existing' && /^list:/.test(body.board?.placement || '') ? body.board.placement.slice(5) : undefined,
          placement: body.board?.placement === 'sprint' ? 'sprint' : 'person',
          sprints: Array.isArray(body.sprints) ? body.sprints : undefined,
          checklists: body.checklists !== false,
          dueDates: body.dueDates !== false,
        }, emit);
        saveLastRun(result);
      } catch (e) {
        emit({ type: 'fatal', text: e.message });
      }
      return res.end();
    }
    send(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status && e.status < 600 && e.status >= 400 ? e.status : 500, { error: e.message });
    else res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is busy. Is the app already open? Or run with TRELLO_APP_PORT=4322.\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const link = `http://localhost:${PORT}`;
  console.log(`\ndatedeck Trello card creator is running.\n\n  Open ${link}\n\n  Plan: ${path.basename(planFile)} (${plan.cards.length} cards)\n  Press Ctrl+C to stop.\n`);
  if (!KEY || !TOKEN) console.log(`  No Trello key and token yet: add TRELLO_KEY and TRELLO_TOKEN to ${ENV_FILE} and restart.\n`);
  if (!process.env.NO_OPEN) {
    const cmd = process.platform === 'darwin' ? `open "${link}"` : process.platform === 'win32' ? `start "" "${link}"` : `xdg-open "${link}"`;
    exec(cmd, () => {});
  }
});
