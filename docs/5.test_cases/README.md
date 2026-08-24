# Test Cases

> What's covered, module by module, and what deliberately isn't. An inventory rather than a plan: knowing the
> holes is more useful than an unqualified "it's tested".
>
> **419 server tests** across 43 files (integration-level, against a real Postgres schema) and **442 client
> tests** across 64 files. Both run from a single `npm test` at the repository root.

---

| File | Covers |
|---|---|
| [01-module1-accounts.md](01-module1-accounts.md) | accounts, roles, reporting structure, invitations |
| [02-modules-2-to-4.md](02-modules-2-to-4.md) | leave setup and calendar, requests and approval, dashboards and reporting |
| [03-module5-cross-cutting-and-gaps.md](03-module5-cross-cutting-and-gaps.md) | payroll and profile, notifications, `SUPER_ADMIN`, shared UI, and the known gaps |
| [04-manual-e2e-checklist.md](04-manual-e2e-checklist.md) | a manual pass to run by hand, covering what no automated test reaches — cross-role journeys, refusals, and phone width |
