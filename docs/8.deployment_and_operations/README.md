# Deployment & Operations

> How this runs in production, what it needs to be given, and what to check when it misbehaves — learned mostly
> from things going wrong.
>
> Local development is [`server/README.md`](../../server/README.md) and
> [`client/README.md`](../../client/README.md).

---

| File | Covers |
|---|---|
| [01-services-and-environment.md](01-services-and-environment.md) | the two Render services, how the frontend reaches the API, hibernation, and every environment variable |
| [02-database-and-migrations.md](02-database-and-migrations.md) | the per-environment migration procedure, baselining, and the constraint-replay trap |
| [03-troubleshooting.md](03-troubleshooting.md) | symptom → cause, for every failure this deployment has actually produced |

## The four things that have actually broken

1. **Split-deploy skew.** The two services deploy independently, so the frontend can run a build ahead of the
   backend. Symptom: `404`/`422` on endpoints that exist in the repo. **Deploy the backend first.**
2. **SMTP is blocked outbound.** 587 and 465 both time out. Mail goes over HTTPS to Brevo, and no SMTP
   configuration — nor a hand-written SMTP client — will change that.
3. **Migrations don't run themselves.** Deliberately — a deploy never touches the schema.
4. **The static site's `/*` rewrite silently stopped being saved.** The dashboard displayed the correct rule while
   the live site answered an empty `200` for every path except `/`, so every emailed link opened a blank page.
   **Hard-reload that settings page after saving and re-read the values** — reading your own unsaved input back is
   indistinguishable from a successful save.

## The rule that matters most

**Saving an environment variable does nothing until the service restarts.** Render usually redeploys on save —
confirm that it did. A set-but-not-live variable is the most misleading state available, because the dashboard
shows it as correct.
