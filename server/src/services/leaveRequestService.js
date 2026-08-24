// Module 3 core business logic: submitting a leave request and moving it
// through approve/reject/withdraw/cancel/override. This is the one place
// row-level authorization is checked (NFR-1) and the one place a leave
// request's ledger/audit side effects are written — repositories stay pure
// SQL, the controller stays thin glue, exactly like every other feature.
import { findLeaveTypeById } from "../repositories/leaveTypeRepository.js";
import { findAllHolidays } from "../repositories/holidayRepository.js";
import { findDirectReports, findAuthContextById, findUserById, isUserInSubtree } from "../repositories/userRepository.js";
import { isInActorsHrScope, getHrScopedEmployeeIds } from "./hrScopeService.js";
import {
    insertLeaveRequest,
    findLeaveRequestById,
    findLeaveRequestsForEmployee,
    findTeamLeaveRequests,
    countTeamLeaveRequests,
    findLeaveRequestsFiltered,
    findLeaveTakenReport,
    findOverlappingLeaveRequest,
    updateLeaveRequestStatus,
    countPendingDecisionsForManagers,
    countLeaveRequestsFiltered,
} from "../repositories/leaveRequestRepository.js";
import { getBalanceForUserAndType, seedBalancesForUser } from "../repositories/leaveBalanceRepository.js";
import { insertLedgerEntry } from "../repositories/leaveBalanceLedgerRepository.js";
import { findActiveDelegation, findActiveDelegatedManagerIds } from "../repositories/delegationRepository.js";
import { insertAuditLog, findAuditLogsForLeaveRequest } from "../repositories/auditLogRepository.js";
import {
    insertLeaveRequestDocument,
    findDocumentByLeaveRequestId,
} from "../repositories/leaveRequestDocumentRepository.js";
import { calculateWorkingDays } from "./workingDayService.js";
import { assertLegalTransition } from "./leaveRequestStateMachine.js";
import { uploadLeaveRequestDocument, getSignedDocumentUrl, fetchDocumentStream } from "./cloudinaryService.js";
import {
    notifyLeaveRequestSubmitted,
    notifyLeaveRequestDecided,
    notifyLeaveRequestWithdrawnOrCancelled,
} from "./notificationService.js";
import { detectFileType } from "../utils/fileType.js";
import { todayDateKey } from "../utils/dates.js";
import { payPeriodsInRange, formatPayPeriod } from "../utils/payPeriod.js";
import { findLockedPayPeriodsForEmployee } from "../repositories/salarySlipRepository.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/appError.js";

// FR-012 (Module 3, point 2): only these three content types are accepted
// for a leave-request document, checked against the file's real bytes
// (fileType.js) rather than its extension or reported Content-Type.
const ACCEPTED_DOCUMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

// Maps a state-machine action to the ledger `reason` tag it produces —
// separate from the action name because the two override actions collapse
// onto shared reason tags (HR_OVERRIDE_APPROVE/HR_OVERRIDE_REJECT) that read
// naturally in the ledger regardless of which status they started from.
const LEDGER_REASON_BY_ACTION = {
    APPROVE: "APPROVE",
    REJECT: "REJECT",
    WITHDRAW: "WITHDRAW",
    CANCEL: "CANCEL",
    HR_OVERRIDE_TO_APPROVED: "HR_OVERRIDE_APPROVE",
    HR_OVERRIDE_TO_REJECTED: "HR_OVERRIDE_REJECT",
};

// Input: an action name and the request's snapshotted `workingDays`. Output:
// how much this action changes the ledger's pending/taken totals by. A
// request's `working_days` never changes after submission, so every delta
// here is either +workingDays, -workingDays, or 0 — never recomputed.
// Business meaning of each case (see Module 3 spec in .claude/rules.md):
//   SUBMIT already happened by the time this runs; APPROVE moves the hold
//   from pending into taken; REJECT/WITHDRAW just release the hold; CANCEL
//   returns already-taken days; the two HR overrides directly flip taken
//   without touching pending, since pending was already resolved by the
//   original approve/reject.
function ledgerDeltaForAction(action, workingDays) {
    switch (action) {
        case "APPROVE":
            return { pendingDelta: -workingDays, takenDelta: workingDays };
        case "REJECT":
        case "WITHDRAW":
            return { pendingDelta: -workingDays, takenDelta: 0 };
        case "CANCEL":
            return { pendingDelta: 0, takenDelta: -workingDays };
        case "HR_OVERRIDE_TO_APPROVED":
            return { pendingDelta: 0, takenDelta: workingDays };
        case "HR_OVERRIDE_TO_REJECTED":
            return { pendingDelta: 0, takenDelta: -workingDays };
        default:
            // Unreachable: assertLegalTransition already rejects any action
            // not in its TRANSITIONS map before this function is ever called.
            throw new Error(`No ledger rule for action: ${action}`);
    }
}

// True if `actorId` is `employeeManagerId` themselves, or is currently an
// active delegate standing in for them. Shared by the "can view" and "can
// act" checks below so the delegate-window logic exists in exactly one place.
async function isManagerOrDelegateOf(actorId, employeeManagerId) {
    if (!employeeManagerId) {
        return false;
    }
    if (employeeManagerId === actorId) {
        return true;
    }
    const delegation = await findActiveDelegation({
        managerId: employeeManagerId,
        delegateId: actorId,
        onDate: todayDateKey(),
    });
    return Boolean(delegation);
}

// The single row-level authorization check (NFR-1) for every mutating
// action. Input: the authenticated actor, the joined leave request row, and
// the action they're attempting. Output: `{ actedFor }` — `actedFor` is the
// manager being represented when a delegate acts, otherwise null (FR-020's
// audit requirement). Failure modes: 404 when the actor has no legitimate
// reason to know this request exists at all (an unrelated manager, an
// unrelated HR admin, or an unrelated employee); 403 when they know it
// exists but this action isn't theirs to take (their own request, wrong
// role, or a delegation window that isn't active today) — see the NFR-5
// policy note in .claude/rules.md.
//
// HR's *override* authority (APPROVED<->REJECTED, after a decision already
// exists) is scoped to their own reporting subtree (`isUserInSubtree`), not
// the whole company: this app supports more than one HR_ADMIN, each the
// root of their own separate branch (a MANAGER's own manager_id names one
// specific HR admin, not the role generically), so "HR can act on any
// request" from the brief means *their* requests, the same way it would for
// a manager — not every other HR admin's branch too. Company-wide visibility
// for HR is still available read-only via listAllLeaveRequests/
// getLeaveRequestById below, which this function has no bearing on.
//
// HR's authority to approve/reject a still-SUBMITTED request directly,
// though, is *not* subtree-wide (client-requested change, superseding an
// earlier version of this rule) — HR must be the request's actual assigned
// manager (or an active delegate for that manager) to decide first, the same
// as anyone else. See the APPROVE/REJECT branch below for why this still
// covers HR acting on their own or a MANAGER's leave request without any
// extra role-casing.
async function resolveActingCapacity(actor, request, action) {
    const isOwner = actor.id === request.employee_id;

    if (action === "WITHDRAW" || action === "CANCEL") {
        if (!isOwner) {
            throw notFound("Leave request not found");
        }
        return { actedFor: null };
    }

    // An employee can never approve/reject/override their own request,
    // regardless of what role they hold — checked before any role check so
    // an HR admin can't rubber-stamp their own leave either.
    if (isOwner) {
        throw forbidden("You cannot act on your own leave request");
    }

    if (action === "HR_OVERRIDE_TO_APPROVED" || action === "HR_OVERRIDE_TO_REJECTED") {
        if (actor.role !== "HR_ADMIN") {
            throw forbidden("Only HR can override a decision");
        }
        if (await isUserInSubtree(actor.id, request.employee_id)) {
            return { actedFor: null };
        }
        throw notFound("Leave request not found");
    }

    // APPROVE / REJECT: the actor must be the employee's direct manager or
    // an active delegate for that manager — the same check for everyone,
    // HR included. Client-requested change: HR no longer has a blanket
    // "act on your whole subtree" bypass here — the flow is always employee
    // submits -> the actual manager decides -> HR may override afterward
    // (see the HR_OVERRIDE branch above, still subtree-scoped). This still
    // lets HR decide directly whenever HR genuinely *is* the assigned
    // manager — an employee with no manager, a MANAGER (who only ever
    // reports to HR_ADMIN), or an HR_ADMIN reporting to another HR_ADMIN
    // all have `employee_manager_id` pointing straight at an HR_ADMIN
    // already, so nothing more than this one check is needed to also cover
    // "not for manager and HR's own requests."
    if (await isManagerOrDelegateOf(actor.id, request.employee_manager_id)) {
        const actingAsDelegate = request.employee_manager_id !== actor.id;
        return { actedFor: actingAsDelegate ? request.employee_manager_id : null };
    }

    // An HR-tier actor whose scope *does* include this employee already has a
    // legitimate reason to know the request exists (they can view/browse/
    // report on it elsewhere) — so a blocked direct approve/reject for them
    // is 403 ("not your call until the manager decides"), not 404. Someone
    // outside that scope is a stranger like anyone else (NFR-5). SUPER_ADMIN's
    // scope here is only their direct-report HR_ADMINs — practically moot for
    // this specific branch, since a direct-report HR_ADMIN's own request
    // always resolves via the manager-approve branch above instead, but kept
    // for the same "distinguish stranger from someone who just isn't the
    // decider" reasoning isUserInSubtree gives HR_ADMIN.
    if (await isInActorsHrScope(actor, request.employee_id)) {
        throw forbidden("Only the employee's manager can approve or reject this request — HR can override the decision afterward");
    }

    throw notFound("Leave request not found");
}

// Input: candidate submission fields. Output: `{ workingDays }` — never
// persists anything. This is what lets the frontend show "this request will
// use N days" before the employee actually submits (Module 3 spec, point 3),
// using the exact same calculation the real submission will use.
export async function previewWorkingDays({ startDate, endDate, startHalfDay, endHalfDay }) {
    const holidays = await findAllHolidays({});
    return calculateWorkingDays({ startDate, endDate, startHalfDay, endHalfDay, holidays });
}

// Input: the submitting employee's id, the request fields, and an optional
// `file` (multer's in-memory `{ buffer, size, originalname }`, or undefined
// if none was attached). Output: the newly created request (joined shape).
// Failure modes: 400 if the leave type doesn't exist/is inactive, if the
// range has no working days, if it would take the balance below zero and the
// leave type doesn't allow that, if the leave type requires a document and
// none was attached, or if an attached file's real content isn't one of the
// accepted types (FR-012); 409 if it overlaps an existing pending/approved
// request of the same employee's.
export async function submitLeaveRequest(
    employeeId,
    { leaveTypeId, startDate, endDate, startHalfDay, endHalfDay, reason },
    file
) {
    const leaveType = await findLeaveTypeById(leaveTypeId);
    if (!leaveType || !leaveType.is_active) {
        throw badRequest("Leave type not found or inactive");
    }

    if (leaveType.requires_document && !file) {
        throw badRequest(`A document is required for ${leaveType.name} requests`);
    }

    // Detected before anything else touches the DB or Cloudinary — never
    // trust the client-reported mimetype/extension (NFR-4).
    let detectedFileType = null;
    if (file) {
        detectedFileType = detectFileType(file.buffer);
        if (!ACCEPTED_DOCUMENT_TYPES.has(detectedFileType)) {
            throw badRequest("Document must be a PDF, JPG or PNG file");
        }
    }

    // Leave cannot start after the employee's employment ends. Checked here
    // rather than left to payroll, which clamps its own window and would simply
    // ignore the days: the request itself would still sit in the employee's
    // history holding pending or taken days for a period they were not employed
    // for, which is a balance that can never be right. last_working_day is
    // nullable — a missing value means "still employed", the same convention
    // joining_date uses.
    const employee = await findUserById(employeeId);
    if (employee?.last_working_day && startDate > employee.last_working_day) {
        throw badRequest(`Leave cannot start after the employee's last working day (${employee.last_working_day})`);
    }

    const holidays = await findAllHolidays({});
    const workingDays = calculateWorkingDays({ startDate, endDate, startHalfDay, endHalfDay, holidays });
    if (workingDays <= 0) {
        throw badRequest("This date range doesn't include any working days");
    }

    if (await findOverlappingLeaveRequest({ employeeId, startDate, endDate })) {
        throw conflict("You already have a pending or approved request that overlaps these dates");
    }

    // Requests spanning a year boundary are debited against the start date's
    // year — a documented simplification rather than splitting the deduction
    // proportionally across two balance rows.
    const year = Number(startDate.slice(0, 4));
    await seedBalancesForUser(employeeId, year); // self-heals the balance row, same as every other balance read in this app
    const balance = await getBalanceForUserAndType(employeeId, leaveTypeId, year);

    if (!leaveType.allow_negative_balance && workingDays > Number(balance.days_remaining)) {
        throw badRequest("This request would take your balance below zero");
    }

    // Uploaded last among the validation/pre-checks, and before the request
    // row is inserted: if Cloudinary fails, nothing has been written to
    // Postgres yet, so there's no partial leave request left behind and
    // nothing to roll back.
    let uploadedDocument = null;
    if (file) {
        uploadedDocument = await uploadLeaveRequestDocument({ buffer: file.buffer, mimeType: detectedFileType });
    }

    // SUPER_ADMIN has no manager and nobody positioned to review their own
    // leave — per product decision, their request bypasses the review
    // workflow entirely rather than being routed through a self-approval
    // step: created directly as APPROVED, never SUBMITTED, even momentarily.
    // Every check above this line still applies unchanged (leave type,
    // document requirement, working-day count, overlap, balance) — bypassing
    // *who decides* doesn't mean bypassing whether the numbers are still
    // true afterward (NFR-2).
    const submitter = await findAuthContextById(employeeId);
    const isSuperAdminSubmission = submitter?.role === "SUPER_ADMIN";

    const request = await insertLeaveRequest({
        employeeId,
        leaveTypeId,
        startDate,
        endDate,
        startHalfDay,
        endHalfDay,
        workingDays,
        reason,
        ...(isSuperAdminSubmission
            ? { status: "APPROVED", decidedBy: employeeId, decidedAt: new Date() }
            : {}),
    });

    if (uploadedDocument) {
        await insertLeaveRequestDocument({
            leaveRequestId: request.id,
            cloudinaryPublicId: uploadedDocument.publicId,
            cloudinaryResourceType: uploadedDocument.resourceType,
            originalFilename: file.originalname,
            mimeType: detectedFileType,
            fileSizeBytes: file.size,
            uploadedBy: employeeId,
        });
    }

    if (isSuperAdminSubmission) {
        // A single APPROVE-tagged entry, never ledgerDeltaForAction's
        // APPROVE case (that assumes an earlier SUBMIT entry already moved
        // the days into pending, and is releasing that hold) and never a
        // SUBMIT entry either — there's no pending state to represent here,
        // since this never passed through SUBMITTED.
        await insertLedgerEntry({
            userId: employeeId,
            leaveTypeId,
            year,
            leaveRequestId: request.id,
            pendingDelta: 0,
            takenDelta: workingDays,
            reason: "APPROVE",
        });
        await insertAuditLog({
            leaveRequestId: request.id,
            actorId: employeeId,
            action: "AUTO_APPROVE",
            oldStatus: null,
            newStatus: "APPROVED",
        });
        // No notification — SUPER_ADMIN has no manager, so there's no
        // recipient (notifyLeaveRequestSubmitted would already no-op here
        // via resolveManagerOrNearestHrAncestor returning null, but skipping
        // it outright is clearer about intent).
        return findLeaveRequestById(request.id);
    }

    await insertLedgerEntry({
        userId: employeeId,
        leaveTypeId,
        year,
        leaveRequestId: request.id,
        pendingDelta: workingDays,
        takenDelta: 0,
        reason: "SUBMIT",
    });

    await insertAuditLog({
        leaveRequestId: request.id,
        actorId: employeeId,
        action: "SUBMIT",
        oldStatus: null,
        newStatus: "SUBMITTED",
    });

    const createdRequest = await findLeaveRequestById(request.id);
    // Notifies the employee's manager (or nearest HR ancestor if they report
    // straight to HR) — a non-critical side effect, so its own failure never
    // fails the submission itself (see notifyLeaveRequestSubmitted).
    await notifyLeaveRequestSubmitted(createdRequest);
    return createdRequest;
}

// Output: the employee's own requests.
export async function listMyLeaveRequests(employeeId) {
    return findLeaveRequestsForEmployee(employeeId);
}

// Output: requests the actor can act on — their own full reporting subtree
// for HR (see resolveActingCapacity's note on why this is scoped, not
// company-wide); direct reports only, for a manager, plus (while it's
// active) any manager's team they're currently standing in for as a
// delegate. Deliberately direct-reports-only for a manager rather than
// their full subtree: approval authority belongs to the direct manager (or
// their delegate), not a skip-level manager further up the tree — HR is the
// one exception, since HR's subtree root *is* the top of their branch, with
// no further level above it to defer to. This mirrors isManagerOrDelegateOf
// and the HR branch of resolveActingCapacity above, just listing everything
// those checks would say yes to instead of checking one request at a time.
// Not role-gated at the route level for this reason: the delegate can be a
// plain EMPLOYEE with no direct reports of their own, who should still see
// (and be able to act on) the delegated team's requests here.
// Output: `{ rows, total }` — one page of the caller's team requests, or (when
// `startDate`/`endDate` are given instead of `limit`) everything overlapping
// that window, which is what the approvals calendar needs: a month at a time,
// not page 1. `total` is the count for the same filters either way.
//
// Paginated because this was the app's largest unbounded payload: for an
// HR_ADMIN it's every request in their whole branch, all statuses but
// WITHDRAWN, all years — thousands of rows and several megabytes at NFR-7's
// target, fetched every time the Approvals page opened.
export async function listTeamLeaveRequests(actor, { startDate, endDate, limit, offset } = {}) {
    const employeeIds = await teamScopedEmployeeIds(actor);
    const filters = { employeeIds, startDate, endDate, limit, offset };
    const [rows, total] = await Promise.all([
        findTeamLeaveRequests(filters),
        countTeamLeaveRequests(filters),
    ]);
    return { rows, total };
}

// The employee ids behind the /team list, pulled out of it so anything else
// answering "…about my team" resolves the same scope rather than
// reimplementing it — currently listTeamLeaveRequests above and
// listOnLeaveToday below. Two copies of this drifting apart would mean a
// dashboard tile and an approvals list disagreeing about who's on the team.
async function teamScopedEmployeeIds(actor) {
    if (actor.role === "HR_ADMIN" || actor.role === "SUPER_ADMIN") {
        return getHrScopedEmployeeIds(actor);
    }

    const reports = await findDirectReports(actor.id);
    const delegatedManagerIds = await findActiveDelegatedManagerIds(actor.id, todayDateKey());
    const delegatedReports = await Promise.all(delegatedManagerIds.map((managerId) => findDirectReports(managerId)));

    return [...reports, ...delegatedReports.flat()].map((report) => report.id);
}

// Output: `{ count }` — how many requests are waiting on *this* caller's
// decision right now. Deliberately a count endpoint rather than a list the
// caller counts itself: the sidebar badge asks for this on every page load,
// and the team list behind it is thousands of rows at NFR-7 scale (see
// countPendingDecisionsForManagers).
//
// The rule matches what the caller could actually decide today
// (resolveActingCapacity): the employee's assigned manager is either the
// caller, or a manager the caller is currently an active delegate for.
//
// This is narrower than "every SUBMITTED row in my team list" for an HR-tier
// caller, and that's intentional — their list spans their whole branch for
// visibility, but most of it is still the actual manager's call to make
// first, so counting all of it would badge HR with work that isn't theirs.
// It is exactly the rule the client used to apply after downloading the
// rows (canDecideDirectly in leaveRequestAuthz.js), moved server-side.
//
// One known gap, preserved rather than fixed here: an HR-tier caller who is
// *also* someone's active delegate doesn't get those delegated rows counted,
// because listTeamLeaveRequests' HR branch doesn't list them either. Making
// the count include them would badge rows the Approvals page won't show.
export async function countPendingDecisions(actor) {
    const isHrTier = actor.role === "HR_ADMIN" || actor.role === "SUPER_ADMIN";
    const delegatedManagerIds = isHrTier ? [] : await findActiveDelegatedManagerIds(actor.id, todayDateKey());
    return countPendingDecisionsForManagers([actor.id, ...delegatedManagerIds]);
}

// Output: the APPROVED requests overlapping today, for whoever the caller can
// see — the dashboard's "on leave today" table, which used to be derived
// client-side from the entire team (or company) request history.
//
// SUPER_ADMIN reads company-wide (`undefined` employee ids, no restriction),
// matching the company-wide list it alone may fetch and the whole-company
// headcount it already sees; everyone else gets their team scope. Reuses
// findLeaveRequestsFiltered rather than a new query: "APPROVED, overlapping
// [today, today]" is exactly one of its existing filter combinations.
export async function listOnLeaveToday(actor) {
    const today = todayDateKey();
    const employeeIds = actor.role === "SUPER_ADMIN" ? undefined : await teamScopedEmployeeIds(actor);
    return findLeaveRequestsFiltered({ status: "APPROVED", startDate: today, endDate: today, employeeIds });
}

// Output: `{ rows, total }` for the company-wide "All Requests" view, in the
// same two bounded shapes as listTeamLeaveRequests above — a page, or a
// window for the calendar. Route-gated to **SUPER_ADMIN only** (see
// leaveRequestRoutes.js): an HR_ADMIN is deliberately not company-wide here,
// their view of leave is their own branch. Still broader than what
// SUPER_ADMIN can *act* on (resolveActingCapacity — they can't override at
// all), the same viewing-vs-acting split NFR-5 draws elsewhere.
//
// `employeeIds` is omitted entirely rather than passed as a list of every
// employee: undefined means "no restriction" in the repository, which keeps
// this a single query instead of one that ships 200 uuids as a parameter.
export async function listAllLeaveRequests({ startDate, endDate, limit, offset } = {}) {
    const filters = { startDate, endDate, limit, offset };
    const [rows, total] = await Promise.all([
        findTeamLeaveRequests(filters),
        countTeamLeaveRequests(filters),
    ]);
    return { rows, total };
}

// Shared by both FR-024 functions below: which employees the caller's
// browse/report tools may cover.
//
// For an HR_ADMIN this is their own reporting subtree, exactly like
// listTeamLeaveRequests' HR branch — this app's auth is strict per-team (see
// resolveActingCapacity's note above), never every employee in the company.
// Excludes the HR admin themself, same as listTeamLeaveRequests.
//
// **SUPER_ADMIN gets `undefined` — no employee restriction at all** (direct
// request). Reusing getHrScopedEmployeeIds for them would have limited the
// reports to their direct-report HR admins, which is right for HR-scoped
// *writes* (verifying a profile, running payroll) and useless for reporting:
// the one role that can already read every request company-wide would get a
// leave-taken report covering three people. Both repository functions treat
// `undefined` employeeIds as "no filter" and an empty array as "nobody", so
// this deliberately returns the former, never `[]`.
async function reportableEmployeeIds(actor) {
    if (actor.role === "SUPER_ADMIN") {
        return undefined;
    }
    return getHrScopedEmployeeIds(actor);
}

// FR-024: HR's filterable browse view — every filter (employeeId,
// leaveTypeId, status, startDate/endDate) is optional, resolved entirely
// server-side (never a client-side array filter over an already-fetched
// list, so this stays correct and reasonably fast at the "200 employees,
// three years of history" scale NFR-7 asks for). Route-gated to HR_ADMIN
// (leaveRequestRoutes.js) — deliberately does not exclude WITHDRAWN the way
// listAllLeaveRequests above does, since a withdrawn request is exactly the
// kind of thing HR might filter *for* when browsing history, not dead
// weight to hide as it is on the action-oriented approvals views. Scoped to
// `actor`'s own reporting subtree, or company-wide for SUPER_ADMIN (see
// reportableEmployeeIds) — an `employeeId`
// filter for someone outside it simply returns no rows, the same as
// filtering for an employeeId that doesn't exist at all.
// Output: `{ rows, total }` — one page of results plus the total row count
// for the same filters, so the caller can render "showing 1–25 of N" and know
// whether there's a next page. Paginated because the unfiltered default case
// is every request in the caller's scope: thousands of rows and megabytes of
// JSON at NFR-7's "200 employees, three years" target, and HR's browse tab
// loads with no filters applied at all. Same `{ rows, total }` contract as
// the notifications list, the app's other paginated endpoint.
export async function listFilteredLeaveRequests(actor, filters) {
    const employeeIds = await reportableEmployeeIds(actor);
    const scoped = { ...filters, employeeIds };
    // Both queries take the same filters; only the list takes limit/offset.
    const [rows, total] = await Promise.all([
        findLeaveRequestsFiltered(scoped),
        countLeaveRequestsFiltered(scoped),
    ]);
    return { rows, total };
}

// FR-024: "a report of leave taken per employee over a period" — one row
// per employee who has at least one APPROVED request overlapping
// [startDate, endDate], with their total working days and request count in
// that window. See findLeaveTakenReport for the "counted in full, not
// pro-rated" simplification on a request that only partially overlaps the
// period. Shared by the JSON endpoint (on-screen table) and the CSV
// download (leaveRequestController.js) — this function only returns
// structured data, CSV formatting is a presentation concern that lives in
// the controller. Scoped to `actor`'s own reporting subtree — or company-wide for
// SUPER_ADMIN — same as listFilteredLeaveRequests above.
export async function generateLeaveTakenReport(actor, { startDate, endDate }) {
    const employeeIds = await reportableEmployeeIds(actor);
    return findLeaveTakenReport({ startDate, endDate, employeeIds });
}

// Input: the actor and a request id. Output: the request, if the actor is
// its owner, its direct manager, an active delegate for that manager,
// SUPER_ADMIN, or an HR_ADMIN whose own reporting subtree contains the
// employee — viewing is allowed in more cases than acting (an owner can view
// but never approve their own request). Failure mode: 404 otherwise.
//
// The HR_ADMIN case is subtree-scoped rather than company-wide (narrowed on
// direct request, along with GET /all): an HR admin's view of leave is their
// own branch. SUPER_ADMIN stays company-wide precisely so it agrees with the
// company-wide list they alone can now fetch — otherwise every row in that
// list would 404 on the way to its own detail view.
export async function getLeaveRequestById(actor, requestId) {
    const request = await findLeaveRequestById(requestId);
    if (!request) {
        throw notFound("Leave request not found");
    }

    const isOwner = actor.id === request.employee_id;
    if (
        isOwner ||
        actor.role === "SUPER_ADMIN" ||
        (await isManagerOrDelegateOf(actor.id, request.employee_manager_id)) ||
        (actor.role === "HR_ADMIN" && (await isUserInSubtree(actor.id, request.employee_id)))
    ) {
        return request;
    }

    throw notFound("Leave request not found");
}

// Input: the actor and a request id. Output: that request's full audit trail
// (FR-021), oldest first — same viewing rule as getLeaveRequestById, since
// anyone who can see the request can see how it got to its current state.
export async function getAuditTrail(actor, requestId) {
    await getLeaveRequestById(actor, requestId); // throws 404 if the actor can't view this request at all
    return findAuditLogsForLeaveRequest(requestId);
}

// Input: the actor and a request id. Output: `{ url, filename, mimeType }` —
// a signed Cloudinary URL valid for a few minutes (cloudinaryService.js),
// generated fresh on every call rather than stored, so a document is never
// reachable through a link that outlives this check. Same viewing rule as
// getLeaveRequestById (FR-012: "visible only to the requester, their
// approver and HR"). Failure modes: 404 if the actor can't view the request
// at all, or if the request has no document attached.
export async function getLeaveRequestDocument(actor, requestId) {
    await getLeaveRequestById(actor, requestId); // throws 404 if the actor can't view this request at all

    const document = await findDocumentByLeaveRequestId(requestId);
    if (!document) {
        throw notFound("This leave request has no document attached");
    }

    return {
        url: getSignedDocumentUrl(document.cloudinary_public_id, document.cloudinary_resource_type),
        filename: document.original_filename,
        mimeType: document.mime_type,
    };
}

// Input: the actor and a request id. Output: `{ stream, filename, mimeType }`
// for forcing a real download instead of a signed URL the browser just
// navigates to (see fetchDocumentStream). Same viewing rule/failure modes as
// getLeaveRequestDocument, which this reuses for the authorization check and
// metadata before fetching the actual bytes.
export async function downloadLeaveRequestDocument(actor, requestId) {
    const { url, filename, mimeType } = await getLeaveRequestDocument(actor, requestId);
    const stream = await fetchDocumentStream(url);
    return { stream, filename, mimeType };
}

// Input: the actor, the request id, the action being taken (one of the keys
// in leaveRequestStateMachine.js's TRANSITIONS), and an optional comment.
// Output: the updated request. Failure modes: 404/403 from
// resolveActingCapacity, 409 from assertLegalTransition, or 400 if trying to
// CANCEL a leave that has already started.
// Actions that change whether a request counts toward Loss of Pay, and so
// can invalidate an already-issued payslip.
//
// APPROVE and HR_OVERRIDE_TO_APPROVED add days to the LOP total;
// REJECT and HR_OVERRIDE_TO_REJECTED remove them. WITHDRAW and CANCEL are
// deliberately absent: WITHDRAW only applies to a SUBMITTED request, which
// never counted toward LOP in the first place (findLopWorkingDays filters on
// status = 'APPROVED'), and CANCEL is already refused for any leave that has
// started — and a payslip only exists for a completed period, so cancellable
// leave is always in a period no slip covers.
const LOP_AFFECTING_ACTIONS = new Set([
    "APPROVE",
    "REJECT",
    "HR_OVERRIDE_TO_APPROVED",
    "HR_OVERRIDE_TO_REJECTED",
]);

// Refuses a decision that would change the leave record behind a payslip the
// employee has already been issued.
//
// Input: the leave request row and the action being attempted. Output: none.
// Throws 409 naming the locked period(s) when the employee already holds an
// ACTIVE slip for any period this request overlaps.
//
// Why this exists: a payslip stores lop_days as a snapshot, and payroll only
// runs for a period that has fully ended — so there is always a window between
// "the leave happened" and "payroll ran", and any decision landing after the
// run leaves the slip stating one thing and the leave record another. Nothing
// reconciled them, and the likely direction was silent overpayment: a request
// approved late adds LOP days the slip never deducted, and nobody checks a
// payslip that came out too high.
//
// Locking per employee rather than per company is deliberate. The lock is
// derived from that employee's own ACTIVE slip, so it needs no new table and no
// close/reopen action, and voiding one person's slip reopens exactly that
// person — which is already the documented correction path (void, re-run).
//
// The refusal is a 409 rather than a 403: nobody lacks permission here, the
// record is simply in a state that forbids the change. The message names the
// period and the way out, because a manager hitting this has no idea payroll
// exists.
async function assertPeriodsOpen(request, action) {
    if (!LOP_AFFECTING_ACTIONS.has(action)) {
        return;
    }

    const periods = payPeriodsInRange(request.start_date, request.end_date);
    const locked = await findLockedPayPeriodsForEmployee(request.employee_id, periods);

    if (locked.length) {
        const labels = locked.map(formatPayPeriod).join(" and ");
        throw conflict(
            `Payroll for ${labels} has already been issued for this employee, so this request can no longer be decided. ` +
                `HR must void that payslip first, which reopens the period and lets it be re-run with the corrected leave.`
        );
    }
}

export async function decideLeaveRequest(actor, requestId, action, comment) {
    const request = await findLeaveRequestById(requestId);
    if (!request) {
        throw notFound("Leave request not found");
    }

    const { actedFor } = await resolveActingCapacity(actor, request, action);
    const newStatus = assertLegalTransition(action, request.status);

    // After authorization and the state machine, before anything is written:
    // an unauthorized caller should learn nothing about payroll, and an
    // illegal transition is the more fundamental complaint of the two.
    await assertPeriodsOpen(request, action);

    // The submit-time check above can't cover a leaving date recorded *after*
    // the request was raised, which is the common order of events: someone
    // books leave, then resigns. Approving it would move days to `taken` for a
    // period they were not employed for.
    if (action === "APPROVE" || action === "HR_OVERRIDE_TO_APPROVED") {
        const employee = await findUserById(request.employee_id);
        if (employee?.last_working_day && request.start_date > employee.last_working_day) {
            throw conflict(
                `This leave starts after the employee's last working day (${employee.last_working_day}), so it can no longer be approved.`
            );
        }
    }

    if (action === "CANCEL" && request.start_date <= todayDateKey()) {
        throw badRequest("Only a future, still-approved leave can be cancelled");
    }

    const year = Number(request.start_date.slice(0, 4));
    const { pendingDelta, takenDelta } = ledgerDeltaForAction(action, Number(request.working_days));

    await updateLeaveRequestStatus(requestId, {
        status: newStatus,
        decidedBy: actor.id,
        decisionComment: comment || null,
    });

    await insertLedgerEntry({
        userId: request.employee_id,
        leaveTypeId: request.leave_type_id,
        year,
        leaveRequestId: requestId,
        pendingDelta,
        takenDelta,
        reason: LEDGER_REASON_BY_ACTION[action],
    });

    await insertAuditLog({
        leaveRequestId: requestId,
        actorId: actor.id,
        actedFor,
        action,
        oldStatus: request.status,
        newStatus,
        comment: comment || null,
    });

    const decidedRequest = await findLeaveRequestById(requestId);

    // Non-critical side effects (see notifyLeaveRequestDecided) — which
    // employee/manager-facing notification fires depends on which action
    // this was, never on `newStatus` alone (an override and a plain decision
    // land on the same statuses but mean different things to the recipient).
    if (action === "WITHDRAW" || action === "CANCEL") {
        await notifyLeaveRequestWithdrawnOrCancelled(decidedRequest, action);
    } else {
        await notifyLeaveRequestDecided(decidedRequest, action, actor.id);
    }

    return decidedRequest;
}
