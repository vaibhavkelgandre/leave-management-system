# Employee onboarding & profile verification

> Part of [API Documentation](README.md). If this disagrees with the code, the code wins.

---

## Employee Onboarding & Profile Verification (`/api/employees`)

Module 5 v2 (FR-027), added beyond the original brief. The state machine (`users.profile_status`): `INCOMPLETE → SUBMITTED → VERIFIED`, or `SUBMITTED → INCOMPLETE` via HR's send-back. An employee becomes "payroll-ready" once `VERIFIED` **and** a salary structure exists (see above). Document visibility is self-or-HR-in-subtree, same rule as salary slips — never a manager.

### `POST /api/employees/me/profile/submit`

Moves the caller's own profile `INCOMPLETE → SUBMITTED`. Checked server-side: a fixed set of required profile fields (phone, current/permanent address, PAN, Aadhar, bank account/IFSC/name, at least the first emergency contact's phone + relationship) must be filled in, all required documents (below) must be uploaded, **and none of them may still be `REJECTED`** — a profile sent back over a document that didn't match can only be resubmitted once that document has been re-uploaded (which resets it to `PENDING_REVIEW`). Without that last rule, resubmitting unchanged just hands HR the same blocked `verify` back.

**Auth**: any authenticated role.

**Response** `200` — the caller's updated record (same shape as `GET /api/users/:id`).

**Errors**: `400` a required field is still blank, a required document hasn't been uploaded, or a rejected document hasn't been replaced (the message names which) · `409` the profile isn't currently `INCOMPLETE`.

---

### `POST /api/employees/me/documents/:documentType`

Uploads (or replaces) one of the required identity/bank/offer documents — proof for the `pan_number`/`aadhar_number`/bank fields collected on the same profile form, which is also where this upload is rendered client-side (`ProfileForm.jsx`'s "Government ID & bank details" section, not a separate page). Re-uploading resets its review status back to `PENDING_REVIEW` and clears any prior rejection comment.

**Auth**: any authenticated role — always the caller's own documents.

**Params**: `documentType` — `PAN_CARD` \| `AADHAR_CARD` \| `BANK_PASSBOOK` \| `OFFER_LETTER`.

**Body**: `multipart/form-data` — `file` (PDF/JPG/PNG, 5MB max, real content sniffed via magic bytes, same as leave-request documents).

**Response** `200`
```json
{
  "id": "...", "employee_id": "...", "document_type": "AADHAR_CARD",
  "original_filename": "...", "mime_type": "application/pdf", "file_size_bytes": 12345,
  "status": "PENDING_REVIEW", "reviewed_by": null, "reviewed_at": null, "review_comment": null,
  "created_at": "...", "updated_at": "..."
}
```

**Errors**: `400` no file attached, or its real content isn't PDF/JPG/PNG · `422` `documentType` isn't one of the accepted values.

---

### `GET /api/employees/me/documents`

Returns every document row for the caller — the required ones (if uploaded) plus any custom ones (below).

**Auth**: any authenticated role.

**Response** `200` — array of the document shape above, now also including `document_name` (`null` for the required types, the user-supplied label for a custom one).

---

### `GET /api/employees/me/documents/:documentType/url`

Self-scoped counterpart to `GET /api/employees/:id/documents/:documentType/url` below — lets the profile page offer a "View" action without needing to know its own employee id.

**Response**/**Errors**: same as the `:id` version below.

---

### `GET /api/employees/:id/documents`

Same shape as `/me/documents`, for HR reviewing a specific employee (or the employee viewing their own via their own id).

**Auth**: the employee themself, or an `HR_ADMIN` whose subtree contains them.

**Errors**: `404` caller isn't the subject and isn't HR-with-subtree-access.

---

### `GET /api/employees/:id/documents/:documentType/url`

**Response** `200` — `{ "documentId": "...", "url": "...", "filename": "...", "mimeType": "..." }`. `url` is a Cloudinary signed link valid for a few minutes, generated fresh on every call — same pattern as `GET /api/leave-requests/:id/document`. `documentId` is what a caller needs to fetch the bytes through this app instead (`GET /api/employees/documents/:documentId/file` below) — which is the only way to *preview* a PDF, since Cloudinary serves raw assets as downloads.

**Errors**: `404` caller isn't allowed to view it, or the document doesn't exist.

---

### `GET /api/employees/documents/:documentId/file`

Streams one document's bytes **through this app**, rather than handing the browser a Cloudinary URL. Serves any row in `employee_documents` — a required document or a custom one, the caller's own or (for HR in scope) someone else's — since authorization comes from the row itself, the same pattern as `GET /api/salary-slips/:id`.

This exists because a Cloudinary link can't be previewed: PDFs are stored as `resource_type: "raw"`, and raw delivery sends `Content-Disposition: attachment`, so an `<iframe>` pointed at the signed URL downloaded the file instead of rendering it. The disposition belongs to whoever serves the bytes, so previewing requires serving them ourselves.

**Auth**: the employee themself, or an `HR_ADMIN`/`SUPER_ADMIN` whose scope contains them. Never a manager.

**Query params**: `disposition` — `inline` (default) or `attachment`. Constrained to those two values by the validator, so the header can never be shaped by the caller.

**Response** `200` — the raw file bytes, with `Content-Type` set from the stored `mime_type` and `Content-Disposition` set to the requested disposition plus the original filename.

**Errors**: `401` not logged in · `404` no such document, or the caller can't view its owner's documents · `422` malformed `documentId`, or a `disposition` outside the two allowed values.

---

### `POST /api/employees/me/documents/custom`

Attaches an additional, self-named document beyond the required ones (e.g. a degree certificate) — always optional, never checked by `POST /api/employees/me/profile/submit`. Unlike the required-document upload, this always creates a **new** row — any number of custom documents may exist per employee, each identified by its own id rather than a fixed type.

**Auth**: any authenticated role — always the caller's own documents.

**Body**: `multipart/form-data` — `name` (text, 1–100 chars, the label shown in the UI) and `file` (PDF/JPG/PNG, 5MB max).

**Response** `200` — the document shape above, with `document_type: "OTHER"` and `document_name` set to the given label.

**Errors**: `400` no file attached, or its real content isn't PDF/JPG/PNG · `422` `name` missing/blank.

---

### `GET /api/employees/me/documents/custom/:documentId/url`

Same shape/behavior as the required-document URL endpoint above (`documentId` included), keyed by the document's own id instead of a fixed type.

**Errors**: `404` no such document, or it isn't the caller's own.

---

### `DELETE /api/employees/me/documents/custom/:documentId`

Removes one of the caller's own custom documents (and its underlying Cloudinary asset) — the only delete endpoint anywhere in this document flow; the required documents have no delete, only replace. Scoped server-side to `document_type = 'OTHER'`, so this can never remove a required document even given the wrong id.

**Auth**: any authenticated role — always the caller's own documents.

**Response** `200` — `{ "success": true, "message": "Document removed", "data": null }`.

**Errors**: `404` no such document, it isn't the caller's own, or it isn't a custom document.

---

### `POST /api/employees/:id/documents/:documentType/review`

Marks a specific uploaded document `VERIFIED` or `REJECTED`. Rejecting doesn't delete anything — the employee re-uploads to replace it.

**Auth**: `HR_ADMIN` only, and only within their own reporting subtree.

**Body**: `{ "status": "VERIFIED | REJECTED", "comment": "string, optional" }`

**Response** `200` — the document shape above.

**Errors**: `403` caller isn't `HR_ADMIN` · `404` employee outside the caller's subtree, or no document of that type uploaded yet.

---

### `GET /api/employees/pending-verification`

HR's review queue — every profile in their own subtree currently `SUBMITTED`.

**Auth**: `HR_ADMIN` only.

**Response** `200` — array of user rows (same shape as `GET /api/users`).

---

### `GET /api/employees/verified`

The "Verified Employees" section on the same page — every profile in HR's own subtree that has already reached `VERIFIED`. Powers the "See details" link to `GET /api/employees/:id` / `/dashboard/team/:id`.

**Auth**: `HR_ADMIN` only.

**Response** `200` — array of user rows (same shape as `GET /api/users`).

---

### `GET /api/employees/:id`

The full profile for HR's verification detail page (`/dashboard/profile-verification/:id`) and the read-only employee-details page (`/dashboard/team/:id` — under "team", not "employees": reached from "My Team" and from the "Verified Employees" list, not from "All Employees") alike — every field the employee filled in, not just the documents. Not filtered by `profile_status`, so it works for a `SUBMITTED` profile awaiting review just as well as an already-`VERIFIED` one.

Deliberately not the same route as `GET /api/users/:id`: that one lets any `HR_ADMIN` view any user company-wide, which doesn't match the per-branch isolation every other HR-scoped action in this section enforces (documents, salary structures, verify/send-back). This route is `isUserInSubtree`-scoped like the rest of them.

**Auth**: `HR_ADMIN` only, and only within their own reporting subtree.

**Response** `200` — the employee's full user row (same shape as `GET /api/users`, unmasked).

**Errors**: `403` caller isn't `HR_ADMIN` · `404` no such employee, or they're outside the caller's subtree.

---

### `POST /api/employees/:id/exit`

Records that an employee has left, and brings any already-issued payslips back in line in the same operation. This is the intended way to set a leaving date — `PATCH .../employment-dates` refuses (`409`) when a payslip is in the way, and this is the operation that clears it.

**Auth**: `HR_ADMIN` / `SUPER_ADMIN`, scoped to the caller's own HR scope. A manager gets `403`; an HR admin from another branch gets `404`.

**Body**
```json
{
  "lastWorkingDay": "YYYY-MM-DD, required",
  "reason": "string, required"
}
```

`reason` is required because it's recorded on the void of any payslip this corrects — "why was this voided" with no answer is worse than no void record. Same reasoning as the required comment on an HR override.

**What it does to existing payslips.** Every `ACTIVE` slip for that employee is checked against the dates now on record, and **any slip that no longer agrees is voided** — not recomputed. The comparison is on employed *days*: a slip's `payable_days + lop_days` is the employed-day count it was built from, and if that differs from what the current dates imply, the slip is inconsistent.

That catches three cases with one rule:

| Case | Result |
|---|---|
| The period contains the leaving date | Voided — it was built for a full month and now covers fewer employed days |
| The period is entirely after the leaving date | Voided — the employee was never employed during it |
| The period was pro-rated by an **older** leaving date that has since moved | Voided — this is the case a "recompute the exit month" rule silently missed, and it underpaid a real employee for a month they had worked in full |

A period the employee worked in full, whose slip already reflects that, is left alone.

**Nothing is recomputed here.** HR re-runs payroll when they choose, and a `VOIDED` slip already returns the employee to `ok` in the run preview, so they're picked up automatically. Voiding rather than replacing is deliberate: replacing the figures in place meant a departing employee discovered a pay cut by re-reading a payslip they had already read.

Each void records HR's reason plus what the system did with it (e.g. *"Resigned — employment dates changed: this period now covers 10 employed day(s), not 31. Voided so payroll can be re-run."*), fires a `SALARY_SLIP_VOIDED` notification, and **emails the employee** — see the note below.

**Response** `200`
```json
{
  "success": true,
  "message": "Exit recorded. 2 payslip(s) voided (2026-07, 2026-08) — re-run payroll for those periods.",
  "data": {
    "employee": { "...": "the updated record" },
    "voided": ["2026-07", "2026-08"]
  }
}
```

**Errors**: `400` leaving date before the joining date · `403` caller isn't HR-tier · `404` employee outside the caller's HR scope · `422` validation, including a missing `lastWorkingDay` or a blank `reason`.

> ℹ️ **The employee is emailed about the void, never sent a corrected payslip.** Two things were tried and rejected. *Silent voiding* leaves someone holding a document that no longer applies with no way to know. *Emailing the corrected payslip* — which this did briefly — means a departing employee discovers a pay cut by re-reading a payslip they had already read, and a pro-rated slip isn't a final settlement anyway (notice pay, leave encashment and gratuity aren't modelled). So the email announces the void, gives HR's reason, and says a corrected payslip will follow — deliberately carrying **no figure**, because at the moment of voiding there isn't one yet. Controlled by `MAIL_FEATURE_SALARY_SLIP_VOIDED`; the in-app notification fires either way.

---

### `PATCH /api/employees/:id/employment-dates`

HR records the two dates payroll depends on: `joiningDate` (from the signed offer letter, normally at verification time) and `lastWorkingDay` (when someone leaves).

**Neither is self-editable, and that's a correctness rule rather than a policy preference.** Both determine the payable-day count on every payslip — `joining_date` drives `computeSlip`'s `effectiveStart` and the not-employed deduction, `last_working_day` now does the same at the other end. While they sat in the self-editable profile fields, an employee who really started on the 20th could set the 1st and grant themselves the difference (₹30,645.16 on a ₹50,000 salary in a 31-day month), or set a future date and be skipped by payroll entirely. They are absent from `PATCH /api/users/me/profile` now; values sent there are ignored, not rejected, matching how that endpoint already treats `role`/`managerId`/`status`.

**Auth**: `HR_ADMIN` / `SUPER_ADMIN`, scoped to the caller's own HR scope (`isInActorsHrScope`) — an HR admin from another branch gets `404`, the same answer an unrelated employee gets.

**Body** — either key may be omitted to leave that date alone; an explicit `null` clears it (which is how a rejoining employee returns to the payroll list). An empty body is `422`.
```json
{
  "joiningDate": "YYYY-MM-DD | null, optional",
  "lastWorkingDay": "YYYY-MM-DD | null, optional"
}
```

**Response** `200` — the updated employee record.

**Errors**: `400` last working day before the joining date (validated against whichever value will be in force, so setting either date alone is still checked against the other) · `403` caller isn't HR-tier · `404` employee outside the caller's HR scope · `422` validation, including an empty body.

> ℹ️ **This used to answer `409` when a payslip covered an affected period.** It now voids what no longer agrees instead, exactly as `POST /:id/exit` does, and returns `{ employee, voided }`. The refusal was safe but a dead end — HR was told to go and void the payslip themselves, come back, and try again — and it never noticed a slip an *older* date had already pro-rated, which is how an employee ended up stuck on 14 payable days for a month they worked in full.

---

### `POST /api/employees/:id/verify`

Moves the target's profile `SUBMITTED → VERIFIED`, recording who verified it and when.

**Every required document must already be individually `VERIFIED`** (`POST /:id/documents/:documentType/review`). The two blocking cases are reported differently, because they need different actions from HR:

- **Any document still `PENDING_REVIEW`** → `400`, naming them: *"Review every document before verifying the profile — still pending: Signed offer letter."* HR reviews the ones they missed, then verifies.
- **Any document `REJECTED`** → `400`: *"PAN card was rejected as not matching the details provided. Send the profile back so the employee can re-upload…"* A rejected document can only be fixed by the employee, so the way forward is `POST /:id/send-back`, not another `verify`.

Without this gate a profile could be marked `VERIFIED` with its documents unread or outright rejected — the one outcome the per-document review step exists to prevent.

**Auth**: `HR_ADMIN` only, and only within their own reporting subtree.

**Response** `200` — the employee's updated record.

**Errors**: `403` caller isn't `HR_ADMIN` · `404` employee outside the caller's subtree · `409` the profile isn't currently `SUBMITTED` (checked before the document rules, so "already verified" still answers `409`) · `400` a required document is missing, still pending review, or rejected.

---

### `POST /api/employees/:id/send-back`

Moves the target's profile `SUBMITTED → INCOMPLETE` so the employee can correct and resubmit it. `reason` is stored on the employee's record (`profile_send_back_reason`/`profile_send_back_by`/`profile_send_back_at`) and returned in every subsequent fetch of that user (e.g. `GET /api/auth/me`) while the profile stays `INCOMPLETE` because of it — the employee needs to know *what* was wrong to actually fix it, not just that something was. Cleared again once the employee resubmits (`POST /api/employees/me/profile/submit`).

**Auth**: `HR_ADMIN` only, and only within their own reporting subtree.

**Body**: `{ "reason": "string, required, 1-1000 chars" }`

**Response** `200` — the employee's updated record.

**Errors**: `403` caller isn't `HR_ADMIN` · `404` employee outside the caller's subtree · `409` the profile isn't currently `SUBMITTED` · `422` `reason` missing/blank.

---
