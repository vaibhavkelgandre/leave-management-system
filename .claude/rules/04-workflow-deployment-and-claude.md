# Development workflow, documentation, deployment & Claude rules

> Part of the [project rules](../rules.md). These are binding, not advisory.

---

## Development workflow & documentation

### 🔄 Development Workflow

For each feature, work through these steps **in order**:

1. Requirement
2. Business Rules
3. Edge Cases
4. Database Design
5. API Design
6. Validation
7. Implementation
8. Testing
9. Documentation

#### 🌿 Git

- Small commits.
- One feature per commit.
- Use meaningful commit messages.

---

### 📚 Documentation

Each feature's documentation should cover:

- Functional Requirements
- Business Rules
- Database Design
- API Design
- Validation Rules
- Edge Cases
- Test Cases

> 🚨 **Role capability doc:** [`docs/7.role_permissions_matrix.md`](../../docs/7.role_permissions_matrix.md) is the single source of truth for **who can do what** — a per-role, per-endpoint matrix plus the row-level scope each capability is limited to, the field-level exceptions, the UI surfaces each role reaches, and the file where each rule is enforced. **Whenever a role's access changes, update this doc in the same change** — that includes:
>
> - adding, removing or widening a `requireRole(...)` / `requireUserScope(...)` gate on a route;
> - changing a row-level authorization check inside a service (anything touching `isInActorsHrScope`, `isUserInSubtree`, `findDirectReports`, `isManagerOrDelegateOf`, `invited_by` ownership, or a `forbidden(...)`/`notFound(...)` denial);
> - adding a new endpoint that any role can reach — it needs a matrix row even when the answer is "everyone";
> - changing what a role sees rather than what it may do (masked fields, a company-wide vs scoped list, a new filter);
> - adding or re-gating a client route (`RequireRole`), a nav item, or a role-conditional control (`RoleGate` / `hasAnyRole`).
>
> Use the checklist in §12 of that doc as the definition of done. This is the same standing rule as the API and DB docs below — a permission change that isn't in the matrix is an unfinished change, since the matrix is what anyone (including the client) reads to answer "is HR allowed to do this?" without re-reading five services.

> 🚨 **And don't over-split: merge related files that fall well under ~100 lines.** The ceiling means "nothing
> over 400", not "split as far as possible". The first pass at applying it produced 86 doc files, many of them 20–60
> lines, which was *harder* to navigate than the monoliths it replaced — you cannot hold 86 filenames in your head, and
> a 20-line file never contains the answer on its own. Merged back to ~50, every content file now sits roughly between
> 100 and 360 lines.
>
> The working target: **one file per thing you'd actually go looking for**, sized 150–350 lines. A folder wants roughly
> 3–10 files. If a folder has one content file, it shouldn't be a folder; if it has fifteen, the grouping is too fine.
> When merging, demote the constituent headings by one level so the hierarchy stays valid, and skip fenced code blocks
> so a `#` comment inside one isn't mangled.

> 🚨 **No document may exceed 400 lines.** Past that, split it into a folder named after the document with an index
> `README.md` and one file per concern, each also under 400. A 1,600-line reference is unreviewable in a diff, unreadable
> in one sitting, and impossible to link precisely — and it rots invisibly, because nobody rereads it to notice.
>
> Every doc in `docs/` and these rules themselves are already split this way. Applies to new documents too: if a page
> is heading past 400 lines, split it *then*, not later. Two mechanical rules make the split safe:
>
> - **Copy content verbatim**, so the split is reviewable as a pure move. Rewrite in a separate commit if you want to.
> - **Verify nothing was dropped** — check every heading survives and that no non-blank line of the original is absent
>   from the result. Both splits done so far reported zero lost lines, which is the only reason they were trustworthy.
>
> Fix inbound links in the same change. A relative link from a file that moved one level deeper resolves silently
> wrong, so recompute paths rather than string-patching them, and re-scan for broken targets afterwards.

> 🚨 **Database schema doc:** [`docs/3.db.md`](../../docs/3.db/README.md) documents every table (ER diagram + column-level breakdown) and a "Planned tables" section for what's designed but not built yet. **Whenever a migration is added or changed under `server/src/sql/`, update `docs/3.db.md` in the same change** — this is the same standing rule as keeping `docs/2.api_documentation.md` in sync with endpoint changes.

---

---

## Deployment (Render)

### 🚀 Deployment (Render)

- Frontend (Static Site) and backend (Web Service) are deployed as **separate Render services** on different `*.onrender.com` subdomains. Since `onrender.com` is a public suffix, this makes them **cross-site** to the browser, not just cross-origin.
- The auth cookie is `httpOnly` + `SameSite=None; Secure` (`server/src/utils/cookies.js`) so it can travel cross-site at all — but browsers (especially Incognito) block cross-site/"third-party" cookies by default regardless of `SameSite=None`. Symptom: login succeeds (frontend trusts the response body's user object), but the cookie never actually gets stored, so the very next API call 401s and the user gets bounced back to sign-in.
- **Fix — make requests same-origin from the browser's point of view** so the cookie is never third-party:
  1. Frontend Static Site → **Settings → Redirects/Rewrites**: add rule `/api/*` → `https://<backend>.onrender.com/api/*`, Action **Rewrite**. It must be listed **above** the catch-all `/*` → `/index.html` SPA fallback rule — Render matches top-to-bottom and stops at the first match, so the fallback would otherwise swallow every `/api/*` request first.
  2. Frontend Static Site → **Environment**: set `VITE_API_URL=/api` (relative, not the backend's absolute URL). Vite bakes this in at build time, so changing it requires **Clear build cache & deploy**, not just a rule save.
- No backend code changes are needed for this — `CLIENT_ORIGIN`/CORS and the cookie's existing `SameSite=None; Secure` settings already work fine once requests are same-origin.
- To verify: `fetch('/api/auth/me')` from the deployed frontend's own devtools console should return the backend's JSON (`x-powered-by: Express`), not the SPA's `index.html`. If it returns HTML, the rewrite rule is missing, misordered, or the build wasn't refreshed.

> 🕳️ **Render's Redirects/Rewrites page can fail to persist a save, and the symptom is that every direct URL is a blank page.** Burned most of an afternoon in September 2026. The SPA fallback (`/*` → `/index.html`, Rewrite) sat in the form looking correct while the live site answered an empty `200` for every path except `/` — so password-reset links, `/invite/:token`, every bookmark and every page refresh rendered nothing, while in-app navigation worked perfectly because it never re-requests a URL.
> - **Never verify this by status code.** Every failing case answered `200`. Measure the body: `curl -s https://<frontend>/reset-password/abc | wc -c` should equal the byte count of `curl -s https://<frontend>/ | wc -c`. Zero means broken. An early check here reported "SPA fallback works" off the back of four `200`s and a blank `content_type` that got noticed and not followed up — that mistake delayed the diagnosis by hours.
> - **The decisive tell that the rule is not running at all** (as opposed to having a bad destination): an extensionless path like `/foo` returns `200` with zero bytes while `/foo.txt` returns `404`. A live `/*` rewrite matches **both**, so two different answers prove no rule ran — that's Render's default static behaviour showing through.
> - **To isolate "rule not applied" from "destination wrong", repoint the rule at a known file** (`/*` → `/favicon.svg`) and see whether deep routes return that file's bytes. Cheaper than guessing at fields.
> - **The cause was the dashboard not saving.** Hard-reload (Ctrl+F5) after Save and re-read the values: reading your own unsaved input back is indistinguishable from a successful save, which is exactly how this survived four rounds of "fixed it, check again". Prove saves land at all by deleting a rule you know is live (`/api/*`) and confirming the API breaks. Retype fields rather than pasting — a trailing space in a `/*` source matches nothing and the UI cannot show it to you.
> - **A `render.yaml` Blueprint is the durable answer** if it recurs: the routes live in the repo, appear in a diff, and cannot silently fail to save.
> - **Cloudflare sits in front, so cache-bust properly when testing.** A fresh query string is *not* enough — `cf-cache-status: HIT` came back on brand-new query strings, so query strings aren't part of the cache key. Use a genuinely novel path plus `-H "Cache-Control: no-cache"`.
> - **Related client-side gap, still open:** `App.jsx`'s catch-all `path="*"` → `NotFoundPage` is nested **inside** `/dashboard`, so `/dashboard/typo` renders a proper 404 page but a top-level unknown URL matches no route and renders blank. Now that the fallback serves `index.html` for every path, that blank page is reachable by any typo.

---

---

## Claude rules

### 🤖 Claude Rules

1. Analyze requirements first.
2. List business rules.
3. List edge cases.
4. Design database changes.
5. **Wait for approval.**
6. Generate code only after approval.
7. **After solving any non-trivial bug or issue** (not just typos), add a short entry to the relevant section of this file — root cause + fix — before considering the task done. The goal is to never re-diagnose the same issue from scratch.
8. **Never drive the app in a real browser to verify a fix or feature** — no Browser-tool automation (navigating, clicking, screenshots, reading network/console) against the dev server, and no spinning up throwaway test accounts/data in the shared dev DB to click through a flow. It's slow, burns tokens, and this DB is shared with the user's own live testing — automated clicks and cleanup queries collide with whatever they're doing right now. This applies just as much to verifying a bug fix as it does to a new feature.

> 🚨 **Most important:** after implementing code, do **not** test it in the browser by running commands. Instead: run whatever's fast and non-interactive (lint, unit/integration tests, a `curl`/script hitting an API endpoint directly if that helps confirm backend logic), then tell the user exactly how to test it themselves — which page, which button, what data to use, what result to expect. Let them click through it in their own already-open browser.
