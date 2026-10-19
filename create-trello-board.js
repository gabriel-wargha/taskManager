#!/usr/bin/env node
// Command-line version of the Trello card creator. For a point-and-click version, run:
//   node tools/trello-app.js
//
//   TRELLO_KEY=... TRELLO_TOKEN=... node tools/create-trello-board.js datedeck-trello.json
//
// Options
//   --board-id <id>   add the cards to an existing board instead of creating a new one
//   --name <name>     name for the new board (default: the name in the plan file)
//   --workspace <id>  create the board inside this Trello workspace
//   --sprint <n>      only create the cards for sprint n (1, 2 or 3); default is all sprints
//   --list-id <id>    put every card into this existing list (needs --board-id)
//   --by-sprint       put cards in a list per sprint instead of each person's "Name: To do" list
//   --no-checklists   skip the "Acceptance criteria" checklist on each card
//   --dry-run         show what would be created without calling Trello
//   --undo            delete the cards made by the last run (and nothing older)

'use strict';

const fs = require('fs');
const { client, validatePlan, buildBoard, saveLastRun, deleteLastRun } = require('./trello-core');

const HELP = `
Create the DateDeck board in Trello.

  TRELLO_KEY=your-key TRELLO_TOKEN=your-token node tools/create-trello-board.js datedeck-trello.json

Prefer clicking to typing? Run  node tools/trello-app.js  and use the page it opens.

Options:
  --board-id <id>   add cards to an existing board (the id is in the board URL: trello.com/b/<id>/...)
  --name <name>     name for the new board
  --workspace <id>  create the board inside a specific workspace
  --sprint <n>      only create sprint n's cards (1, 2 or 3)
  --list-id <id>    put the cards into this existing list (with --board-id)
  --by-sprint       a list per sprint instead of each person's To do list and the shared Done list
  --no-checklists   don't add acceptance criteria as checklists
  --dry-run         print what would be created, without calling Trello
  --undo            delete the cards the last run created (older cards are left alone)
`;

function fail(msg) { console.error(`\n${msg}\n`); process.exit(1); }

function parseArgs(argv) {
  const o = { file: null, boardId: null, name: null, workspace: null, sprint: null, listId: null, checklists: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--board-id') o.boardId = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--workspace') o.workspace = argv[++i];
    else if (a === '--sprint') o.sprint = Number(argv[++i]);
    else if (a === '--list-id') o.listId = argv[++i];
    else if (a === '--by-sprint') o.bySprint = true;
    else if (a === '--no-checklists') o.checklists = false;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--undo') o.undo = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!a.startsWith('--') && !o.file) o.file = a;
    else fail(`Unknown option: ${a}`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return console.log(HELP);
  if (o.undo) {
    const key = process.env.TRELLO_KEY, token = process.env.TRELLO_TOKEN;
    if (!key || !token) fail('Set TRELLO_KEY and TRELLO_TOKEN first.');
    const r = await deleteLastRun(client({ key, token }), (e) => {
      if (e.type === 'deleted') console.log(`  - ${e.text}`);
      else if (e.type === 'skip' || e.type === 'error') console.log(`  ! ${e.text}`);
    });
    console.log(`\nDone. ${r.deleted} cards deleted${r.gone ? `, ${r.gone} already gone` : ''}${r.failed ? `, ${r.failed} failed (run --undo again)` : ''}.`);
    if (r.failed) process.exitCode = 1;
    return;
  }
  if (!o.file) fail('Give the plan file, for example: node tools/create-trello-board.js datedeck-trello.json\nRun with --help for details.');
  if (!fs.existsSync(o.file)) fail(`Can't find ${o.file}. Download it from the sprint plan page with "Download for Trello script".`);
  let plan;
  try { plan = validatePlan(JSON.parse(fs.readFileSync(o.file, 'utf8'))); } catch (e) { fail(e.message); }

  if (o.sprint != null && !plan.sprints.some((s) => s.n === o.sprint)) fail(`There is no sprint ${o.sprint} in the plan. Use ${plan.sprints.map((s) => s.n).join(', ')}.`);
  if (o.listId && !o.boardId) fail('--list-id needs --board-id too.');
  if (o.sprint != null) plan = { ...plan, cards: plan.cards.filter((c) => c.sprint === o.sprint), sprints: plan.sprints.filter((s) => s.n === o.sprint) };

  if (o.dryRun) {
    console.log('\nDry run. Nothing is sent to Trello.\n');
    console.log(o.boardId ? `Board: existing board ${o.boardId}` : `Board: create "${o.name || plan.board}"`);
    console.log(o.listId ? `Cards go into list ${o.listId}` : o.bySprint ? `Lists: ${plan.sprints.map((s) => s.list).join(' | ')}` : `Lists: ${plan.members.map((m) => `${m.name}: To do`).join(' | ')} | Done - Team`);
    for (const m of plan.members) {
      const n = plan.cards.filter((c) => c.owner.role === m.role).length;
      console.log(`${m.name} (${m.role}): ${n} cards, ${m.trello ? 'assigned to @' + m.trello : 'no Trello username, not assigned'}`);
    }
    for (const s of plan.sprints) {
      console.log(`\n${s.list} (due ${s.end})`);
      for (const c of plan.cards.filter((x) => x.sprint === s.n)) console.log(`  ${c.title}  [${c.labels.join(', ')}] ${c.owner.name}`);
    }
    return console.log(`\n${plan.cards.length} cards. Run without --dry-run to create them.\n`);
  }

  const key = process.env.TRELLO_KEY, token = process.env.TRELLO_TOKEN;
  if (!key || !token) fail('Set TRELLO_KEY and TRELLO_TOKEN first, or run  node tools/trello-app.js  to enter them in a page.');

  const icons = { step: '', list: '  +', label: '  +', member: '  +', card: '  +', skip: '  =', warn: '  !', error: '  !' };
  const result = await buildBoard(client({ key, token }), plan, {
    boardId: o.boardId, boardName: o.name, workspaceId: o.workspace, checklists: o.checklists, listId: o.listId || undefined, placement: o.bySprint ? 'sprint' : 'person',
  }, (e) => {
    if (e.type === 'done') return;
    const extra = e.type === 'card' ? `  (${e.owner}${e.assigned ? '' : ', not assigned'})` : '';
    console.log(e.type === 'step' ? e.text : `${icons[e.type] || ' '} ${e.text}${extra}`);
  });
  saveLastRun(result);
  console.log(`\nDone. ${result.created} cards created${result.skipped ? `, ${result.skipped} already there` : ''}${result.failed ? `, ${result.failed} failed` : ''}.`);
  if (result.board.url) console.log(`Open the board: ${result.board.url}`);
  if (!o.boardId) console.log(`To add more cards to this board later, use --board-id ${result.board.id}`);
  if (result.failed) process.exitCode = 1;
}

main().catch((e) => fail(e.message));
