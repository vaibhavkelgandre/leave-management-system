import { findRoleByName } from "../../../repositories/roleRepository.js";
import { insertUser, updateProfileStatus } from "../../../repositories/userRepository.js";
import { insertInvitation } from "../../../repositories/invitationRepository.js";
import { insertLeaveType } from "../../../repositories/leaveTypeRepository.js";
import {
    findDocumentsByEmployeeId,
    updateDocumentReview,
} from "../../../repositories/employeeDocumentRepository.js";
import { insertHoliday } from "../../../repositories/holidayRepository.js";
import { insertDelegation } from "../../../repositories/delegationRepository.js";
import { upsertStructure } from "../../../repositories/salaryStructureRepository.js";
import { replaceSlipsForPeriod, voidSlip } from "../../../repositories/salarySlipRepository.js";
import { submitLeaveRequest } from "../../../services/leaveRequestService.js";
import { hashPassword } from "../../../utils/password.js";

export const DEFAULT_PASSWORD = "Password123!";

// `invitedBy`: when given, backs an `invitations` row for this user so tests
// can set up "who created this HR admin" (userRepository.js's `invited_by`
// column, used by userService.changeManager to restrict who may edit an
// HR_ADMIN's own reporting line) without going through the full HTTP invite
// flow. A fake unique token is fine — nothing in these tests ever redeems it.
export async function createUser({
    role = "EMPLOYEE",
    managerId = null,
    firstName = "Test",
    lastName = "User",
    email,
    password = DEFAULT_PASSWORD,
    status = "ACTIVE",
    invitedBy = null,
} = {}) {
    const roleRecord = await findRoleByName(role);
    const passwordHash = password ? await hashPassword(password) : null;

    const user = await insertUser({
        firstName,
        lastName,
        email: email || `${firstName.toLowerCase()}.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`,
        passwordHash,
        roleId: roleRecord.id,
        managerId,
        status,
    });

    if (invitedBy) {
        await insertInvitation({
            userId: user.id,
            tokenHash: `test-token-${user.id}-${Math.random().toString(36).slice(2)}`,
            invitedBy,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
    }

    return { ...user, role, password };
}

// A manager-less "root of a branch" HR_ADMIN fixture — distinct from
// SUPER_ADMIN below. Most tests use this purely as a generic top-of-branch
// HR fixture, not to exercise POST /auth/register/hr itself (which now only
// ever produces SUPER_ADMIN, singleton-guarded — see authRegisterHr.test.js).
export async function createRootHr(overrides = {}) {
    return createUser({ role: "HR_ADMIN", managerId: null, ...overrides });
}

// The single top-of-tree SUPER_ADMIN fixture, mirroring what
// authService.registerHrRoot actually produces (manager-less, profile
// VERIFIED at creation — see authRegisterHr.test.js for the real bootstrap
// endpoint's own tests).
export async function createSuperAdmin(overrides = {}) {
    const user = await createUser({ role: "SUPER_ADMIN", managerId: null, ...overrides });
    await updateProfileStatus(user.id, { status: "VERIFIED" });
    return { ...user, profile_status: "VERIFIED" };
}

export async function createInvitedUser(overrides = {}) {
    return createUser({ status: "INVITED", password: null, ...overrides });
}

export async function createLeaveType({
    name = `Leave Type ${Date.now()}.${Math.random().toString(36).slice(2)}`,
    annualEntitlement = 12,
    accrualType = "UPFRONT",
    allowNegativeBalance = false,
    requiresDocument = false,
    countsAsLop = false,
} = {}) {
    return insertLeaveType({ name, annualEntitlement, accrualType, allowNegativeBalance, requiresDocument, countsAsLop });
}

// Test-only shortcut past the full onboarding flow (fill profile -> upload
// documents -> HR verifies) — sets profile_status straight to VERIFIED via
// the repository, for tests that only care about payroll-readiness, not the
// verification workflow itself (see profileVerification.test.js for that).
// Marks every required document VERIFIED, the same end state HR reaches by
// reviewing them one at a time. Needed because POST /employees/:id/verify
// now refuses while any required document is still PENDING_REVIEW or
// REJECTED (userService.verifyProfile) — so tests about the *profile*
// transition would otherwise all have to drive four review requests each to
// set up a state they aren't testing. Tests of the review endpoint itself
// still go through HTTP (employeeDocuments.test.js).
export async function verifyAllEmployeeDocuments(employeeId, reviewedBy) {
    const documents = await findDocumentsByEmployeeId(employeeId);
    for (const document of documents.filter((row) => row.document_type !== "OTHER")) {
        await updateDocumentReview(document.id, { status: "VERIFIED", reviewedBy, reviewComment: null });
    }
}

export async function verifyEmployeeProfile(employeeId, verifiedBy) {
    return updateProfileStatus(employeeId, { status: "VERIFIED", verifiedBy, verifiedAt: new Date() });
}

// Test-only shortcut for assigning a salary structure directly, mirroring
// salaryStructureService.assignStructure's repository call without going
// through the HTTP layer's auth check.
export async function createSalaryStructure({
    employeeId,
    basicSalary = 30000,
    hra = 12000,
    pfEmployeeContribution = 1800,
    pfEmployerContribution = 1800,
    esic = 0,
    specialAllowance = 5000,
    incomeTax = 0,
    actorId,
} = {}) {
    return upsertStructure({
        employeeId,
        basicSalary,
        hra,
        pfEmployeeContribution,
        pfEmployerContribution,
        esic,
        specialAllowance,
        incomeTax,
        actorId,
    });
}

export async function createHoliday({ name = "Test Holiday", startDate = "2026-01-01", endDate } = {}) {
    return insertHoliday({ name, startDate, endDate: endDate || startDate });
}

// Goes through the real service (not a direct repository insert) so a test's
// setup produces the same ledger/audit side effects a real submission would
// — anything asserting on balance state after further actions needs that.
export async function createLeaveRequest({
    employeeId,
    leaveTypeId,
    startDate = "2027-02-01",
    endDate = "2027-02-01",
    startHalfDay = false,
    endHalfDay = false,
    reason = "Test reason",
} = {}) {
    return submitLeaveRequest(employeeId, { leaveTypeId, startDate, endDate, startHalfDay, endHalfDay, reason });
}

export async function createDelegation({
    managerId,
    delegateId,
    startDate = "2027-01-01",
    endDate = "2027-01-31",
} = {}) {
    return insertDelegation({ managerId, delegateId, startDate, endDate });
}

// An issued payslip for one employee and period, written straight through the
// repository.
//
// Input: `{ employeeId, payPeriod, lopDays, netPay, actorId }`. Output: the
// created slip row.
//
// Deliberately not driven through confirmPayroll: that route needs a completed
// period, a verified profile and a salary structure, none of which a test of
// the payroll *lock* cares about — it only needs an ACTIVE slip to exist. Tests
// of payroll generation itself still go through the service.
export async function createSalarySlip({
    employeeId,
    payPeriod = "2026-07",
    lopDays = 0,
    netPay = 45825,
    actorId,
} = {}) {
    const [slip] = await replaceSlipsForPeriod({
        payPeriod,
        actorId: actorId || employeeId,
        rows: [
            {
                employeeId,
                basicPay: 30000,
                hra: 12000,
                pfEmployeeContribution: 1800,
                pfEmployerContribution: 1800,
                esic: 375,
                specialAllowance: 8000,
                lopDays,
                lopDeduction: 0,
                totalLeaveDays: lopDays,
                payableDays: 31 - lopDays,
                incomeTax: 2000,
                netPay,
            },
        ],
    });
    return slip;
}

// Voids a slip, which is what reopens a locked period.
// Input: a slip id and the actor doing it. Output: the voided row.
export async function voidSalarySlip(slipId, actorId, reason = "Test void") {
    return voidSlip(slipId, { voidedBy: actorId, reason });
}
