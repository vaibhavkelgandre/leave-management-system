# Tables — accounts, auth & leave setup

> Part of [Database Schema](README.md). If this disagrees with the code, the code wins.

---

# Tables

> Part of [Database Schema](README.md). If this disagrees with the code, the code wins.

---

## 📋 Tables

### 🏷️ `roles`
*Migration: `002_create_roles.sql` + seed `003_seed_roles.sql`; `SUPER_ADMIN` added by `034_seed_super_admin_role.sql`*

The four fixed roles the whole authorization system hinges on (`requireRole` middleware). Seeded once, never expected to change at runtime. `SUPER_ADMIN` is a singleton — exactly one ever exists, created via the repurposed `POST /auth/register/hr` bootstrap route (see `authService.registerHrRoot`'s guard) — sitting above every `HR_ADMIN` to fix a gap the original three-role model had no answer for: a manager-less root `HR_ADMIN`'s own leave requests could never be approved by anyone, and nobody was positioned to verify their profile. `HR_ADMIN` can now optionally report to `SUPER_ADMIN` (`reportingService.ALLOWED_MANAGER_ROLES`), never `EMPLOYEE`/`MANAGER`.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PK, `gen_random_uuid()` | |
| `role_name` | `VARCHAR(30)` | `NOT NULL`, `UNIQUE` | One of `SUPER_ADMIN`, `HR_ADMIN`, `MANAGER`, `EMPLOYEE` |
| `description` | `TEXT` | | Human-readable label |
| `created_at` | `TIMESTAMP` | default now | |

---

### 👤 `users`
*Migrations: `004_create_users.sql`, `005_alter_users_for_auth.sql`, `020_alter_users_add_profile_fields.sql`, `022_alter_users_profile_v2.sql`, `038_unique_super_admin_user.sql`*

Every person in the system — HR admins, managers, and employees are all rows here, distinguished only by `role_id`. Managers are modeled as a self-referencing tree via `manager_id` (see `reportingService.js` for the cycle-prevention logic). `022` replaced `020`'s initial 10-column profile sketch (`address`, single emergency contact) with the fuller set below, matched to a real onboarding spreadsheet.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `first_name` / `last_name` | `VARCHAR(50)` | `NOT NULL` | |
| `email` | `VARCHAR(255)` | `NOT NULL`, unique (case-insensitive via `uq_users_email_lower`) | Login identifier |
| `password_hash` | `TEXT` | nullable | bcrypt hash; `NULL` for an invited user who hasn't set a password yet |
| `role_id` | `UUID` | FK → `roles.id` | |
| `manager_id` | `UUID` | FK → `users.id` (`ON DELETE SET NULL`), `chk_manager_not_self` | 🌳 `NULL` only for `SUPER_ADMIN`, the true top of the tree |
| `department_id` | `UUID` | — | ⚠️ **Unused today** — column exists but no `departments` table or write path exists yet; always `NULL`. Not the same as the self-editable `department` text column below |
| `status` | `VARCHAR(20)` | `CHECK IN ('ACTIVE','INVITED','INACTIVE')`, default `ACTIVE` | Account activation status — distinct from `profile_status` below |
| `last_login_at` | `TIMESTAMP` | nullable | Set on every successful login |
| `employee_code` | `VARCHAR(50)` | unique (partial, where not null) | HR-assigned, informational only — never used as a lookup/match key anywhere |
| `designation` / `department` | `VARCHAR(100)` | nullable | Self-editable |
| `phone` | `VARCHAR(20)` | nullable | Self-editable |
| `date_of_birth` | `DATE` | nullable | Self-editable |
| `highest_education` | `VARCHAR(150)` | nullable | Self-editable |
| `passport_number` | `VARCHAR(20)` | nullable | Self-editable; masked (`null`) for a manager viewing this row — full value only to HR and the employee themself (`userService.maskSensitiveProfileFields`) |
| `passport_expiry_date` / `joining_date` / `last_working_day` | `DATE` | nullable | Self-editable |
| `blood_group` | `VARCHAR(5)` | nullable | Self-editable |
| `marital_status` | `VARCHAR(20)` | `CHECK IN ('SINGLE','MARRIED','OTHER')`, nullable | Self-editable |
| `current_address` / `permanent_address` | `TEXT` | nullable | Self-editable |
| `nearest_airport` | `VARCHAR(100)` | nullable | Self-editable |
| `health_problem` | `TEXT` | nullable | Self-editable; blank means none |
| `health_insurance_status` | `VARCHAR(50)` | nullable | Self-editable |
| `emergency_contact_1_phone` / `emergency_contact_1_relationship` | `VARCHAR(20)` / `VARCHAR(50)` | nullable | Self-editable — phone + relationship only, no separate name field (matches the source spreadsheet) |
| `emergency_contact_2_phone` / `emergency_contact_2_relationship` | `VARCHAR(20)` / `VARCHAR(50)` | nullable | Self-editable, same shape as contact 1 |
| `pan_number` | `VARCHAR(10)` | nullable | Self-editable; masked, same rule as `passport_number` |
| `aadhar_number` | `VARCHAR(12)` | nullable | Self-editable; masked, same rule |
| `bank_account_number` / `bank_ifsc_code` / `bank_name` | `VARCHAR(34)` / `VARCHAR(11)` / `VARCHAR(100)` | nullable | Self-editable; masked, same rule |
| `profile_status` | `VARCHAR(20)` | `CHECK IN ('INCOMPLETE','SUBMITTED','VERIFIED')`, default `INCOMPLETE` | Onboarding/verification workflow (FR-027) — `profileVerificationStateMachine.js` |
| `profile_verified_by` | `UUID` | FK → `users.id`, nullable | The HR admin who verified this profile |
| `profile_verified_at` | `TIMESTAMP` | nullable | |
| `profile_send_back_reason` | `TEXT` | nullable | Why HR sent a `SUBMITTED` profile back to `INCOMPLETE` — required at the API layer (`sendProfileBackSchema`), shown to the employee on their Profile page while it's the reason their profile is `INCOMPLETE`; cleared (set back to `NULL`) once they resubmit |
| `profile_send_back_by` | `UUID` | FK → `users.id`, nullable | The HR admin who sent it back |
| `profile_send_back_at` | `TIMESTAMP` | nullable | |
| `created_at` / `updated_at` | `TIMESTAMP` | default now | |

**Indexes:** unique on `lower(email)`, plain index on `manager_id` (reporting-tree lookups), partial unique on `employee_code` (where not null), and partial unique `uq_users_single_super_admin` on `role_id` **where `role_id` is the `SUPER_ADMIN` role** — at most one super admin can ever exist.

> ℹ️ **`uq_users_single_super_admin` is the only index in this schema whose definition differs per database, and that's unavoidable.** An index predicate must be immutable, so it can't contain `role_id = (SELECT id FROM roles WHERE role_name = 'SUPER_ADMIN')`; `038` resolves that id at migration time and interpolates it as a literal inside a `DO` block. Expect a different UUID in the predicate in dev, `_test` and production. It also means the index guards nothing if the `SUPER_ADMIN` role row is ever deleted and recreated with a fresh id — and that `038` will fail outright on a database that already holds two super admins (e.g. a bootstrapped one plus one promoted by hand), which is the right failure: demote one first.

> ℹ️ No format `CHECK` constraints on the self-editable fields above beyond `marital_status`/`profile_status` (PAN pattern, Aadhar digit count, date formats, etc.) — those live in `profileValidator.js`'s zod schema instead, so they stay cheap to change without a migration. No encryption-at-rest for `pan_number`/`aadhar_number`/`passport_number`/`bank_*` — masking is application-layer only (see `docs/2.api_documentation.md`'s `GET /api/users` note).

---

### ✉️ `invitations`
*Migration: `006_create_invitations.sql`*

One row per invite sent to a new employee (see FR-001). The token itself is never stored in plain text — only its hash.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `user_id` | `UUID` | FK → `users.id`, `ON DELETE CASCADE` | The account this invite activates |
| `token_hash` | `TEXT` | `NOT NULL`, `UNIQUE` | Hash of the token embedded in the invite link |
| `invited_by` | `UUID` | FK → `users.id` | The HR admin who sent it |
| `expires_at` | `TIMESTAMP` | `NOT NULL` | Invites expire after `INVITE_TOKEN_TTL_HOURS` (default 24h) |
| `accepted_at` | `TIMESTAMP` | nullable | `NULL` while still pending |
| `created_at` / `updated_at` | `TIMESTAMP` | default now | |

**Index:** partial unique index `uq_invitations_active_user` on `user_id` **where `accepted_at IS NULL`** — guarantees at most one *pending* invite per user without blocking re-inviting after expiry/acceptance.

---

### 🔗 `oauth_accounts`
*Migration: `007_create_oauth_accounts.sql`*

Links a `users` row to an external identity provider (FR-003 social login). One user can have at most one linked account per provider.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `user_id` | `UUID` | FK → `users.id`, `ON DELETE CASCADE` | |
| `provider` | `VARCHAR(20)` | `CHECK IN ('GOOGLE')` | More providers = extend the check constraint |
| `provider_user_id` | `VARCHAR(255)` | `NOT NULL` | The provider's own subject/user id |
| `provider_email` | `VARCHAR(255)` | `NOT NULL` | Email as reported by the provider at link time |
| `linked_at` | `TIMESTAMP` | default now | |
| `created_at` / `updated_at` | `TIMESTAMP` | default now | |

**Uniqueness:** `(provider, provider_user_id)` — one provider identity can't link to two accounts; `(user_id, provider)` — one account can't link the same provider twice.

---

### 🔑 `password_resets`
*Migration: `008_create_password_resets.sql`*

Same shape as `invitations`, for the "forgot password" flow — a hashed, expiring, single-use token.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `user_id` | `UUID` | FK → `users.id`, `ON DELETE CASCADE` | |
| `token_hash` | `TEXT` | `NOT NULL`, `UNIQUE` | |
| `expires_at` | `TIMESTAMP` | `NOT NULL` | |
| `used_at` | `TIMESTAMP` | nullable | `NULL` while still usable |
| `created_at` / `updated_at` | `TIMESTAMP` | default now | |

**Index:** partial unique index `uq_password_resets_active_user` on `user_id` **where `used_at IS NULL`** — at most one live reset request per user.

---

### 🌴 `leave_types`
*Migrations: `009_create_leave_types.sql`, `025_alter_leave_types_add_counts_as_lop.sql`*

HR-managed catalog of leave categories (Annual, Sick, Casual, …) — see FR-007.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `name` | `VARCHAR(100)` | `NOT NULL`, unique (case-insensitive via `uq_leave_types_name_lower`) | |
| `annual_entitlement` | `NUMERIC(5,1)` | `NOT NULL`, `CHECK >= 0` | Must be a multiple of 0.5 (validated in `leaveTypeValidator.js`, not the DB) — supports half-day entitlements |
| `accrual_type` | `VARCHAR(20)` | `CHECK IN ('UPFRONT','MONTHLY')` | `MONTHLY` is metadata only today — no accrual scheduler runs yet |
| `allow_negative_balance` | `BOOLEAN` | default `false` | |
| `requires_document` | `BOOLEAN` | default `false` | Supporting-document requirement, enforced once leave requests exist (FR-012) |
| `counts_as_lop` | `BOOLEAN` | default `false` | Module 5 v2 — flags this type (e.g. "Loss of Pay") as unpaid for payroll; `salarySlipService.calculatePayroll` sums `working_days` on `APPROVED` requests of any such type overlapping a pay period |
| `is_active` | `BOOLEAN` | default `true` | Deactivated types are hidden from new selections but kept for history |
| `created_at` / `updated_at` | `TIMESTAMP` | default now | |

---

### 📊 `leave_balances`
*Migrations: `010_create_leave_balances.sql`, `014_create_leave_balance_ledger.sql`*

Per-employee, per-leave-type, per-year balance (FR-008). Rows are created lazily — the service ensures one exists for every active leave type the first time a user's balances are read, rather than via a rollover job.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `user_id` | `UUID` | FK → `users.id`, `ON DELETE CASCADE` | |
| `leave_type_id` | `UUID` | FK → `leave_types.id`, `ON DELETE RESTRICT` | Can't delete a leave type that still has balance rows |
| `year` | `INTEGER` | `NOT NULL` | Calendar year the balance applies to |
| `entitlement` | `NUMERIC(5,1)` | default `0` | Snapshot of `leave_types.annual_entitlement` at creation time |
| `created_at` / `updated_at` | `TIMESTAMP` | default now | |

**Uniqueness:** `(user_id, leave_type_id, year)` — exactly one balance row per person/type/year. **Index:** `user_id` (dashboard lookups).

> ⚠️ **`days_taken`/`days_pending` are not columns here** — migration 014 dropped them. They're computed at read time by summing `leave_balance_ledger` (see below) — this is what makes NFR-2 ("a balance must never drift") a structural guarantee: there's no running total that could ever fall out of step with the history that produced it.

---

### 🎉 `holidays`
*Migrations: `011_create_holidays.sql`, `012_add_holiday_date_range.sql`*

Company-wide public holidays (FR-010) — visible to everyone, editable by HR only. Originally a single `holiday_date`; migration 012 turned it into a **date range** so multi-day holidays (e.g. a 5-day Diwali) are one row instead of five.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `name` | `VARCHAR(150)` | `NOT NULL` | |
| `start_date` | `DATE` | `NOT NULL` | Renamed from `holiday_date` in migration 012 |
| `end_date` | `DATE` | `NOT NULL`, `CHECK (end_date >= start_date)` | Equals `start_date` for a single-day holiday |
| `created_at` / `updated_at` | `TIMESTAMP` | default now | |

**No uniqueness constraint on dates** — overlapping ranges are rejected at the *application* layer (`holidayService.js` → `findOverlappingHoliday`, returns `409`), not the database, since a DB-level exclusion constraint would need the `btree_gist` extension for little extra benefit here. Not linked to `users` — unlike the original design sketch (below), there's no `created_by` column; nothing currently needs to know who added a holiday.

---
