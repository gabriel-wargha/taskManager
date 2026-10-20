#!/usr/bin/env node
// Try the app without a Trello account: `npm run demo`.
//
// Starts the fake Trello in fake-trello.js, sets up a "DateDeck" board that already has sprint 1 on it
// (as if the team ran the app two weeks ago), then opens the real app pointed at the fake.
// Nothing is sent to Trello, your .env is ignored, and your real last-run.json is left alone.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeTrello } = require('./fake-trello');

async function main() {
  const fake = await createFakeTrello({ key: 'demo', token: 'demo', me: { username: 'demo', fullName: 'Demo User' } }).listen();

  // Set before trello-core loads, since it reads TRELLO_LAST_RUN once. Values in the environment win over .env.
  Object.assign(process.env, {
    TRELLO_KEY: 'demo',
    TRELLO_TOKEN: 'demo',
    TRELLO_API_BASE: fake.url,
    TRELLO_LAST_RUN: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trello-demo-')), 'last-run.json'),
    TRELLO_GAP_MS: process.env.TRELLO_GAP_MS || '60', // slow enough to watch the cards arrive
  });
  const { client, validatePlan, buildBoard } = require('./trello-core');

  // Everyone in the plan with a username exists on the fake Trello.
  const plan = validatePlan(JSON.parse(fs.readFileSync(path.join(__dirname, 'datedeck-trello.json'), 'utf8')));
  for (const m of plan.members) if (m.trello) fake.addUser({ username: m.trello, fullName: m.name });

  // The board after sprint 1. Members without a username in the plan join it under a matching name,
  // so the app can show it assigning their cards by name.
  const board = fake.addBoard({
    name: plan.board || 'DateDeck',
    members: plan.members.filter((m) => !m.trello).map((m) => `${m.name.toLowerCase()}-demo`),
  });
  for (const m of plan.members) {
    const u = fake.state.users.find((x) => x.username === `${m.name.toLowerCase()}-demo`);
    if (u) u.fullName = m.name;
  }
  await buildBoard(client({ key: 'demo', token: 'demo', gapMs: 0 }), plan, { boardId: board.id, sprints: [plan.sprints[0].n] });
  fake.addBoard({ name: 'Personal errands' }); // so the board picker has more than one choice

  console.log(`\nDemo mode: a fake Trello is running at ${fake.url}. Nothing is sent to Trello.`);
  console.log(`The "${board.name}" board already has sprint ${plan.sprints[0].n}; try creating the next sprint, running it again, and undo.`);
  require('./trello-app');
}

main().catch((e) => { console.error(e); process.exit(1); });
