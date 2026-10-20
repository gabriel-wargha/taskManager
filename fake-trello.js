// An in-memory stand-in for the Trello REST API, covering only the calls trello-core.js makes.
// Used by the tests and by `npm run demo`, so the app can be tried without a Trello account.
// Point the app at it with TRELLO_API_BASE=<fake.url>.

'use strict';

const http = require('http');

function createFakeTrello({ key = 'test-key', token = 'test-token', me = { username: 'me', fullName: 'Me' } } = {}) {
  let seq = 0;
  const newId = () => (++seq).toString(16).padStart(24, '0'); // Trello ids are 24 hex characters
  const state = { users: [], orgs: [], boards: [], lists: [], labels: [], cards: [], checklists: [] };
  const calls = []; // every request: {method, path, params}
  const failures = []; // queued failures: {method, path: RegExp, status, body, times}

  function addUser({ username, fullName = username }) {
    const u = { id: newId(), username, fullName };
    state.users.push(u);
    return u;
  }
  const self = addUser(me);

  // Seed a board: addBoard({ name, members: ['username'], lists: ['name'], cards: [{ name, list, closed }] })
  function addBoard({ name, members = [], lists = [], cards = [] }) {
    const board = { id: newId(), name, desc: '', url: '', members: [self.id] };
    board.url = `https://trello.example/b/${board.id}`;
    for (const u of members) {
      const user = state.users.find((x) => x.username === u) || addUser({ username: u });
      if (!board.members.includes(user.id)) board.members.push(user.id);
    }
    state.boards.push(board);
    for (const l of lists) addList(board.id, l);
    for (const c of cards) {
      const list = state.lists.find((l) => l.idBoard === board.id && l.name === c.list) || addList(board.id, c.list || 'Seeded');
      state.cards.push({ id: newId(), idBoard: board.id, idList: list.id, name: c.name, closed: !!c.closed, idMembers: [], idLabels: [] });
    }
    return board;
  }
  function addList(idBoard, name) {
    const l = { id: newId(), idBoard, name, closed: false };
    state.lists.push(l);
    return l;
  }

  // Make the next `times` requests matching method and path fail with `status`.
  function fail({ method, path, status, body = 'fake failure', times = 1 }) {
    failures.push({ method, path, status, body, times });
  }

  const pick = (obj, fields) => {
    if (!fields) return obj;
    const out = { id: obj.id };
    for (const f of String(fields).split(',')) if (f in obj) out[f] = obj[f];
    return out;
  };
  const cardJson = (c) => ({ ...c, url: `https://trello.example/c/${c.id}`, shortUrl: `https://trello.example/c/${c.id.slice(-8)}` });

  // Routes, matched in order. Each handler gets (params, ...path captures) and returns [status, body].
  const routes = [
    ['GET', /^\/members\/me$/, (q) => [200, pick(self, q.fields)]],
    ['GET', /^\/members\/me\/boards$/, (q) => [200, state.boards.filter((b) => b.members.includes(self.id)).map((b) => pick(b, q.fields))]],
    ['GET', /^\/members\/me\/organizations$/, () => [200, state.orgs]],
    ['GET', /^\/members\/([^/]+)$/, (q, name) => {
      const u = state.users.find((x) => x.username === name || x.id === name);
      return u ? [200, pick(u, q.fields)] : [404, 'model not found'];
    }],
    ['POST', /^\/boards\/?$/, (q) => {
      const board = addBoard({ name: q.name });
      board.desc = q.desc || '';
      if (q.defaultLists !== 'false') for (const n of ['To Do', 'Doing', 'Done']) addList(board.id, n);
      return [200, board];
    }],
    ['GET', /^\/boards\/([^/]+)$/, (q, id, board) => [200, pick(board, q.fields)]],
    ['GET', /^\/boards\/([^/]+)\/lists$/, (q, id) => [200, state.lists.filter((l) => l.idBoard === id && !l.closed).map((l) => pick(l, q.fields))]],
    ['GET', /^\/boards\/([^/]+)\/labels$/, (q, id) => [200, state.labels.filter((l) => l.idBoard === id)]],
    ['GET', /^\/boards\/([^/]+)\/members$/, (q, id, board) => [200, board.members.map((m) => pick(state.users.find((u) => u.id === m), q.fields))]],
    ['PUT', /^\/boards\/([^/]+)\/members\/([^/]+)$/, (q, id, board, idMember) => {
      if (!state.users.some((u) => u.id === idMember)) return [400, 'invalid value for idMember'];
      if (!board.members.includes(idMember)) board.members.push(idMember);
      return [200, board];
    }],
    ['GET', /^\/boards\/([^/]+)\/cards$/, (q, id) => [200, state.cards.filter((c) => c.idBoard === id && !c.closed).map((c) => pick(c, q.fields))]],
    ['GET', /^\/boards\/([^/]+)\/cards\/all$/, (q, id) => [200, state.cards.filter((c) => c.idBoard === id).map((c) => pick(c, q.fields))]],
    ['POST', /^\/lists$/, (q) => {
      if (!state.boards.some((b) => b.id === q.idBoard)) return [400, 'invalid value for idBoard'];
      return [200, addList(q.idBoard, q.name)];
    }],
    ['POST', /^\/labels$/, (q) => {
      const l = { id: newId(), idBoard: q.idBoard, name: q.name, color: q.color };
      state.labels.push(l);
      return [200, l];
    }],
    ['POST', /^\/cards$/, (q) => {
      const list = state.lists.find((l) => l.id === q.idList);
      if (!list) return [400, 'invalid value for idList'];
      const c = {
        id: newId(), idBoard: list.idBoard, idList: list.id, name: q.name, desc: q.desc || '', due: q.due || null, closed: false,
        idLabels: q.idLabels ? q.idLabels.split(',') : [], idMembers: q.idMembers ? q.idMembers.split(',') : [],
      };
      state.cards.push(c);
      return [200, cardJson(c)];
    }],
    ['DELETE', /^\/cards\/([^/]+)$/, (q, id) => {
      const i = state.cards.findIndex((c) => c.id === id);
      if (i < 0) return [404, 'The requested resource was not found.'];
      state.cards.splice(i, 1);
      return [200, { limits: {} }];
    }],
    ['POST', /^\/checklists$/, (q) => {
      if (!state.cards.some((c) => c.id === q.idCard)) return [400, 'invalid value for idCard'];
      const cl = { id: newId(), idCard: q.idCard, name: q.name, checkItems: [] };
      state.checklists.push(cl);
      return [200, cl];
    }],
    ['POST', /^\/checklists\/([^/]+)\/checkItems$/, (q, id) => {
      const cl = state.checklists.find((x) => x.id === id);
      if (!cl) return [404, 'not found'];
      const item = { id: newId(), name: q.name, state: 'incomplete' };
      cl.checkItems.push(item);
      return [200, item];
    }],
  ];

  function handle(req) {
    const url = new URL(req.url, 'http://fake');
    const path = url.pathname.replace(/^\/1/, '');
    const params = Object.fromEntries(url.searchParams);
    calls.push({ method: req.method, path, params });

    const auth = req.headers.authorization || '';
    if (!auth.includes(`oauth_consumer_key="${key}"`) || !auth.includes(`oauth_token="${token}"`)) return [401, 'invalid key'];

    const f = failures.find((x) => x.times > 0 && x.method === req.method && x.path.test(path));
    if (f) { f.times--; return [f.status, f.body]; }

    for (const [method, re, handler] of routes) {
      const m = method === req.method && path.match(re);
      if (!m) continue;
      const [, id, ...rest] = m;
      // Routes under /boards/:id get the board too, and 404 when it doesn't exist.
      if (path.startsWith('/boards/') && id) {
        const board = state.boards.find((b) => b.id === id);
        if (!board) return [404, 'board not found'];
        return handler(params, id, board, ...rest);
      }
      return handler(params, id, ...rest);
    }
    return [404, `fake Trello has no route for ${req.method} ${path}`];
  }

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const [status, body] = handle(req);
      const json = typeof body !== 'string';
      res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/plain' });
      res.end(json ? JSON.stringify(body) : body);
    });
  });

  const fake = {
    state, calls, me: self, addUser, addBoard, fail, server, url: null,
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
        fake.url = `http://127.0.0.1:${server.address().port}/1`;
        resolve(fake);
      }));
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
  return fake;
}

module.exports = { createFakeTrello };
