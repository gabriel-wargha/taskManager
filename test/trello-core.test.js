'use strict';

const { test, describe: group, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { samplePlan, tempLastRun } = require('./helpers');

// trello-core reads TRELLO_LAST_RUN when it loads, so set it first.
process.env.TRELLO_LAST_RUN = tempLastRun();
const core = require('../trello-core');
const { createFakeTrello } = require('../fake-trello');

let fake, trello;
beforeEach(async () => {
  fake = await createFakeTrello().listen();
  fake.addUser({ username: 'ana', fullName: 'Ana Lopez' });
  trello = core.client({ key: 'test-key', token: 'test-token', base: fake.url, gapMs: 0 });
  fs.rmSync(process.env.TRELLO_LAST_RUN, { force: true });
});
afterEach(() => fake.close());

const collect = () => {
  const events = [];
  const emit = (e) => events.push(e);
  emit.events = events;
  return emit;
};
const listName = (card) => fake.state.lists.find((l) => l.id === card.idList).name;
const cardNamed = (name) => fake.state.cards.find((c) => c.name === name);

group('plan helpers', () => {
  test('validatePlan accepts a plan and rejects other JSON', () => {
    assert.ok(core.validatePlan(samplePlan()));
    assert.throws(() => core.validatePlan({ cards: [] }), /isn't a datedeck plan/);
    assert.throws(() => core.validatePlan(null), core.TrelloError);
  });

  test('the shipped plan file is valid and consistent', () => {
    const plan = core.validatePlan(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'datedeck-trello.json'), 'utf8')));
    const roles = new Set(plan.members.map((m) => m.role));
    const labels = new Set(plan.labels.map((l) => l.name));
    const sprints = new Set(plan.sprints.map((s) => s.n));
    const titles = new Set();
    for (const c of plan.cards) {
      assert.ok(roles.has(c.owner.role), `${c.id} has an unknown owner role`);
      assert.ok(sprints.has(c.sprint), `${c.id} is in an unknown sprint`);
      for (const l of c.labels) assert.ok(labels.has(l), `${c.id} uses an unknown label ${l}`);
      assert.ok(!titles.has(c.title), `${c.title} appears twice`); // titles are how re-runs spot existing cards
      titles.add(c.title);
    }
  });

  test('applyTeam renames people and their cards by role, and strips @ from usernames', () => {
    const plan = core.applyTeam(samplePlan(), [{ role: 'Frontend', name: ' Benny ', trello: '@benny' }]);
    assert.deepEqual(plan.members[1], { name: 'Benny', trello: 'benny', role: 'Frontend' });
    assert.equal(plan.cards[1].owner.name, 'Benny');
    assert.equal(plan.cards[1].owner.trello, 'benny');
    assert.equal(plan.cards[0].owner.name, 'Ana', 'other people are unchanged');
  });

  test('describe builds the branch name from the owner’s current name', () => {
    const plan = core.applyTeam(samplePlan(), [{ role: 'Backend', name: 'Ana Maria', trello: 'ana' }]);
    const text = core.describe(plan.cards[0], plan);
    assert.match(text, /- Branch: ana-maria\/t-01/);
    assert.match(text, /- Sprint 1: One \(2026-10-05 to 2026-10-16\)/);
  });
});

group('buildBoard', () => {
  test('creates a new board with a To do list per person, the shared Done list, labels and cards', async () => {
    const emit = collect();
    const result = await core.buildBoard(trello, samplePlan(), { sprints: [1] }, emit);

    assert.equal(result.created, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed, 0);
    assert.deepEqual(fake.state.lists.map((l) => l.name), ['Ana: To do', 'Ben: To do', core.DONE_LIST]);
    assert.deepEqual(fake.state.labels.map((l) => l.name), ['Backend', 'Frontend']);

    const db = cardNamed('T-01 Database');
    assert.equal(listName(db), 'Ana: To do');
    assert.equal(db.due, '2026-10-09T17:00:00.000Z');
    assert.deepEqual(db.idMembers, [fake.state.users.find((u) => u.username === 'ana').id]);
    assert.deepEqual(db.idLabels, [fake.state.labels.find((l) => l.name === 'Backend').id]);
    const checklist = fake.state.checklists.find((c) => c.idCard === db.id);
    assert.deepEqual(checklist.checkItems.map((i) => i.name), ['Runs', 'Has data']);

    assert.equal(listName(cardNamed('T-02 Layout')), 'Ben: To do');
    assert.equal(cardNamed('T-03 Swipe'), undefined, 'only the chosen sprint is created');
    assert.equal(emit.events.at(-1).type, 'done');
  });

  test('running twice creates nothing new, and archived cards count as already there', async () => {
    await core.buildBoard(trello, samplePlan(), { sprints: [1] });
    const board = fake.state.boards[0];
    cardNamed('T-01 Database').closed = true; // someone archived it

    const before = fake.state.cards.length;
    const again = await core.buildBoard(trello, samplePlan(), { boardId: board.id, sprints: [1] });
    assert.equal(again.created, 0);
    assert.equal(again.skipped, 2);
    assert.equal(fake.state.cards.length, before);
    assert.equal(fake.state.lists.length, 3, 'lists are reused, not duplicated');
    assert.equal(fake.state.labels.length, 2, 'labels are reused, not duplicated');
  });

  test('adds a later sprint to the existing board and reuses lists regardless of capitalization', async () => {
    const board = fake.addBoard({ name: 'Existing', lists: ['ana: TO DO', 'Ben: To do', 'Done - Team'] });
    const result = await core.buildBoard(trello, samplePlan(), { boardId: board.id, sprints: [2] });
    assert.equal(result.created, 1);
    assert.equal(fake.state.lists.length, 3);
    assert.equal(listName(cardNamed('T-03 Swipe')), 'Ben: To do');
  });

  test('a person without a username is matched to a board member by first name', async () => {
    const board = fake.addBoard({ name: 'Existing', members: ['benjamin99'] });
    fake.state.users.find((u) => u.username === 'benjamin99').fullName = 'Ben Carter';
    await core.buildBoard(trello, samplePlan(), { boardId: board.id, sprints: [1] });
    assert.deepEqual(cardNamed('T-02 Layout').idMembers, [fake.state.users.find((u) => u.username === 'benjamin99').id]);
  });

  test('two board members matching the same name leaves the card unassigned with a warning', async () => {
    const board = fake.addBoard({ name: 'Existing', members: ['ben1', 'ben2'] });
    const emit = collect();
    await core.buildBoard(trello, samplePlan(), { boardId: board.id, sprints: [1] }, emit);
    assert.deepEqual(cardNamed('T-02 Layout').idMembers, []);
    assert.ok(emit.events.some((e) => e.type === 'warn' && /more than one board member/.test(e.text)));
  });

  test('an unknown username warns and leaves those cards unassigned', async () => {
    const plan = core.applyTeam(samplePlan(), [{ role: 'Backend', name: 'Ana', trello: 'nobody' }]);
    const emit = collect();
    const result = await core.buildBoard(trello, plan, { sprints: [1] }, emit);
    assert.equal(result.created, 2);
    assert.deepEqual(cardNamed('T-01 Database').idMembers, []);
    assert.ok(emit.events.some((e) => e.type === 'warn' && /Couldn't find @nobody/.test(e.text)));
  });

  test('teammates are added to the board so their cards can be assigned', async () => {
    const board = fake.addBoard({ name: 'Existing' });
    await core.buildBoard(trello, samplePlan(), { boardId: board.id, sprints: [1] });
    assert.ok(board.members.includes(fake.state.users.find((u) => u.username === 'ana').id));
  });

  test('placement in one existing list, without creating any lists', async () => {
    const board = fake.addBoard({ name: 'Existing', lists: ['Backlog'] });
    const backlog = fake.state.lists[0];
    await core.buildBoard(trello, samplePlan(), { boardId: board.id, listId: backlog.id });
    assert.equal(fake.state.lists.length, 1);
    assert.ok(fake.state.cards.every((c) => c.idList === backlog.id));
  });

  test('checklists and due dates can be turned off', async () => {
    await core.buildBoard(trello, samplePlan(), { sprints: [1], checklists: false, dueDates: false });
    assert.equal(fake.state.checklists.length, 0);
    assert.equal(cardNamed('T-01 Database').due, null);
  });

  test('one failed card is reported and the rest are still created', async () => {
    fake.fail({ method: 'POST', path: /^\/cards$/, status: 400, body: 'invalid value for name' });
    const emit = collect();
    const result = await core.buildBoard(trello, samplePlan(), {}, emit);
    assert.equal(result.failed, 1);
    assert.equal(result.created, 2);
    assert.match(emit.events.find((e) => e.type === 'error').text, /T-01 Database: Trello returned 400/);
  });

  test('a lost permission stops the run instead of failing every card', async () => {
    fake.fail({ method: 'POST', path: /^\/cards$/, status: 403, times: 99 });
    const result = await core.buildBoard(trello, samplePlan(), {});
    assert.equal(result.failed, 1);
    assert.equal(fake.calls.filter((c) => c.method === 'POST' && c.path === '/cards').length, 1);
  });

  test('a sprint with no cards is an error', async () => {
    await assert.rejects(core.buildBoard(trello, samplePlan(), { sprints: [9] }), /no cards in the chosen sprint/);
  });
});

group('client', () => {
  test('retries when Trello says to slow down (429)', async () => {
    fake.fail({ method: 'GET', path: /^\/members\/me$/, status: 429 });
    const me = await trello('GET', '/members/me', { fields: 'username' });
    assert.equal(me.username, 'me');
    assert.equal(fake.calls.length, 2);
  });

  test('turns a bad key into a clear message', async () => {
    const bad = core.client({ key: 'wrong', token: 'test-token', base: fake.url, gapMs: 0 });
    await assert.rejects(bad('GET', '/members/me'), { status: 401, message: /rejected the key or token/ });
  });

  test('spaces requests out by gapMs', async () => {
    const slow = core.client({ key: 'test-key', token: 'test-token', base: fake.url, gapMs: 50 });
    const start = Date.now();
    for (let i = 0; i < 4; i++) await slow('GET', '/members/me');
    assert.ok(Date.now() - start >= 150, 'four requests take at least three gaps');
  });

  test('needs both a key and a token', () => {
    assert.throws(() => core.client({ key: 'k' }), /both your Trello API key and token/);
  });
});

group('undo', () => {
  test('deletes only the cards the last run created', async () => {
    const board = fake.addBoard({ name: 'Existing', cards: [{ name: 'Older card', list: 'Backlog' }] });
    core.saveLastRun(await core.buildBoard(trello, samplePlan(), { boardId: board.id, sprints: [1] }));
    core.saveLastRun(await core.buildBoard(trello, samplePlan(), { boardId: board.id, sprints: [2] }));

    const result = await core.deleteLastRun(trello);
    assert.equal(result.deleted, 1);
    assert.deepEqual(fake.state.cards.map((c) => c.name).sort(), ['Older card', 'T-01 Database', 'T-02 Layout']);
    assert.equal(core.loadLastRun(), null, 'the record is removed once everything is deleted');
  });

  test('a run that created nothing does not replace the record of the last real run', async () => {
    core.saveLastRun(await core.buildBoard(trello, samplePlan(), { sprints: [1] }));
    const boardId = fake.state.boards[0].id;
    core.saveLastRun(await core.buildBoard(trello, samplePlan(), { boardId, sprints: [1] })); // all skipped
    assert.equal(core.loadLastRun().cards.length, 2);
  });

  test('cards already deleted by hand are counted as gone', async () => {
    core.saveLastRun(await core.buildBoard(trello, samplePlan(), { sprints: [1] }));
    fake.state.cards.splice(fake.state.cards.indexOf(cardNamed('T-01 Database')), 1);
    const result = await core.deleteLastRun(trello);
    assert.deepEqual({ deleted: result.deleted, gone: result.gone }, { deleted: 1, gone: 1 });
  });

  test('keeps the cards it could not delete so a retry picks up where it stopped', async () => {
    core.saveLastRun(await core.buildBoard(trello, samplePlan(), {}));
    fake.fail({ method: 'DELETE', path: /^\/cards\//, status: 403, times: 1 }); // first delete fails, which stops the loop
    const result = await core.deleteLastRun(trello);
    assert.equal(result.failed, 1);
    assert.equal(core.loadLastRun().cards.length, 3, 'the failed card and the ones after it are kept');

    const retry = await core.deleteLastRun(trello);
    assert.equal(retry.deleted, 3);
    assert.equal(fake.state.cards.length, 0);
  });

  test('says so when there is nothing to undo', async () => {
    await assert.rejects(core.deleteLastRun(trello), /no run to undo/);
  });
});

group('removePlanCards', () => {
  test('removes open cards whose titles match the plan and nothing else', async () => {
    const board = fake.addBoard({
      name: 'Existing',
      cards: [{ name: 'T-01 Database', list: 'A' }, { name: 'T-03 Swipe', list: 'A' }, { name: 'Unrelated', list: 'A' }],
    });
    const result = await core.removePlanCards(trello, board.id, samplePlan(), [1]);
    assert.equal(result.removed, 1);
    assert.deepEqual(fake.state.cards.map((c) => c.name), ['T-03 Swipe', 'Unrelated']);
  });
});
