// Shared Trello logic for the datedeck tools: talks to the Trello REST API and builds the board.
// Used by trello-app.js (the browser app) and create-trello-board.js (the command line).
// No dependencies; needs Node 18+ for fetch.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_API = 'https://api.trello.com/1';
// The one Done list the whole team shares; finished cards from every person go here.
const DONE_LIST = 'Done - Team';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TrelloError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function explain(status, body, method, path) {
  const detail = String(body || '').slice(0, 200).trim();
  if (status === 401) return 'Trello rejected the key or token. Check that both are copied in full and that the token was made for this key.';
  if (status === 403) return `Trello refused ${method} ${path}. The token may not have write access to this board or workspace.`;
  if (status === 404) return `Trello could not find ${path}.`;
  if (status === 429) return 'Trello is limiting requests. Wait a minute and try again.';
  return `Trello returned ${status} for ${method} ${path}${detail ? `: ${detail}` : ''}`;
}

// A small Trello client. Spaces requests out to stay under Trello's limit
// (100 requests per 10 seconds per token) and retries when asked to slow down.
function client({ key, token, base = process.env.TRELLO_API_BASE || DEFAULT_API, gapMs = Number(process.env.TRELLO_GAP_MS ?? 120) }) {
  if (!key || !token) throw new TrelloError('Enter both your Trello API key and token.', 400);
  let last = 0;
  return async function trello(method, path, params = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    for (let attempt = 1; ; attempt++) {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { Accept: 'application/json', Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"` },
        });
      } catch (err) {
        if (attempt < 3) { await sleep(1000 * attempt); continue; }
        throw new TrelloError(`Could not reach Trello (${err.message}). Check your internet connection.`, 0);
      }
      if (res.status === 429 && attempt < 5) { await sleep(2000 * attempt); continue; }
      const text = await res.text();
      if (!res.ok) throw new TrelloError(explain(res.status, text, method, path), res.status);
      return text ? JSON.parse(text) : null;
    }
  };
}

// ---------- Plan file ----------
function validatePlan(plan) {
  if (!plan || plan.format !== 'datedeck-trello-plan' || !Array.isArray(plan.cards) || !Array.isArray(plan.sprints) || !Array.isArray(plan.members)) {
    throw new TrelloError("That file isn't a datedeck plan. Download it from the sprint plan page with \"Download for Trello script\".", 400);
  }
  return plan;
}

// Apply team names and Trello usernames (by role) to every card's owner.
function applyTeam(plan, team = []) {
  const byRole = new Map(team.filter((t) => t && t.role).map((t) => [t.role, t]));
  const clean = (u) => String(u || '').trim().replace(/^@/, '');
  const members = plan.members.map((m) => {
    const t = byRole.get(m.role);
    return t ? { ...m, name: String(t.name || m.name).trim() || m.name, trello: clean(t.trello) } : { ...m, trello: clean(m.trello) };
  });
  const memberByRole = new Map(members.map((m) => [m.role, m]));
  const cards = plan.cards.map((c) => {
    const m = memberByRole.get(c.owner.role);
    return m ? { ...c, owner: { ...c.owner, name: m.name, trello: m.trello } } : c;
  });
  return { ...plan, members, cards };
}

function describe(card, plan) {
  const sprint = plan.sprints.find((s) => s.n === card.sprint);
  const lines = ['**User story**', card.story, '', '**Details**'];
  if (sprint) lines.push(`- Sprint ${sprint.n}: ${sprint.name} (${sprint.start} to ${sprint.end})`);
  if (card.week) lines.push(`- Week ${card.week}${card.weekStart ? `: ${card.weekStart} to ${card.due}` : ''}`);
  lines.push(`- Owner: ${card.owner.name} (${card.owner.role})`);
  // Branch from the owner's current name, since the app lets you rename people.
  if (card.week) lines.push(`- Branch: ${card.owner.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${card.id.toLowerCase()}`);
  if (card.deps?.length) lines.push(`- Depends on: ${card.deps.join(', ')}`);
  return lines.join('\n');
}

// Due at 5 pm UTC on the sprint's last day, so it lands on that date across American time zones.
const dueAt = (date) => `${date}T17:00:00.000Z`;

// ---------- Lookups for the app ----------
async function whoAmI(trello) {
  const me = await trello('GET', '/members/me', { fields: 'username,fullName' });
  const [boards, workspaces] = await Promise.all([
    trello('GET', '/members/me/boards', { fields: 'name,url,closed', filter: 'open' }).catch(() => []),
    trello('GET', '/members/me/organizations', { fields: 'displayName,name' }).catch(() => []),
  ]);
  return {
    me: { id: me.id, username: me.username, fullName: me.fullName },
    boards: (Array.isArray(boards) ? boards : []).map((b) => ({ id: b.id, name: b.name, url: b.url })),
    workspaces: (Array.isArray(workspaces) ? workspaces : []).map((w) => ({ id: w.id, name: w.displayName || w.name })),
  };
}

async function listsOf(trello, boardId) {
  const lists = await trello('GET', `/boards/${encodeURIComponent(boardId)}/lists`, { fields: 'name', filter: 'open' });
  return (Array.isArray(lists) ? lists : []).map((l) => ({ id: l.id, name: l.name }));
}

async function findMember(trello, username) {
  const u = String(username || '').trim().replace(/^@/, '');
  if (!u) return { found: false, reason: 'empty' };
  try {
    const m = await trello('GET', `/members/${encodeURIComponent(u)}`, { fields: 'username,fullName' });
    return { found: true, id: m.id, username: m.username, fullName: m.fullName };
  } catch (e) {
    if (e.status === 404 || e.status === 400) return { found: false, reason: 'not_found' };
    throw e;
  }
}

// ---------- Build the board ----------
// emit(event) receives progress: {type:'step'|'list'|'label'|'member'|'card'|'skip'|'warn'|'error'|'done', ...}
async function buildBoard(trello, plan, opts = {}, emit = () => {}) {
  const { boardId, boardName, workspaceId, listId, checklists = true, dueDates = true } = opts;
  // Where cards go: 'person' = each owner's own "Name: To do" list (with one shared Done list for the team),
  // 'list' = one list already on the board (listId), 'sprint' = a list per sprint.
  const placement = listId ? 'list' : opts.placement === 'sprint' ? 'sprint' : 'person';
  // Only the chosen sprints (default: all of them).
  const sprints = Array.isArray(opts.sprints) && opts.sprints.length ? opts.sprints.map(Number) : plan.sprints.map((s) => s.n);
  const cards = plan.cards.filter((c) => sprints.includes(c.sprint));
  const total = cards.length;
  if (!total) throw new TrelloError('There are no cards in the chosen sprint.', 400);

  const me = await trello('GET', '/members/me', { fields: 'username,fullName' });
  emit({ type: 'step', text: `Signed in as ${me.fullName || me.username} (@${me.username})` });

  let board;
  if (boardId) {
    board = await trello('GET', `/boards/${encodeURIComponent(boardId)}`, { fields: 'name,url' });
    emit({ type: 'step', text: `Adding to the board “${board.name}”`, board });
  } else {
    board = await trello('POST', '/boards/', {
      name: boardName || plan.board || 'DateDeck',
      defaultLists: 'false',
      defaultLabels: 'false',
      idOrganization: workspaceId || undefined,
      desc: 'DateDeck build plan: Vite, React and PocketBase. 3 sprints, 4 people, 2 stories each per sprint.',
    });
    emit({ type: 'step', text: `Created the board “${board.name}”`, board });
  }

  // Lists. Existing lists with the same name (any capitalization) are reused, never changed.
  const existingLists = await trello('GET', `/boards/${board.id}/lists`, { fields: 'name', filter: 'open' });
  const listByName = new Map(existingLists.map((l) => [l.name.trim().toLowerCase(), l]));
  const ensureList = async (name) => {
    const k = name.trim().toLowerCase();
    if (listByName.has(k)) return listByName.get(k);
    const l = await trello('POST', '/lists', { name, idBoard: board.id, pos: 'bottom' });
    listByName.set(k, l);
    emit({ type: 'list', text: `Added list ${name}` });
    return l;
  };
  const todoList = (name) => `${name}: To do`;
  let target = null;
  if (placement === 'person') {
    for (const m of plan.members) await ensureList(todoList(m.name));
    await ensureList(DONE_LIST);
  } else if (placement === 'list') {
    target = existingLists.find((l) => l.id === listId);
    if (!target) throw new TrelloError('That list is no longer on the board. Pick the list again.', 404);
    emit({ type: 'step', text: `Cards go into the list “${target.name}”` });
  } else {
    const wanted = plan.sprints.filter((s) => sprints.includes(s.n)).map((s) => s.list);
    if (!boardId) wanted.push('In progress', 'Review', 'Done');
    for (const name of wanted) await ensureList(name);
  }

  // Labels
  const existingLabels = await trello('GET', `/boards/${board.id}/labels`, { fields: 'name,color', limit: 1000 });
  const labelByName = new Map(existingLabels.filter((l) => l.name).map((l) => [l.name.toLowerCase(), l]));
  for (const l of plan.labels) {
    if (labelByName.has(l.name.toLowerCase())) continue;
    labelByName.set(l.name.toLowerCase(), await trello('POST', '/labels', { name: l.name, color: l.color, idBoard: board.id }));
    emit({ type: 'label', text: `Added label ${l.name}` });
  }

  // Team members: find each username and add them to the board so cards can be assigned.
  // Without a username, a board member whose name or username starts with the person's name is used.
  const memberIds = new Map(); // role -> Trello member id
  const owners = new Set(cards.map((c) => c.owner.role));
  const boardMembers = await trello('GET', `/boards/${board.id}/members`, { fields: 'username,fullName' }).then((r) => (Array.isArray(r) ? r : []), () => []);
  const byName = (name) => {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return [];
    return boardMembers.filter((b) => String(b.fullName || '').trim().toLowerCase().split(/\s+/)[0] === n || String(b.username || '').toLowerCase().startsWith(n));
  };
  for (const m of plan.members.filter((x) => owners.has(x.role))) {
    if (!m.trello) {
      const matches = byName(m.name);
      if (matches.length === 1) {
        memberIds.set(m.role, matches[0].id);
        emit({ type: 'member', text: `${m.name} matched to @${matches[0].username} on the board`, username: matches[0].username });
      } else {
        emit({ type: 'warn', text: matches.length ? `${m.name} matches more than one board member, so their cards won't be assigned. Enter their Trello username.` : `${m.name} has no Trello username and isn't on the board, so their cards won't be assigned` });
      }
      continue;
    }
    const found = await findMember(trello, m.trello);
    if (!found.found) { emit({ type: 'warn', text: `Couldn't find @${m.trello} on Trello, so ${m.name}'s cards won't be assigned` }); continue; }
    if (found.id !== me.id) {
      try { await trello('PUT', `/boards/${board.id}/members/${found.id}`, { type: 'normal' }); }
      catch (e) {
        if (e.status === 401 || e.status === 403) {
          emit({ type: 'warn', text: `Couldn't add @${m.trello} to the board (${e.message}) so their cards won't be assigned` });
          continue;
        }
        // 400 usually means they're already on the board; keep going.
      }
    }
    memberIds.set(m.role, found.id);
    emit({ type: 'member', text: `${m.name} is on the board as @${found.username}`, username: found.username });
  }

  // Cards
  // Includes archived cards, so finished cards that were archived aren't created again.
  const existing = await trello('GET', `/boards/${board.id}/cards/all`, { fields: 'name' });
  const existingNames = new Set(existing.map((c) => c.name));
  let created = 0, skipped = 0, failed = 0, done = 0;
  const createdCards = []; // Trello ids of the cards this run made, so the run can be undone.
  for (const c of cards) {
    done++;
    if (existingNames.has(c.title)) {
      skipped++;
      emit({ type: 'skip', text: `${c.title} is already on the board`, id: c.id, done, total });
      continue;
    }
    const sprint = plan.sprints.find((s) => s.n === c.sprint);
    const list = placement === 'list' ? target
      : placement === 'person' ? listByName.get(todoList(c.owner.name).toLowerCase())
      : listByName.get(String(sprint?.list).toLowerCase());
    const idMember = memberIds.get(c.owner.role);
    try {
      const card = await trello('POST', '/cards', {
        idList: list.id,
        name: c.title,
        desc: describe(c, plan),
        due: dueDates && c.due ? dueAt(c.due) : undefined,
        pos: 'bottom',
        idLabels: c.labels.map((n) => labelByName.get(n.toLowerCase())?.id).filter(Boolean).join(',') || undefined,
        idMembers: idMember,
      });
      createdCards.push({ id: card.id, name: card.name });
      if (checklists && c.criteria?.length) {
        const cl = await trello('POST', '/checklists', { idCard: card.id, name: 'Acceptance criteria' });
        for (const item of c.criteria) await trello('POST', `/checklists/${cl.id}/checkItems`, { name: item, pos: 'bottom' });
      }
      created++;
      emit({ type: 'card', text: c.title, id: c.id, owner: c.owner.name, assigned: !!idMember, url: card.shortUrl || card.url, done, total });
    } catch (e) {
      failed++;
      emit({ type: 'error', text: `${c.title}: ${e.message}`, id: c.id, done, total });
      if (e.status === 401 || e.status === 403) break;
    }
  }

  const result = { created, skipped, failed, total, board: { id: board.id, name: board.name, url: board.url }, createdCards };
  emit({ type: 'done', ...result });
  return result;
}

// ---------- Undo the last run ----------
// The cards made by the most recent run that created any are kept in last-run.json (ids and names only),
// so they, and nothing older, can be deleted later.
const LAST_RUN = process.env.TRELLO_LAST_RUN || path.join(__dirname, 'last-run.json'); // tests point this elsewhere

function saveLastRun(result) {
  if (!result.createdCards?.length) return;
  const record = { at: new Date().toISOString(), board: result.board, cards: result.createdCards };
  fs.writeFileSync(LAST_RUN, JSON.stringify(record, null, 2));
}

function loadLastRun() {
  try {
    const r = JSON.parse(fs.readFileSync(LAST_RUN, 'utf8'));
    return Array.isArray(r.cards) && r.cards.length ? r : null;
  } catch { return null; }
}

async function deleteLastRun(trello, emit = () => {}) {
  const run = loadLastRun();
  if (!run) throw new TrelloError('There is no run to undo.', 404);
  const total = run.cards.length;
  let deleted = 0, gone = 0, failed = 0, done = 0;
  const left = [];
  for (const c of run.cards) {
    done++;
    try {
      await trello('DELETE', `/cards/${encodeURIComponent(c.id)}`);
      deleted++;
      emit({ type: 'deleted', text: c.name, done, total });
    } catch (e) {
      if (e.status === 404) { gone++; emit({ type: 'skip', text: `${c.name} was already deleted`, done, total }); continue; }
      failed++; left.push(c);
      emit({ type: 'error', text: `${c.name}: ${e.message}`, done, total });
      if (e.status === 401 || e.status === 403) { left.push(...run.cards.slice(done)); break; }
    }
  }
  // Keep only the cards that couldn't be deleted, so trying again picks up where this stopped.
  if (left.length) fs.writeFileSync(LAST_RUN, JSON.stringify({ ...run, cards: left }, null, 2));
  else fs.rmSync(LAST_RUN, { force: true });
  const result = { deleted, gone, failed, total, board: run.board };
  emit({ type: 'undone', ...result });
  return result;
}

// ---------- Clean up by story title ----------
// Find (and optionally delete) cards on a board whose names exactly match the plan's story titles
// for the chosen sprints. Works even without last-run.json. Nothing else on the board is touched.
async function findPlanCards(trello, boardId, plan, sprints) {
  const want = new Set(plan.cards.filter((c) => !sprints || sprints.includes(c.sprint)).map((c) => c.title));
  const cards = await trello('GET', `/boards/${encodeURIComponent(boardId)}/cards`, { fields: 'name,idList' });
  return (Array.isArray(cards) ? cards : []).filter((c) => want.has(c.name)).map((c) => ({ id: c.id, name: c.name }));
}
async function removePlanCards(trello, boardId, plan, sprints, emit = () => {}) {
  const found = await findPlanCards(trello, boardId, plan, sprints);
  let removed = 0;
  for (const c of found) {
    try { await trello('DELETE', `/cards/${c.id}`); removed++; emit({ type: 'removed', text: c.name, done: removed, total: found.length }); }
    catch (e) { emit({ type: 'error', text: `${c.name}: ${e.message}` }); if (e.status === 401 || e.status === 403) break; }
  }
  emit({ type: 'done', removed, total: found.length });
  return { removed, total: found.length };
}

module.exports = { DONE_LIST, client, validatePlan, applyTeam, describe, whoAmI, listsOf, findMember, buildBoard, saveLastRun, loadLastRun, deleteLastRun, findPlanCards, removePlanCards, TrelloError };
