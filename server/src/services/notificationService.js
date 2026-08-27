// In-app notification system: business logic for both halves of the
// feature — the read/write API a logged-in user's own bell/notifications
// page calls (listNotifications/getUnreadCount/markAsRead/markAllAsRead),
// and the internal notify* helpers every other service calls right after a
// state-changing action succeeds (leaveRequestService, userService,
// salarySlipService). Recipient resolution reuses the existing reporting-
// chain helper (userRepository.findReportingLine) rather than adding new
// tree-walking logic — see the comment on resolveManagerOrNearestHrAncestor
// below for why that one query answers both "who's this employee's manager"
// and "who's their nearest HR ancestor" depending on how far up it's read.
import { findReportingLine, findUserById } from "../repositories/userRepository.js";
import {
    insertNotification,
    findNotificationsForUser,
    countTotalForUser,
    countUnreadForUser,
    findNotificationById,
    markRead,
    markAllRead,
    existsNotificationCreatedToday,
} from "../repositories/notificationRepository.js";
import { notFound } from "../utils/appError.js";
import { formatPayPeriod } from "../utils/payPeriod.js";

const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 20;

// -----------------------------------------------------------------------
// Read/write API surface — called from notificationController.js.
// -----------------------------------------------------------------------

// Input: the authenticated actor and `{ unreadOnly, limit, offset }`.
// Output: `{ notifications, total }` for that actor's own notifications,
// newest first. `limit` is clamped to [1, 50] regardless of what's passed —
// belt-and-suspenders alongside notificationValidator.js's own max(50), so
// this stays safe even if called directly (e.g. from a test) without going
// through the validator.
export async function listNotifications(actor, { unreadOnly = false, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
    const clampedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const clampedOffset = Math.max(Number(offset) || 0, 0);

    const [notifications, total] = await Promise.all([
        findNotificationsForUser(actor.id, { unreadOnly, limit: clampedLimit, offset: clampedOffset }),
        countTotalForUser(actor.id, { unreadOnly }),
    ]);

    return { notifications, total };
}

// Output: the actor's own unread count — backs the nav bell's badge.
export async function getUnreadCount(actor) {
    return countUnreadForUser(actor.id);
}

// Input: the actor and a notification id. Output: the now-read notification.
// Failure mode: 404 if the id doesn't exist or belongs to someone else —
// same "don't reveal existence to a non-owner" policy as every other
// per-record endpoint in this app (NFR-5). Idempotent: marking an
// already-read notification again just returns it unchanged.
export async function markAsRead(actor, id) {
    const notification = await findNotificationById(id);
    if (!notification || notification.recipient_id !== actor.id) {
        throw notFound("Notification not found");
    }
    return markRead(id);
}

// Output: `{ updated }` — how many of the actor's own notifications were
// actually flipped from unread to read.
export async function markAllAsRead(actor) {
    const updated = await markAllRead(actor.id);
    return { updated };
}

// -----------------------------------------------------------------------
// Recipient resolution — shared by the notify* helpers below.
// -----------------------------------------------------------------------

// Input: an employee id. Output: the id of who should hear about something
// this employee did — their direct manager if `manager_id` is set, or (per
// the confirmed product decision) nobody extra beyond that: this app's
// reporting rule already guarantees that when an employee has *no* manager,
// their `manager_id` points straight at an HR_ADMIN instead (see
// reportingService.ALLOWED_MANAGER_ROLES in rules.md) — so the first entry
// in the reporting chain (depth 1) is always the right single recipient,
// whether that's a MANAGER or the HR admin they report straight to. Returns
// null only for someone with no manager_id at all (e.g. a root HR_ADMIN
// nobody reports notifications to), in which case the caller skips creating
// a notification entirely.
async function resolveManagerOrNearestHrAncestor(employeeId) {
    const chain = await findReportingLine(employeeId);
    return chain[0]?.id ?? null;
}

// Input: an employee id. Output: the id of the nearest HR-tier ancestor
// walking up the reporting chain — unlike the helper above, this skips past
// any MANAGER links to find who should hear about something that
// specifically needs HR's attention (e.g. a profile submitted for
// verification). Matches SUPER_ADMIN as well as HR_ADMIN: an HR_ADMIN whose
// only ancestor is SUPER_ADMIN (no HR_ADMIN above them at all) still needs
// their profile-submitted notification to reach *someone* — without this,
// the chain search would find nothing and this would silently return null.
// Returns null in the defensive case where the chain has neither role at all.
//
// `excludeId` skips one specific person on the way up, and exists for exactly
// one case: an escalated leave request must reach an HR admin *other than* the
// manager it was escalated past. When an employee reports straight to HR, that
// away manager is themselves the nearest HR ancestor, so without this the
// escalation would be delivered to the person who is unavailable — the opposite
// of what it is for.
async function resolveNearestHrAncestor(employeeId, { excludeId = null } = {}) {
    const chain = await findReportingLine(employeeId);
    return (
        chain.find(
            (person) =>
                person.id !== excludeId && (person.role === "HR_ADMIN" || person.role === "SUPER_ADMIN")
        )?.id ?? null
    );
}

// -----------------------------------------------------------------------
// notify* helpers — called by other services right after their own
// state-changing write succeeds. Every one of these swallows its own
// failure (logged, not rethrown): a notification is a side effect of the
// real action, never a reason for the real action to fail.
// -----------------------------------------------------------------------

// Input: the newly submitted leave request (joined shape from
// leaveRequestRepository.findLeaveRequestById — has employee_first_name/
// employee_last_name/leave_type_name). Notifies the employee's manager (or
// their nearest HR ancestor if they report straight to HR).
export async function notifyLeaveRequestSubmitted(request) {
    try {
        const recipientId = await resolveManagerOrNearestHrAncestor(request.employee_id);
        if (!recipientId) return;

        const employeeName = `${request.employee_first_name} ${request.employee_last_name}`;
        await insertNotification({
            recipientId,
            actorId: request.employee_id,
            type: "LEAVE_REQUEST_SUBMITTED",
            entityType: "LEAVE_REQUEST",
            entityId: request.id,
            message: `${employeeName} submitted a ${request.leave_type_name} request`,
        });
    } catch (error) {
        console.error("Failed to create LEAVE_REQUEST_SUBMITTED notification:", error.message);
    }
}

// Input: the newly submitted leave request (same joined shape as
// notifyLeaveRequestSubmitted) and the id of the manager it was escalated past.
// Notifies the nearest HR-tier ancestor *above* that manager — never the
// manager themselves, who is away covering-wise and is the reason this was
// escalated at all.
//
// Called instead of notifyLeaveRequestSubmitted, not alongside it: this request
// is HR's to decide (leaveRequestService.resolveActingCapacity), and telling the
// away manager as well would ask two people for one decision. The manager still
// sees it in their own approvals list when they return, and can still decide it
// if HR has not.
//
// Reuses the LEAVE_REQUEST_SUBMITTED type deliberately rather than adding a new
// one — the recipient's action is identical (go to Approvals and decide it), and
// notificationRouting.js already sends that type there. Only the wording
// differs, because *why* it landed with HR is the part that needs explaining.
export async function notifyLeaveRequestEscalatedToHr(request, awayManagerId) {
    try {
        const recipientId = await resolveNearestHrAncestor(request.employee_id, { excludeId: awayManagerId });
        if (!recipientId) return;

        const employeeName = `${request.employee_first_name} ${request.employee_last_name}`;
        const managerName = request.manager_first_name
            ? `${request.manager_first_name} ${request.manager_last_name}`
            : "their manager";

        await insertNotification({
            recipientId,
            actorId: request.employee_id,
            type: "LEAVE_REQUEST_SUBMITTED",
            entityType: "LEAVE_REQUEST",
            entityId: request.id,
            message: `${employeeName} submitted a ${request.leave_type_name} request while covering approvals for ${managerName}, so it needs your decision`,
        });
    } catch (error) {
        console.error("Failed to create escalated LEAVE_REQUEST_SUBMITTED notification:", error.message);
    }
}

// Input: a delegation row whose window starts in the future (joined against the
// manager's name, from delegationRepository.findDelegationsForDelegateOverlapping)
// and the leave request that was just submitted over it.
//
// Notifies **both** sides, with different wording, following the
// MANAGER_REASSIGNED/TEAM_MEMBER_ASSIGNED precedent for one event that two
// people need to hear about differently:
//   - the delegate, because they may not remember being nominated, and the
//     resolution is theirs to start — there is no accept/reject flow, so
//     "contact your manager" is literally the only route available to them;
//   - the nominating manager, because they are about to have no cover and would
//     otherwise only find out if the employee remembers to tell them. The
//     mirror-image clash (nominating someone whose leave is already booked) is
//     refused outright in delegationService, so leaving the manager uninformed
//     here would close one direction of the same hole and leave the other open.
export async function notifyDelegationLeaveConflict(delegation, request) {
    try {
        const employeeName = `${request.employee_first_name} ${request.employee_last_name}`;

        await insertNotification({
            recipientId: delegation.delegate_id,
            actorId: request.employee_id,
            type: "DELEGATION_LEAVE_CONFLICT",
            entityType: "DELEGATION",
            entityId: delegation.id,
            message:
                `You are the selected delegate for ${delegation.manager_first_name} ${delegation.manager_last_name} ` +
                `from ${delegation.start_date} to ${delegation.end_date}, which overlaps this leave. ` +
                `If you are not available to cover approvals, contact your manager.`,
        });

        await insertNotification({
            recipientId: delegation.manager_id,
            actorId: request.employee_id,
            type: "DELEGATION_LEAVE_CONFLICT",
            entityType: "DELEGATION",
            entityId: delegation.id,
            message:
                `${employeeName}, your delegate from ${delegation.start_date} to ${delegation.end_date}, ` +
                `has requested leave from ${request.start_date} to ${request.end_date}, which overlaps that cover.`,
        });
    } catch (error) {
        console.error("Failed to create DELEGATION_LEAVE_CONFLICT notification:", error.message);
    }
}

// Input: the decided request (joined shape, post-transition), the state-
// machine action taken (APPROVE/REJECT/HR_OVERRIDE_TO_APPROVED/
// HR_OVERRIDE_TO_REJECTED), and the deciding actor's id. Notifies the
// employee only — not the manager an HR override supersedes, a deliberate
// v1 scope decision (see the plan's edge-cases section).
export async function notifyLeaveRequestDecided(request, action, actorId) {
    try {
        const approved = action === "APPROVE" || action === "HR_OVERRIDE_TO_APPROVED";
        const isOverride = action === "HR_OVERRIDE_TO_APPROVED" || action === "HR_OVERRIDE_TO_REJECTED";
        const outcome = approved ? "approved" : "rejected";
        const suffix = isOverride ? " (HR override)" : "";

        await insertNotification({
            recipientId: request.employee_id,
            actorId,
            type: "LEAVE_REQUEST_DECIDED",
            entityType: "LEAVE_REQUEST",
            entityId: request.id,
            message: `Your ${request.leave_type_name} request was ${outcome}${suffix}`,
        });
    } catch (error) {
        console.error("Failed to create LEAVE_REQUEST_DECIDED notification:", error.message);
    }
}

// Input: the withdrawn/cancelled request (joined shape) and the action
// (WITHDRAW/CANCEL — always self-initiated per resolveActingCapacity, so
// the employee is always both the actor and the request owner here).
// Notifies the same recipient submission would have gone to (manager, or
// nearest HR ancestor if none) — the person who'd otherwise still think
// this request needs their attention.
export async function notifyLeaveRequestWithdrawnOrCancelled(request, action) {
    try {
        const recipientId = await resolveManagerOrNearestHrAncestor(request.employee_id);
        if (!recipientId) return;

        const employeeName = `${request.employee_first_name} ${request.employee_last_name}`;
        const verb = action === "WITHDRAW" ? "withdrew" : "cancelled";
        await insertNotification({
            recipientId,
            actorId: request.employee_id,
            type: "LEAVE_REQUEST_WITHDRAWN_CANCELLED",
            entityType: "LEAVE_REQUEST",
            entityId: request.id,
            message: `${employeeName} ${verb} their ${request.leave_type_name} request`,
        });
    } catch (error) {
        console.error("Failed to create LEAVE_REQUEST_WITHDRAWN_CANCELLED notification:", error.message);
    }
}

// Input: the employee's full user row (as already fetched by
// userService.submitProfileForVerification). Notifies their nearest HR
// ancestor — the one who'll actually review it (isUserInSubtree gates who
// can verify/send back, so only the branch's own HR needs to hear about it).
export async function notifyProfileSubmitted(employee) {
    try {
        const recipientId = await resolveNearestHrAncestor(employee.id);
        if (!recipientId) return;

        await insertNotification({
            recipientId,
            actorId: employee.id,
            type: "PROFILE_SUBMITTED",
            entityType: "PROFILE",
            entityId: employee.id,
            message: `${employee.first_name} ${employee.last_name} submitted their profile for verification`,
        });
    } catch (error) {
        console.error("Failed to create PROFILE_SUBMITTED notification:", error.message);
    }
}

// Input: the now-verified employee's id and the HR actor who verified them.
export async function notifyProfileVerified(employeeId, actorId) {
    try {
        await insertNotification({
            recipientId: employeeId,
            actorId,
            type: "PROFILE_VERIFIED",
            entityType: "PROFILE",
            entityId: employeeId,
            message: "Your profile has been verified",
        });
    } catch (error) {
        console.error("Failed to create PROFILE_VERIFIED notification:", error.message);
    }
}

// Input: the employee's id, the HR actor who sent it back, and the required
// reason (sendProfileBackSchema already guarantees a non-empty reason).
export async function notifyProfileSentBack(employeeId, actorId, reason) {
    try {
        await insertNotification({
            recipientId: employeeId,
            actorId,
            type: "PROFILE_SENT_BACK",
            entityType: "PROFILE",
            entityId: employeeId,
            message: `Your profile was sent back: ${reason}`,
        });
    } catch (error) {
        console.error("Failed to create PROFILE_SENT_BACK notification:", error.message);
    }
}

// Input: the rows salarySlipService.confirmPayroll actually committed (each
// has `id`/`employee_id` — see salarySlipRepository.replaceSlipsForPeriod's
// RETURNING list), the pay period, and the HR actor who ran payroll. Only
// committed rows generate a notification — a `skipped` row (no salary
// structure assigned) never got a slip, so there's nothing to tell that
// employee about. Each row is notified independently so one bad recipient
// lookup can't stop the rest of the batch from being notified.
export async function notifySalarySlipsGenerated(committedRows, payPeriod, actorId) {
    const periodLabel = formatPayPeriod(payPeriod);

    for (const row of committedRows) {
        try {
            await insertNotification({
                recipientId: row.employee_id,
                actorId,
                type: "SALARY_SLIP_GENERATED",
                entityType: "SALARY_SLIP",
                entityId: row.id,
                message: `Your salary slip for ${periodLabel} is available`,
            });
        } catch (error) {
            console.error("Failed to create SALARY_SLIP_GENERATED notification:", error.message);
        }
    }
}

// Input: the voided slip (joined shape from salarySlipRepository.voidSlip's
// RETURNING list — has `id`/`employee_id`/`pay_period`), the void reason,
// and the HR actor who voided it.
export async function notifySalarySlipVoided(slip, reason, actorId) {
    try {
        const periodLabel = formatPayPeriod(slip.pay_period);
        await insertNotification({
            recipientId: slip.employee_id,
            actorId,
            type: "SALARY_SLIP_VOIDED",
            entityType: "SALARY_SLIP",
            entityId: slip.id,
            message: `Your salary slip for ${periodLabel} was voided${reason ? `: ${reason}` : ""}`,
        });
    } catch (error) {
        console.error("Failed to create SALARY_SLIP_VOIDED notification:", error.message);
    }
}

// Input: the employee's full user row (as already fetched by
// userService.changeManager) and their new manager's id. Notifies the
// employee only — the flip side, telling the new manager, is
// notifyTeamMemberAssigned below (a separate call, since the two recipients
// want differently-worded messages, not two copies of the same one).
export async function notifyManagerReassigned(employee, newManagerId, actorId) {
    try {
        const newManager = await findUserById(newManagerId);
        if (!newManager) return;

        await insertNotification({
            recipientId: employee.id,
            actorId,
            type: "MANAGER_REASSIGNED",
            entityType: "PROFILE",
            entityId: employee.id,
            message: `You now report to ${newManager.first_name} ${newManager.last_name}`,
        });
    } catch (error) {
        console.error("Failed to create MANAGER_REASSIGNED notification:", error.message);
    }
}

// Input: the employee's full user row and the manager id they're now
// assigned to. Shared by two trigger points: userService.changeManager (an
// existing employee reassigned) and invitationService.inviteEmployee (a new
// invite created with a manager already picked) — both are "this person is
// now on your team" from the manager's point of view, so one message covers both.
export async function notifyTeamMemberAssigned(employee, managerId, actorId) {
    try {
        await insertNotification({
            recipientId: managerId,
            actorId,
            type: "TEAM_MEMBER_ASSIGNED",
            entityType: "PROFILE",
            entityId: employee.id,
            message: `${employee.first_name} ${employee.last_name} now reports to you`,
        });
    } catch (error) {
        console.error("Failed to create TEAM_MEMBER_ASSIGNED notification:", error.message);
    }
}

// Input: the employee's id and the HR actor who assigned/edited their
// salary structure. Deliberately doesn't include any figures in the message
// — a notification list is glanced at casually, not a place to surface pay
// amounts.
export async function notifySalaryStructureUpdated(employeeId, actorId) {
    try {
        await insertNotification({
            recipientId: employeeId,
            actorId,
            type: "SALARY_STRUCTURE_UPDATED",
            entityType: "PROFILE",
            entityId: employeeId,
            message: "Your salary structure has been updated by HR",
        });
    } catch (error) {
        console.error("Failed to create SALARY_STRUCTURE_UPDATED notification:", error.message);
    }
}

// Input: the employee's id, their new status ("ACTIVE"/"INACTIVE"), and the
// HR actor who changed it.
export async function notifyAccountStatusChanged(employeeId, newStatus, actorId) {
    try {
        const message = newStatus === "ACTIVE" ? "Your account has been activated" : "Your account has been deactivated";
        await insertNotification({
            recipientId: employeeId,
            actorId,
            type: "ACCOUNT_STATUS_CHANGED",
            entityType: "PROFILE",
            entityId: employeeId,
            message,
        });
    } catch (error) {
        console.error("Failed to create ACCOUNT_STATUS_CHANGED notification:", error.message);
    }
}

// Input: the newly created delegation (joined shape from
// delegationRepository.insertDelegation — has `manager_id`/`delegate_id`).
// Notifies the delegate — the one thing FR-020's original design never told
// them; they otherwise only find out by checking GET /delegations/as-delegate
// or the dashboard tile.
export async function notifyDelegationNominated(delegation) {
    try {
        const manager = await findUserById(delegation.manager_id);
        if (!manager) return;

        await insertNotification({
            recipientId: delegation.delegate_id,
            actorId: delegation.manager_id,
            type: "DELEGATION_NOMINATED",
            entityType: "DELEGATION",
            entityId: delegation.id,
            message: `${manager.first_name} ${manager.last_name} nominated you as their delegate from ${delegation.start_date} to ${delegation.end_date}`,
        });
    } catch (error) {
        console.error("Failed to create DELEGATION_NOMINATED notification:", error.message);
    }
}

// Input: a delegation row from delegationRepository.findDelegationsStartingOn
// (has delegate_first_name/delegate_last_name joined already). Notifies the
// manager. Time-based, not event-driven — called from
// notificationSweepService.js, which can run more than once on the same
// calendar day (e.g. an hourly sweep, or a server restart), so this
// dedupes via existsNotificationCreatedToday rather than assuming it's only
// ever called once per transition.
// Tells the two people who can still act that a request has been sitting
// undecided since well after the leave happened: the manager, who can decide
// it, and the employee, who can withdraw it.
//
// Input: a row from findOverdueSubmittedRequests, and how many days overdue it
// is. Output: none. Never throws — a notification is a side effect of the
// sweep, not its purpose.
//
// Two recipients, two wordings, because the useful next step differs: the
// manager needs to decide, the employee needs to know they can withdraw and
// get their pending days back. Deduped per day via
// existsNotificationCreatedToday, since the sweep runs hourly and a restart
// re-runs it — without that, an overdue request would notify twenty-four times
// a day, forever.
// Tells an employee that HR changed one of their employment dates.
//
// Input: the employee's id, the acting HR user's id, and which change it was
// ("dates" for a plain edit, "exit" when a leaving day was recorded). Output:
// none. Never throws.
//
// Deliberately quotes **no dates and no figures**, following
// notifySalaryStructureUpdated's restraint for the same reason: a notification
// list is glanced at casually and often with someone else looking at the
// screen, and "your last working day is 10 July" is not something to put there.
// The employee's profile page has the actual values.
// Tells an employee that a leave request of theirs has been recounted after a
// public holiday changed.
//
// Input: the request row (carrying the employee and leave type name), the old
// and new working-day counts, and the acting HR user. Output: none. Never
// throws.
//
// The figures *are* quoted here, unlike notifyEmploymentDatesUpdated — because
// the whole point is that a number they were previously told has changed, and
// "your leave was recounted" without saying from what to what is not
// actionable. Leave day counts are also not sensitive in the way a salary is.
export async function notifyLeaveDaysAdjusted(request, previousDays, newDays, actorId) {
    try {
        const direction = newDays < previousDays ? "returned to your balance" : "deducted from your balance";
        const difference = Math.abs(newDays - previousDays);

        await insertNotification({
            recipientId: request.employee_id,
            actorId,
            type: "LEAVE_DAYS_ADJUSTED",
            entityType: "LEAVE_REQUEST",
            entityId: request.id,
            message: `A public holiday changed within your ${request.leave_type_name} leave (${request.start_date} to ${request.end_date}). It now counts ${newDays} working day(s) instead of ${previousDays}, so ${difference} day(s) have been ${direction}.`,
        });
    } catch (error) {
        console.error("Failed to create LEAVE_DAYS_ADJUSTED notification:", error.message);
    }
}

export async function notifyEmploymentDatesUpdated(employeeId, actorId, change = "dates") {
    try {
        const message =
            change === "exit"
                ? "HR recorded your last working day. Your profile shows the details, and any affected payslip has been updated."
                : "HR updated your employment dates. Your profile shows the current values.";

        await insertNotification({
            recipientId: employeeId,
            actorId,
            type: "EMPLOYMENT_DATES_UPDATED",
            entityType: "PROFILE",
            entityId: employeeId,
            message,
        });
    } catch (error) {
        console.error("Failed to create EMPLOYMENT_DATES_UPDATED notification:", error.message);
    }
}

export async function notifyLeaveRequestOverdue(request, daysOverdue) {
    try {
        const employeeName = `${request.employee_first_name} ${request.employee_last_name}`.trim();
        // Raw date keys, matching notifyDelegationNominated's existing wording
        // convention in this file rather than introducing a second date style.
        const dates = `${request.start_date} to ${request.end_date}`;

        // Two types rather than one shared type, following the
        // MANAGER_REASSIGNED / TEAM_MEMBER_ASSIGNED precedent: the wording
        // differs, and so does where a click should land.
        // notificationRouting.js maps type -> destination with no knowledge of
        // the viewer's role, so a shared type would send one of these two
        // audiences to the wrong page — and an employee sent to
        // /dashboard/approvals is bounced to /403.
        //
        // Each type is deduped independently: they are separate rows with
        // separate read state, and a manager with no manager_id of their own
        // must not suppress the employee's copy.
        if (
            request.employee_manager_id &&
            !(await existsNotificationCreatedToday("LEAVE_REQUEST_OVERDUE", request.id))
        ) {
            await insertNotification({
                recipientId: request.employee_manager_id,
                actorId: request.employee_id,
                type: "LEAVE_REQUEST_OVERDUE",
                entityType: "LEAVE_REQUEST",
                entityId: request.id,
                message: `${employeeName}'s ${request.leave_type_name} request for ${dates} has been waiting ${daysOverdue} days for your decision`,
            });
        }

        if (!(await existsNotificationCreatedToday("LEAVE_REQUEST_AWAITING_DECISION", request.id))) {
            await insertNotification({
                recipientId: request.employee_id,
                actorId: request.employee_id,
                type: "LEAVE_REQUEST_AWAITING_DECISION",
                entityType: "LEAVE_REQUEST",
                entityId: request.id,
                message: `Your ${request.leave_type_name} request for ${dates} is still undecided after ${daysOverdue} days. Withdraw it to return the days to your balance, or ask your manager to decide it.`,
            });
        }
    } catch (error) {
        console.error("Failed to create overdue leave request notifications:", error.message);
    }
}

export async function notifyDelegationStarted(delegation) {
    try {
        if (await existsNotificationCreatedToday("DELEGATION_STARTED", delegation.id)) return;

        const delegateName = `${delegation.delegate_first_name} ${delegation.delegate_last_name}`;
        await insertNotification({
            recipientId: delegation.manager_id,
            actorId: delegation.delegate_id,
            type: "DELEGATION_STARTED",
            entityType: "DELEGATION",
            entityId: delegation.id,
            message: `${delegateName} begins covering your approvals today`,
        });
    } catch (error) {
        console.error("Failed to create DELEGATION_STARTED notification:", error.message);
    }
}

// The flip side of notifyDelegationStarted, from
// delegationRepository.findDelegationsEndingOn — same dedupe reasoning.
export async function notifyDelegationEnded(delegation) {
    try {
        if (await existsNotificationCreatedToday("DELEGATION_ENDED", delegation.id)) return;

        const delegateName = `${delegation.delegate_first_name} ${delegation.delegate_last_name}`;
        await insertNotification({
            recipientId: delegation.manager_id,
            actorId: delegation.delegate_id,
            type: "DELEGATION_ENDED",
            entityType: "DELEGATION",
            entityId: delegation.id,
            message: `${delegateName}'s coverage of your approvals has ended today`,
        });
    } catch (error) {
        console.error("Failed to create DELEGATION_ENDED notification:", error.message);
    }
}

// Input: the newly activated user's id and the actor (always the accepting
// user themself — there's no HR actor in the loop at accept time). Notifies
// whoever invited them (`invited_by`, resolved fresh via findUserById since
// neither invitationRepository.findActiveByTokenHash nor
// setPasswordHashAndActivate's RETURNING list carries it). Skips silently if
// somehow there's no inviter on record (shouldn't happen — every invite sets
// `invited_by` — but this is a non-critical side effect, not worth a hard failure).
export async function notifyInviteAccepted(newUserId, actorId) {
    try {
        const newUser = await findUserById(newUserId);
        if (!newUser || !newUser.invited_by) return;

        await insertNotification({
            recipientId: newUser.invited_by,
            actorId,
            type: "INVITE_ACCEPTED",
            entityType: "PROFILE",
            entityId: newUser.id,
            message: `${newUser.first_name} ${newUser.last_name} has accepted their invite and joined`,
        });
    } catch (error) {
        console.error("Failed to create INVITE_ACCEPTED notification:", error.message);
    }
}

// The flip side of notifyInviteAccepted above: that one tells the inviter
// someone joined, this one tells the new employee themself what to do next
// — their account is active but their profile_status is still INCOMPLETE at
// this point (submitting for verification is a separate, later step they
// take on their own), so without this they'd have no prompt at all beyond
// whatever HR tells them out of band.
export async function notifyProfileCreated(newUserId, actorId) {
    try {
        await insertNotification({
            recipientId: newUserId,
            actorId,
            type: "PROFILE_CREATED",
            entityType: "PROFILE",
            entityId: newUserId,
            message:
                "Profile successfully created. Please complete your profile details and upload your mandatory documents, then submit them to HR for verification.",
        });
    } catch (error) {
        console.error("Failed to create PROFILE_CREATED notification:", error.message);
    }
}
