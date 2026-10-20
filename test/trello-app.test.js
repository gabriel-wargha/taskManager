// Starts the real app (trello-app.js) against the fake Trello and talks to it over HTTP.

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { tempLastRun } = require('./helpers');
const { createFakeTrello } = require('../fake-trello');

let fake, app, port;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// http.request rather than fetch, because fetch won't let a test set the Host header.
function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const events = (text) => text.trim().split('\n').map((l) => JSON.parse(l));

before(async () => {
  fake = await createFakeTrello({ key: 'k', token: 't' }).listen();
  fake.addUser({ username: 'rychenjones' });
  fake.addUser({ username: 'rileycluff' });
  fake.addUser({ username: 'gabrielwargha' });
  port = await freePort();
  app = spawn(process.execPath, [path.join(__dirname, '..', 'trello-app.js')], {
    env: {
      ...process.env, TRELLO_KEY: 'k', TRELLO_TOKEN: 't', TRELLO_API_BASE: fake.url, TRELLO_APP_PORT: String(port),
      TRELLO_LAST_RUN: tempLastRun(), TRELLO_GAP_MS: '0', NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    app.stdout.on('data', (d) => { if (String(d).includes('is running')) resolve(); });
    app.on('exit', (code) => reject(new Error(`the app exited with code ${code}`)));
  });
});
after(async () => {
  app.kill();
  await fake.close();
});

test('serves the page and the plan', async () => {
  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  const plan = JSON.parse((await request('GET', '/plan')).text);
  assert.equal(plan.plan.format, 'datedeck-trello-plan');
});

test('refuses requests from other websites', async () => {
  const foreign = await request('POST', '/api/connect', { body: {}, headers: { Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  const crossSite = await request('POST', '/api/connect', { body: {}, headers: { Origin: '', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
});

test('refuses a foreign Host header (DNS rebinding)', async () => {
  const res = await request('POST', '/api/connect', { body: {}, headers: { Host: `evil.example:${port}` } });
  assert.equal(res.status, 403);
});

test('connect returns the signed-in user without exposing the key or token', async () => {
  const res = await request('POST', '/api/connect', { body: {} });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).me.username, 'me');
  assert.doesNotMatch(res.text, /"k"|"t"/);
});

test('checks a username', async () => {
  assert.equal(JSON.parse((await request('POST', '/api/member', { body: { username: '@rileycluff' } })).text).found, true);
  assert.equal(JSON.parse((await request('POST', '/api/member', { body: { username: 'nobody' } })).text).found, false);
});

test('creates a sprint, streaming progress, then undoes it', async () => {
  const res = await request('POST', '/api/create', { body: { board: { mode: 'new', name: 'Demo' }, sprints: [1] } });
  assert.match(res.type, /ndjson/);
  const stream = events(res.text);
  const done = stream.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.created, 8);
  assert.equal(stream.filter((e) => e.type === 'card').length, 8);
  assert.equal(fake.state.cards.length, 8);

  const lastRun = JSON.parse((await request('GET', '/api/last-run')).text).run;
  assert.equal(lastRun.cards.length, 8);

  const undo = events((await request('POST', '/api/undo', { body: {} })).text);
  assert.equal(undo.at(-1).type, 'undone');
  assert.equal(undo.at(-1).deleted, 8);
  assert.equal(fake.state.cards.length, 0);
});

test('rejects an uploaded file that is not a plan', async () => {
  const res = await request('POST', '/plan', { body: { plan: { hello: 'world' } } });
  assert.equal(res.status, 400);
});
