# taskManager

Creates the DateDeck build plan in Trello, one sprint at a time. Each sprint is two weeks; every week each person has one story and one branch (for example `rychen/dd-01`), and no story depends on another story from the same week. DateDeck is built with Vite, React and PocketBase: sprints 1 and 2 build the core app, sprint 3 adds accounts and AI. Each teammate (Gabriel, Riley, Rychen and Talmage) gets a **To do** list and the team shares one **Done - Team** list. Each story goes into its owner's To do list, assigned to them, with an acceptance criteria checklist and a due date.

Needs Node 18 or newer (https://nodejs.org). No `npm install` needed.

## Use it

1. Open a terminal in this folder and run:

   ```bash
   npm start
   ```

   Your browser opens http://localhost:4321. If it doesn't, open that address yourself.

2. **Connect to Trello.** Put your API key and token in the `.env` file in this folder (`TRELLO_KEY=...` and `TRELLO_TOKEN=...`) and restart the app; it connects on its own. To get them, go to https://trello.com/power-ups/admin, create an integration (any name), generate an API key, then follow the Token link on the same page.
3. **Your team.** Enter each person's name and Trello username (the part after trello.com/u/ in their profile link). The page checks each username.
4. **Sprint and board.** Pick the sprint (the current one is selected for you).
   - **Sprint 1:** choose *Create a new board*. It makes the board (or use your existing board) and the lists (*Gabriel: To do* and so on for each person, plus *Done - Team*) and adds the 8 sprint 1 cards.
   - **Sprint 2 and 3:** the app picks your existing DateDeck board and drops the new cards into the To do lists that are already there. No new lists are created.
   - You can also put every card into one list that's already on the board, or into a list for the sprint.
5. **Create the cards.** Watch them appear, then open the board.
6. **Undo, if needed.** The page offers to delete the cards the last run created. Only those cards are deleted, never ones from earlier runs. (Command line: `--undo`.)

## What it never does

- It never edits, moves, archives or deletes anything already on the board. The one exception is undo, which deletes only the cards the last run created (their ids are kept in `last-run.json`). It only adds cards, plus the lists and labels it needs if they're missing (lists with the same name are reused).
- It never adds a card that's already on the board, archived ones included, so running it twice is safe.
- The only other change: your teammates are added as board members so their cards can be assigned to them.

When you finish a card, move it to *Done - Team* in Trello. Cards are assigned by Trello username; if a username is left blank, the card goes to the board member whose name matches. Trello shows you as the creator of every card, because cards are created with your key; each card is assigned to its owner.

## Your key and token

They live in `.env` in this folder (readable only by you), are sent from this computer straight to api.trello.com, and never reach the browser page. The app only listens on your own machine (127.0.0.1) and only accepts requests from its own page. Treat the token like a password; you can revoke it any time from your Trello account settings.

## Plan file

`datedeck-trello.json` is the plan. To use your team's edits from the shared sprint plan page, press **Download for Trello script** there and either put the file in this folder (replacing this one) or choose it with **Use a different plan file** in the app.

`sprint-plan.html` is an offline copy of the plan page. Opened from disk, its edits last until you reload.

## Files

| File | What it is |
| --- | --- |
| `trello-app.js` | The app: a small local server (`npm start`) |
| `trello-app.html` | The page you use in the browser |
| `trello-core.js` | Talks to the Trello API and builds the board |
| `create-trello-board.js` | Command-line version: `TRELLO_KEY=... TRELLO_TOKEN=... node create-trello-board.js datedeck-trello.json --sprint 2 --board-id <id>` (add `--dry-run` to preview) |
| `datedeck-trello.json` | The 24 stories across 3 sprints |
| `sprint-plan.html` | Offline copy of the sprint plan page |

Use `TRELLO_APP_PORT=4322 npm start` if port 4321 is busy.
