import {
    deleteExpiredInvitees,
    findAllUsers,
    findEmployeesPendingVerification,
    findPasswordHashById,
    findReportingLine,
    findSubtreeUsers,
    findAllUserOptions,
    findSubtreeUserOptions,
    findUserById,
    findVerifiedEmployees,
    updateManager,
    updatePasswordHash,
    updateEmploymentDates as updateEmploymentDatesRepo,
    updateProfileFields,
    updateProfileStatus,
    updateStatus,
} from "../repositories/userRepository.js";
import { findDocumentsByEmployeeId } from "../repositories/employeeDocumentRepository.js";
import { findLockedPayPeriodsForEmployee } from "../repositories/salarySlipRepository.js";
import {
    REQUIRED_DOCUMENT_TYPES,
    assertRequiredDocumentsVerified,
    assertNoRejectedDocuments,
} from "./employeeDocumentService.js";
import { assertNoCycle } from "./reportingService.js";
import { isInActorsHrScope, getHrScopedEmployeeIds } from "./hrScopeService.js";
import { reconcileSlipsAfterExit } from "./salarySlipService.js";
import { assertLegalProfileTransition } from "./profileVerificationStateMachine.js";
import {
    notifyProfileSubmitted,
    notifyProfileVerified,
    notifyProfileSentBack,
    notifyManagerReassigned,
    notifyTeamMemberAssigned,
    notifyAccountStatusChanged,
    notifyEmploymentDatesUpdated,
} from "./notificationService.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../utils/appError.js";
import { formatPayPeriod } from "../utils/payPeriod.js";

// The minimum a profile needs before HR can meaningfully review it — not
// every optional field on the sheet (education, passport, blood group, …),
// just enough to actually run payroll and reach the employee in an
// emergency. Checked by submitProfileForVerification below.
const REQUIRED_PROFILE_FIELDS = [
    "phone",
    "current_address",
    "permanent_address",
    "pan_number",
    "aadhar_number",
    "bank_account_number",
    "bank_ifsc_code",
    "bank_name",
    "emergency_contact_1_phone",
    "emergency_contact_1_relationship",
];

// PAN/Aadhar/passport/bank details are sensitive government/financial
// identifiers — shown in full only to HR and to the employee themself;
// nulled out for anyone else viewing the record (e.g. a manager viewing a
// direct report). Other new profile fields (phone/address/DOB/emergency
// contact/designation/etc.) aren't masked: a manager plausibly needs a
// report's contact details, same row-level scope as everything else on
// these endpoints.
const SENSITIVE_PROFILE_FIELDS = [
    "pan_number",
    "aadhar_number",
    "passport_number",
    "bank_account_number",
    "bank_ifsc_code",
    "bank_name",
];

function maskSensitiveProfileFields(user, viewer) {
    if (!user || viewer.id === user.id || viewer.role === "HR_ADMIN" || viewer.role === "SUPER_ADMIN") {
        return user;
    }
    const masked = { ...user };
    for (const field of SENSITIVE_PROFILE_FIELDS) {
        masked[field] = null;
    }
    return masked;
}

// Exported for reportingService's "my team" list (userController.getMyTeam)
// — that path fetches rows via findSubtreeUsers directly rather than through
// listUsersFor below, so it needs the same masking applied explicitly.
export function maskSensitiveProfileFieldsForList(users, viewer) {
    return users.map((user) => maskSensitiveProfileFields(user, viewer));
}

export async function listUsersFor(actor) {
    // Swept here rather than on a schedule: the project has no job runner, and
    // listing users is the moment the stale rows would otherwise be seen. Same
    // self-healing-on-read approach used for leave balances.
    await deleteExpiredInvitees();

    let users;
    if (actor.role === "HR_ADMIN" || actor.role === "SUPER_ADMIN") {
        users = await findAllUsers();
    } else if (actor.role === "MANAGER") {
        users = await findSubtreeUsers(actor.id);
    } else {
        const self = await findUserById(actor.id);
        users = self ? [self] : [];
    }

    return maskSensitiveProfileFieldsForList(users, actor);
}

// The picker-sized counterpart to listUsersFor above: the same scoping rules,
// five columns instead of forty. Every dropdown in the app uses this; only the
// All Employees roster (which really does display every field) still needs the
// full rows.
//
// No masking needed, deliberately: masking only ever applied to the sensitive
// government-ID and bank columns, and none of them are selected here — so the
// projection isn't just smaller, it can't leak them at all.
export async function listUserOptionsFor(actor) {
    if (actor.role === "HR_ADMIN" || actor.role === "SUPER_ADMIN") {
        return findAllUserOptions();
    }
    if (actor.role === "MANAGER") {
        return findSubtreeUserOptions(actor.id);
    }
    // An employee sees only themselves, matching listUsersFor — a picker with
    // one option is odd, but the alternative is a role check at every call site.
    const self = await findUserById(actor.id);
    return self ? [{ id: self.id, first_name: self.first_name, last_name: self.last_name, role: self.role, status: self.status }] : [];
}

// A user viewing their own profile also gets a quick summary of who's above
// them in the reporting chain: their direct manager, and the nearest
// HR-tier ancestor — whoever will actually end up verifying their profile,
// per isUserInSubtree's downward-from-HR scoping (the first HR_ADMIN found
// walking up is the closest one whose subtree contains this user) — or, for
// an HR_ADMIN reporting straight to SUPER_ADMIN, SUPER_ADMIN itself (without
// this, an HR_ADMIN whose only ancestor is SUPER_ADMIN would see "hr: null"
// here, since SUPER_ADMIN's role doesn't literally match "HR_ADMIN"). Only
// computed for self-view: nobody else needs it, and it'd be wasted work on
// every row of a list.
async function attachReportingLine(user) {
    const ancestors = await findReportingLine(user.id);
    const toSummary = (row) => ({ id: row.id, first_name: row.first_name, last_name: row.last_name, email: row.email });
    const hrAncestor = ancestors.find((row) => row.role === "HR_ADMIN" || row.role === "SUPER_ADMIN");
    return {
        ...user,
        manager: ancestors[0] ? toSummary(ancestors[0]) : null,
        hr: hrAncestor ? toSummary(hrAncestor) : null,
    };
}

// `viewer` gates the 5 sensitive profile columns (see
// maskSensitiveProfileFields above); every caller of this function passes
// the acting user, even an HR-only one (changeManager/changeStatus below),
// where masking is always a no-op since viewer.role === "HR_ADMIN".
export async function getUserById(id, viewer) {
    const user = await findUserById(id);
    if (!user) {
        throw notFound("User not found");
    }
    const masked = maskSensitiveProfileFields(user, viewer);
    return viewer.id === id ? attachReportingLine(masked) : masked;
}

// Input: the caller's own id and a partial set of self-editable fields
// (already whitelisted twice over — profileValidator.js's zod schema, then
// updateProfileFields' own column whitelist — so this never needs to filter
// anything itself). Output: the caller's own updated record, always
// unmasked (a user editing their own profile is always "self").
export async function updateMyProfile(actorId, fields) {
    const updated = await updateProfileFields(actorId, fields);
    if (!updated) {
        throw notFound("User not found");
    }
    return updated;
}

// Input: the caller's own id. Output: the updated user, moved from
// INCOMPLETE to SUBMITTED. Throws 400 if a required field is still blank or
// either required document hasn't been uploaded yet — this is the one place
// "is this profile actually complete" is checked, so the state machine
// itself never has to know what "complete" means.
export async function submitProfileForVerification(actorId) {
    const user = await findUserById(actorId);
    const missingFields = REQUIRED_PROFILE_FIELDS.filter((field) => !user[field]);
    if (missingFields.length > 0) {
        throw badRequest(`Please fill in all required fields before submitting: ${missingFields.join(", ")}`);
    }

    const documents = await findDocumentsByEmployeeId(actorId);
    const uploadedTypes = new Set(documents.map((document) => document.document_type));
    const missingDocuments = REQUIRED_DOCUMENT_TYPES.filter((type) => !uploadedTypes.has(type));
    if (missingDocuments.length > 0) {
        throw badRequest("Please upload all required documents before submitting");
    }

    // Blocks the "resubmit without fixing anything" loop: if HR sent this
    // profile back because a document didn't match, resubmitting the same
    // rejected document just hands them the same blocked Verify button
    // again (see assertRequiredDocumentsVerified).
    await assertNoRejectedDocuments(actorId);

    const newStatus = assertLegalProfileTransition("SUBMIT", user.profile_status);
    await updateProfileStatus(actorId, { status: newStatus });
    const submittedUser = await findUserById(actorId);
    // Non-critical side effect (see notifyProfileSubmitted) — notifies the
    // nearest HR ancestor, the one whose subtree actually includes this employee.
    await notifyProfileSubmitted(submittedUser);
    return submittedUser;
}

// HR-tier-only, scoped via isInActorsHrScope (HR_ADMIN's own subtree, or
// SUPER_ADMIN's direct-report HR_ADMINs only — see hrScopeService.js) —
// moves a SUBMITTED profile to VERIFIED, recording who verified it and when.
//
// Every required document must already be individually VERIFIED
// (assertRequiredDocumentsVerified, 400 otherwise). Checked after the state
// transition so "you already verified this" still answers 409 rather than
// being reported as a document problem.
// Sets the two employment dates payroll depends on. HR-tier only.
//
// Input: the acting HR user, the employee's id, and `{ joiningDate,
// lastWorkingDay }` — either may be omitted to leave that date alone.
// Output: the updated employee record.
// Throws 403 for a non-HR caller, 404 when the employee is outside the actor's
// HR scope (same wording an unrelated employee gets — no more reason to know
// they exist), 400 for a last working day before the joining date, and 409 when
// the change would contradict a payslip that has already been issued.
//
// Why HR rather than the employee: both dates determine pay. joining_date
// drives computeSlip's payable-day count and pre-joining deduction, and
// last_working_day now does the same at the other end — so while these were
// self-editable an employee could change their own salary from their own
// profile page. HR sets the joining date at verification from the signed offer
// letter, which is what makes the value payroll trusts evidence-backed rather
// than self-reported.
//
// The 409 is the same reasoning as the leave-decision payroll lock
// (leaveRequestService.assertPeriodsOpen): a payslip stored a payable-day count
// derived from these dates, so moving them afterwards would leave the slip and
// the employment record disagreeing, silently. HR voids the affected slip
// first, which reopens the period.
// Records that an employee has left, and brings any already-issued payslips
// back in line in the same operation.
//
// Input: the acting HR user, the employee's id, and `{ lastWorkingDay, reason }`
// — the reason is carried into the void record on any slip this corrects.
// Output: `{ employee, voided, regenerated }`, where the two arrays are the pay
// periods touched, so HR is told exactly what happened rather than having to go
// and look.
// Throws 403 for a non-HR caller, 404 outside the actor's HR scope, and 400 for
// a leaving date before the joining date.
//
// Deliberately does *not* go through updateEmploymentDates, even though it
// writes the same column. That function refuses (409) when a payslip already
// covers an affected period, because a bare date edit would leave the slip and
// the employment record disagreeing silently. This one is the operation that
// *resolves* that disagreement, so the same refusal would block the only thing
// that fixes it. Two intents on one field: "edit this date" is blocked when a
// payslip is in the way, "process this exit" clears the way itself.
//
// Voiding and re-issuing here — rather than refusing and asking HR to do it by
// hand — is safe for a reason worth stating, because the opposite call was made
// for leave decisions (assertPeriodsOpen blocks and does not auto-correct).
// There, no human was deciding anything: approving a leave request would have
// quietly rewritten a payslip the employee already held. Here a human is
// explicitly processing an exit, with a stated reason recorded against the
// void, and the mechanism is the existing void-and-rerun path reached from one
// button instead of five manual steps. The audit trail is identical either way.
export async function processEmployeeExit(actor, employeeId, { lastWorkingDay, reason }) {
    if (actor.role !== "HR_ADMIN" && actor.role !== "SUPER_ADMIN") {
        throw forbidden("Only HR can record an employee exit");
    }

    const employee = await findUserById(employeeId);
    if (!employee || !(await isInActorsHrScope(actor, employeeId))) {
        throw notFound("Employee not found");
    }

    if (employee.joining_date && lastWorkingDay < employee.joining_date) {
        throw badRequest("Last working day cannot be before the joining date");
    }

    const updated = await updateEmploymentDatesRepo(employeeId, { lastWorkingDay });
    if (!updated) {
        throw notFound("Employee not found");
    }

    // Reconciliation runs after the write, never before: computeSlip reads the
    // leaving date off the employee row, so re-issuing against a stale row
    // would reproduce exactly the figures being corrected.
    const { voided, regenerated } = await reconcileSlipsAfterExit(actor, updated, lastWorkingDay, reason);

    await notifyEmploymentDatesUpdated(employeeId, actor.id, "exit"); // non-critical side effect

    return { employee: updated, voided, regenerated };
}

export async function updateEmploymentDates(actor, employeeId, { joiningDate, lastWorkingDay }) {
    if (actor.role !== "HR_ADMIN" && actor.role !== "SUPER_ADMIN") {
        throw forbidden("Only HR can set employment dates");
    }

    const employee = await findUserById(employeeId);
    if (!employee || !(await isInActorsHrScope(actor, employeeId))) {
        throw notFound("Employee not found");
    }

    // Compare against whichever value will be in force after this change, not
    // just the incoming one, so setting either date alone is still validated
    // against the other.
    const effectiveJoining = joiningDate !== undefined ? joiningDate : employee.joining_date;
    const effectiveLast = lastWorkingDay !== undefined ? lastWorkingDay : employee.last_working_day;
    if (effectiveJoining && effectiveLast && effectiveLast < effectiveJoining) {
        throw badRequest("Last working day cannot be before the joining date");
    }

    await assertEmploymentDatesUnpaid(employeeId, { joiningDate, lastWorkingDay }, employee);

    const updated = await updateEmploymentDatesRepo(employeeId, { joiningDate, lastWorkingDay });
    if (!updated) {
        throw notFound("Employee not found");
    }

    // These dates are no longer something the employee can see change, so they
    // are told when it happens. No values in the message — see
    // notifyEmploymentDatesUpdated.
    await notifyEmploymentDatesUpdated(employeeId, actor.id, "dates"); // non-critical side effect
    return updated;
}

// Refuses a date change that would contradict an already-issued payslip.
//
// Input: the employee id, the incoming dates, and their current record.
// Output: none. Throws 409 naming the period.
//
// Only periods whose payable-day count could actually change are considered:
// the earlier of the old and new value bounds the affected range on each side,
// because moving a date in either direction changes the months between them.
// A period with no ACTIVE slip is free to change — nothing has been paid for it
// yet, which is the ordinary case when HR records a joining date at
// verification time, long before that month's payroll runs.
async function assertEmploymentDatesUnpaid(employeeId, incoming, employee) {
    const affected = new Set();

    for (const [next, current] of [
        [incoming.joiningDate, employee.joining_date],
        [incoming.lastWorkingDay, employee.last_working_day],
    ]) {
        if (next === undefined || next === current) continue;
        for (const value of [next, current]) {
            if (value) affected.add(value.slice(0, 7));
        }
    }

    if (!affected.size) return;

    const locked = await findLockedPayPeriodsForEmployee(employeeId, [...affected]);
    if (locked.length) {
        const labels = locked.map(formatPayPeriod).join(" and ");
        throw conflict(
            `Payroll for ${labels} has already been issued for this employee, and changing these dates would change what that payslip should have paid. ` +
                `Void that payslip first, which reopens the period for a corrected run.`
        );
    }
}

export async function verifyProfile(actor, employeeId) {
    if (actor.role !== "HR_ADMIN" && actor.role !== "SUPER_ADMIN") {
        throw forbidden("Only HR can verify a profile");
    }
    const employee = await findUserById(employeeId);
    if (!employee || !(await isInActorsHrScope(actor, employeeId))) {
        throw notFound("Employee not found");
    }

    const newStatus = assertLegalProfileTransition("VERIFY", employee.profile_status);
    await assertRequiredDocumentsVerified(employeeId);
    await updateProfileStatus(employeeId, { status: newStatus, verifiedBy: actor.id, verifiedAt: new Date() });
    await notifyProfileVerified(employeeId, actor.id); // non-critical side effect
    return findUserById(employeeId);
}

// The flip side of verifyProfile — kicks a SUBMITTED profile back to
// INCOMPLETE so the employee can fix and resubmit it. `reason` is required
// (enforced by sendProfileBackSchema at the route layer) and stored on the
// user row — the employee needs to know *what* was wrong (misleading info,
// a mismatch against an uploaded document, etc.) to actually fix it, not
// just that something was. Cleared again once the employee resubmits
// (updateProfileStatus defaults every other transition's fields to null).
export async function sendProfileBack(actor, employeeId, reason) {
    if (actor.role !== "HR_ADMIN" && actor.role !== "SUPER_ADMIN") {
        throw forbidden("Only HR can send a profile back");
    }
    const employee = await findUserById(employeeId);
    if (!employee || !(await isInActorsHrScope(actor, employeeId))) {
        throw notFound("Employee not found");
    }

    const newStatus = assertLegalProfileTransition("SEND_BACK", employee.profile_status);
    await updateProfileStatus(employeeId, {
        status: newStatus,
        sendBackReason: reason,
        sendBackBy: actor.id,
        sendBackAt: new Date(),
    });
    await notifyProfileSentBack(employeeId, actor.id, reason); // non-critical side effect
    return findUserById(employeeId);
}

// A single employee's full profile for HR's verification detail page.
// Deliberately its own function rather than reusing GET /api/users/:id
// (requireUserScope) — that route lets *any* HR_ADMIN view *any* user
// company-wide, which doesn't match the "each HR admin owns their own
// branch" rule every other HR-scoped action here enforces via
// isInActorsHrScope (documents, salary structures, verify/send-back above).
// Never masked: the caller is always HR-tier by this point, and masking
// only ever applies to a manager viewing a report.
export async function getEmployeeForVerification(actor, employeeId) {
    if (actor.role !== "HR_ADMIN" && actor.role !== "SUPER_ADMIN") {
        throw forbidden("Only HR can view an employee's profile for verification");
    }
    const employee = await findUserById(employeeId);
    if (!employee || !(await isInActorsHrScope(actor, employeeId))) {
        throw notFound("Employee not found");
    }
    return employee;
}

// HR's queue of profiles awaiting review, scoped to their own HR scope
// (HR_ADMIN's subtree, or SUPER_ADMIN's direct-report HR_ADMINs only).
export async function listPendingVerification(actor) {
    if (actor.role !== "HR_ADMIN" && actor.role !== "SUPER_ADMIN") {
        throw forbidden("Only HR can view the verification queue");
    }
    const employeeIds = await getHrScopedEmployeeIds(actor);
    return findEmployeesPendingVerification(employeeIds);
}

// The "Verified Employees" section on the same page — everyone in HR's scope
// whose profile has already reached VERIFIED, so HR can jump back into an
// already-verified employee's details (e.g. to adjust their salary
// structure) without hunting through "All Employees".
export async function listVerifiedEmployees(actor) {
    if (actor.role !== "HR_ADMIN" && actor.role !== "SUPER_ADMIN") {
        throw forbidden("Only HR can view verified employees");
    }
    const employeeIds = await getHrScopedEmployeeIds(actor);
    return findVerifiedEmployees(employeeIds);
}

// Input: the caller's own id, current + new plaintext passwords. Output:
// nothing — throws 401 if the current password doesn't match (same
// `verifyPassword` used by login, which already treats a missing hash as
// "never matches"). Reuses hashPassword exactly as passwordResetService.js
// does for the forgot-password flow.
export async function changeMyPassword(actorId, { currentPassword, newPassword }) {
    const passwordHash = await findPasswordHashById(actorId);
    if (!(await verifyPassword(currentPassword, passwordHash))) {
        throw unauthorized("Current password is incorrect");
    }
    const newHash = await hashPassword(newPassword);
    await updatePasswordHash(actorId, newHash);
}

// Auth is strict per-team, not "any HR admin can manage everyone" — but
// "per-team" now means the acting HR admin's own reporting subtree, not only
// the accounts they personally created. Either grants the edit:
//
//   1. `actor.id === target.invited_by` — whoever created the account.
//   2. `isInActorsHrScope(actor, id)` — the target sits inside the actor's
//      own HR scope (an HR_ADMIN's subtree; SUPER_ADMIN's direct-report
//      HR_ADMINs only, see hrScopeService.js).
//
// (2) was added on direct request, so HR can manage everyone on their own
// team from My Team — creator-only meant no controls at all for anyone HR
// inherited rather than invited (another HR admin's joiner, or any account
// predating the invitation records), which read as a missing feature.
//
// What it deliberately still refuses is unchanged and is the point of the
// check: an HR admin cannot touch a *different branch's* people, since a
// subtree walk never reaches sideways or upward — so SUPER_ADMIN can't be
// re-parented or deactivated from below either (nobody's subtree contains
// the root), which used to be guaranteed by the "no `invited_by`" rule.
export async function changeManager(id, managerId, actor) {
    const target = await getUserById(id, actor);

    if (actor.id !== target.invited_by && !(await isInActorsHrScope(actor, id))) {
        throw forbidden("You can only change the reporting line of someone on your own team");
    }

    await assertNoCycle(id, managerId, target.role);
    const updated = await updateManager(id, managerId);
    if (!updated) {
        throw notFound("User not found");
    }

    // Non-critical side effects — only fire when this actually assigns a
    // *new* manager (not a no-op re-save of the same one), and never for a
    // reassignment straight to `null` (nobody to tell "you now report to").
    if (managerId && managerId !== target.manager_id) {
        await notifyManagerReassigned(target, managerId, actor.id);
        await notifyTeamMemberAssigned(target, managerId, actor.id);
    }

    return getUserById(id, actor);
}

// Activating/deactivating a user takes the same two-way check as
// changeManager above — the account's creator, or an HR-tier actor whose own
// scope contains them — for every role. Any HR admin can still *see*
// everyone (listUsersFor); this governs who may toggle a status.
export async function changeStatus(id, status, actor) {
    if (id === actor.id && status === "INACTIVE") {
        throw badRequest("You cannot deactivate your own account");
    }

    const target = await getUserById(id, actor);
    if (actor.id !== target.invited_by && !(await isInActorsHrScope(actor, id))) {
        throw forbidden("You can only change the status of someone on your own team");
    }

    const updated = await updateStatus(id, status);
    if (!updated) {
        throw notFound("User not found");
    }
    await notifyAccountStatusChanged(id, status, actor.id); // non-critical side effect
    return getUserById(id, actor);
}
