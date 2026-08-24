# Running & testing

> Part of [Commands](README.md). The day-to-day commands.

---

## Dev servers

Two processes, one per half, in separate terminals. Both watch and reload.

```powershell
cd server; npm run dev
```

```powershell
cd client; npm run dev
```

| | URL | Notes |
|---|---|---|
| Frontend | `http://localhost:5173` | Vite dev server |
| API | `http://localhost:5001/api` | port from `PORT` in `server/.env` |

The backend also starts one background job at boot — an hourly sweep that fires delegation start/end notifications. It
is the only scheduler in the app, and it runs once immediately on startup, so a fresh `npm run dev` may emit
notifications for delegations that began today.

To run the backend the way production does, without the watcher:

```powershell
cd server; npm start
```

---

## Tests

**One command runs everything**, from the repository root. This is the documented single entry point:

```powershell
npm test
```

Either half alone:

```powershell
npm run test:server
```

```powershell
npm run test:client
```

> The `&&` between the two halves in the root script is load-bearing. They compete for one machine, and running them
> concurrently has produced timeouts that look exactly like real failures — including six client files that silently
> never ran. Don't start them in two terminals.

### A single file, or a single test

From `server/` or `client/`, pass the path through to vitest:

```powershell
npx vitest run src/tests/integration/leaveRequests.test.js
```

Narrow to one test by name:

```powershell
npx vitest run src/tests/integration/leaveRequests.test.js -t "rejects an overlapping request"
```

Watch mode, for a tight loop on one file:

```powershell
npx vitest src/tests/integration/leaveRequests.test.js
```

### What to expect

Server tests are integration-level against the real `_test` database and truncate its tables before every test, so
they are not fast — the full suite is several minutes. The current counts are in
[`docs/5.test_cases/README.md`](../5.test_cases/README.md).

If the server suite refuses to start, it is the test-database guard, and the message says which condition failed. It
requires `NODE_ENV=test`, a `DB_NAME` ending in `_test`, **and** any `DATABASE_URL` present to also name a `_test`
database. That third condition exists because a connection string left in your shell from a migration run would
otherwise silently redirect the truncation at whatever it names.

---

## Lint

```powershell
cd client; npm run lint
```

Or a specific file:

```powershell
cd client; npx eslint src/pages/HolidaysPage.jsx
```

The server has no lint script — its conventions are enforced by review and by the rules in `.claude/rules/`.

---

## Production build

Builds the frontend into `client/dist`:

```powershell
cd client; npm run build
```

Serve that build locally to check it before deploying:

```powershell
cd client; npm run preview
```

> `VITE_*` variables are baked in **at build time**, not read at runtime. Changing one means rebuilding — on Render,
> that means *Clear build cache & deploy*, not just saving the variable.
