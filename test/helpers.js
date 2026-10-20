'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// A small plan in the same shape as datedeck-trello.json: two people, two sprints, three cards.
function samplePlan() {
  const ana = { name: 'Ana', trello: 'ana', role: 'Backend' };
  const ben = { name: 'Ben', trello: '', role: 'Frontend' };
  return {
    format: 'datedeck-trello-plan',
    version: 1,
    board: 'Test board',
    labels: [{ name: 'Backend', color: 'green' }, { name: 'Frontend', color: 'blue' }],
    members: [ana, ben],
    sprints: [
      { n: 1, name: 'One', list: 'Sprint 1: One', start: '2026-10-05', end: '2026-10-16' },
      { n: 2, name: 'Two', list: 'Sprint 2: Two', start: '2026-10-19', end: '2026-10-30' },
    ],
    cards: [
      { id: 'T-01', title: 'T-01 Database', story: 'As a user...', criteria: ['Runs', 'Has data'], labels: ['Backend'], sprint: 1, week: 1, weekStart: '2026-10-05', due: '2026-10-09', owner: { ...ana }, deps: [] },
      { id: 'T-02', title: 'T-02 Layout', story: 'As a user...', criteria: ['Looks right'], labels: ['Frontend'], sprint: 1, week: 2, weekStart: '2026-10-12', due: '2026-10-16', owner: { ...ben }, deps: [] },
      { id: 'T-03', title: 'T-03 Swipe', story: 'As a user...', criteria: [], labels: ['Frontend'], sprint: 2, week: 1, weekStart: '2026-10-19', due: '2026-10-23', owner: { ...ben }, deps: ['T-02'] },
    ],
  };
}

// A temp file path for last-run.json, so tests never touch the real one.
function tempLastRun() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trello-test-')), 'last-run.json');
}

module.exports = { samplePlan, tempLastRun };
