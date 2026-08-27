// Pure parameterized SQL for the leave_requests table — no business rules
// here (overlap/balance/authorization checks all live in leaveRequestService.js),
// only queries.
import pool from "../config/db.js";

const BASE_COLUMNS = `id, employee_id, leave_type_id, start_date, end_date, start_half_day, end_half_day,
    working_days, reason, status, hr_escalated, decided_by, decided_at, decision_comment, created_at, updated_at`;

// Joined shape used by every "read" query — includes the leave type's name,
// the employee's name/manager_id (so callers, the service's authorization
// check in particular, never need a second round-trip just to find out who
// a request's employee reports to), and whoever most recently decided it
// (`decided_by` is only an id otherwise — LEFT JOIN since it's NULL for a
// still-SUBMITTED request).
// `has_document` (FR-012) lets the UI show a "view document" action only on
// requests that actually have one, without a second round-trip per row — a
// plain EXISTS subquery rather than a LEFT JOIN, since leave_request_documents
// is at most one row per request and this only needs a boolean, not its columns.
// `employee_role` lets the team/approvals view show a role badge next to the
// employee's name (HR sees everyone's requests, so the role isn't otherwise
// obvious from that list alone).
// `manager_first_name`/`manager_last_name` (the employee's manager, not
// `decider`) let the approvals view label a row "covering for X" when it
// belongs to a manager other than the viewer themself — the team list can
// now include a manager's team the viewer is only standing in for as an
// active delegate (see leaveRequestService.listTeamLeaveRequests), so
// `employee_manager_id` alone isn't enough for the UI to explain why an
// unfamiliar employee's request is showing up in someone else's list.
const JOINED_COLUMNS = `
    lr.id, lr.employee_id, lr.leave_type_id, lt.name AS leave_type_name,
    lr.start_date, lr.end_date, lr.start_half_day, lr.end_half_day, lr.working_days,
    lr.reason, lr.status, lr.hr_escalated, lr.decided_by, lr.decided_at, lr.decision_comment,
    lr.created_at, lr.updated_at,
    u.first_name AS employee_first_name, u.last_name AS employee_last_name, u.email AS employee_email, u.manager_id AS employee_manager_id,
    employee_role.role_name AS employee_role,
    manager.first_name AS manager_first_name, manager.last_name AS manager_last_name,
    decider.first_name AS decided_by_first_name, decider.last_name AS decided_by_last_name,
    EXISTS (SELECT 1 FROM leave_request_documents lrd WHERE lrd.leave_request_id = lr.id) AS has_document
`;
const JOINED_FROM = `FROM leave_requests lr
    JOIN leave_types lt ON lt.id = lr.leave_type_id
    JOIN users u ON u.id = lr.employee_id
    JOIN roles employee_role ON employee_role.id = u.role_id
    LEFT JOIN users manager ON manager.id = u.manager_id
    LEFT JOIN users decider ON decider.id = lr.decided_by`;

// Input: the submission fields (employeeId/leaveTypeId/dates/flags/workingDays/reason).
// Output: the newly created row (base columns only — the caller already has
// the leave type name/employee details from validating the submission).
// Always created as SUBMITTED; no failure mode beyond a DB constraint (e.g. a
// bad FK) surfacing as a generic error.
// `hrEscalated` marks a request whose submitter was standing in as their own
// manager's delegate at the time, so HR decides it instead of that manager
// (leaveRequestService.resolveEscalationForSubmission) — false for every
// ordinary submission.
// `status`/`decidedBy`/`decidedAt` default to a plain SUBMITTED row (the
// normal path — the DB column default would do this anyway, but passing it
// explicitly keeps every column visible in one place); SUPER_ADMIN's
// auto-approve bypass (leaveRequestService.submitLeaveRequest) is the one
// caller that overrides them, inserting directly as APPROVED so the row
// never exists in an intermediate SUBMITTED state even momentarily.
export async function insertLeaveRequest({
    employeeId,
    leaveTypeId,
    startDate,
    endDate,
    startHalfDay,
    endHalfDay,
    workingDays,
    reason,
    status = "SUBMITTED",
    hrEscalated = false,
    decidedBy = null,
    decidedAt = null,
}) {
    const result = await pool.query(
        `INSERT INTO leave_requests
            (employee_id, leave_type_id, start_date, end_date, start_half_day, end_half_day, working_days, reason, status, hr_escalated, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${BASE_COLUMNS}`,
        [employeeId, leaveTypeId, startDate, endDate, startHalfDay, endHalfDay, workingDays, reason, status, hrEscalated, decidedBy, decidedAt]
    );
    return result.rows[0];
}

// Input: a leave request id. Output: the joined row, or null if it doesn't
// exist — callers translate a null into a 404 themselves.
export async function findLeaveRequestById(id) {
    const result = await pool.query(`SELECT ${JOINED_COLUMNS} ${JOINED_FROM} WHERE lr.id = $1`, [id]);
    return result.rows[0] || null;
}

// Input: one employee id. Output: that employee's own requests, newest first.
export async function findLeaveRequestsForEmployee(employeeId) {
    const result = await pool.query(
        `SELECT ${JOINED_COLUMNS} ${JOINED_FROM} WHERE lr.employee_id = $1 ORDER BY lr.start_date DESC`,
        [employeeId]
    );
    return result.rows;
}

// Input: an array of employee ids (a manager's direct reports). Output: all
// of their requests, newest-submitted first — used for the manager approvals
// view. Excludes WITHDRAWN: once an employee withdraws their own request
// there's nothing left for a manager/HR to act on, so it shouldn't linger in
// their approvals list. Returns [] without a query for an empty list, since
// `= ANY('{}')` would otherwise need special-casing.
// The team/approvals list, and — with `employeeIds` omitted — the
// company-wide one that used to be its own `findAllLeaveRequests`. Both
// always excluded WITHDRAWN and ordered newest-submitted-first; they only
// ever differed in whether an employee filter was applied, so one function
// now covers both rather than two near-identical queries drifting apart.
//
// `undefined` employeeIds means "no employee restriction" (company-wide, for
// SUPER_ADMIN); `[]` means "nobody" and short-circuits — the same convention
// findLeaveRequestsFiltered uses, and the reason this can't just check for
// falsiness.
//
// Two bounded shapes, deliberately no unbounded one (see
// teamLeaveRequestsQuerySchema): `limit`/`offset` for a page of the list, or
// `startDate`/`endDate` for everything overlapping a window — the approvals
// calendar needs a whole month at once, which a page can't express.
function buildTeamWhere({ employeeIds, startDate, endDate }) {
    const conditions = ["lr.status <> 'WITHDRAWN'"];
    const params = [];

    if (employeeIds) {
        params.push(employeeIds);
        conditions.push(`lr.employee_id = ANY($${params.length}::uuid[])`);
    }
    // Standard interval-overlap test, same shape as the browse filters.
    if (startDate) {
        params.push(startDate);
        conditions.push(`lr.end_date >= $${params.length}`);
    }
    if (endDate) {
        params.push(endDate);
        conditions.push(`lr.start_date <= $${params.length}`);
    }

    return { whereClause: `WHERE ${conditions.join(" AND ")}`, params };
}

export async function findTeamLeaveRequests(filters = {}) {
    if (filters.employeeIds && filters.employeeIds.length === 0) {
        return [];
    }

    const { whereClause, params } = buildTeamWhere(filters);

    let pagination = "";
    if (filters.limit !== undefined) {
        params.push(filters.limit, filters.offset ?? 0);
        pagination = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
    }

    const result = await pool.query(
        `SELECT ${JOINED_COLUMNS} ${JOINED_FROM} ${whereClause} ORDER BY lr.created_at DESC ${pagination}`,
        params
    );
    return result.rows;
}

// Row count for the same filters, so a paginated caller can render
// "showing 1–25 of N" — see countLeaveRequestsFiltered for the same pattern.
export async function countTeamLeaveRequests(filters = {}) {
    if (filters.employeeIds && filters.employeeIds.length === 0) {
        return 0;
    }

    const { whereClause, params } = buildTeamWhere(filters);
    const result = await pool.query(
        `SELECT COUNT(*)::int AS count FROM leave_requests lr ${whereClause}`,
        params
    );
    return result.rows[0].count;
}


// Input: the manager ids whose direct reports' requests count as "mine to
// decide". Output: how many SUBMITTED requests that covers, as an int.
//
// Exists so the sidebar badge and the dashboard tile can show one number
// without downloading the rows behind it — at NFR-7's scale (200 employees,
// three years) the team list they used to count is thousands of rows and
// several megabytes, fetched on **every page load**, to render a single
// integer. Same shape and reasoning as notificationRepository's
// countUnreadForUser, which the notification bell already uses instead of
// fetching notifications to count them.
//
// Keyed on the *manager* rather than a list of employee ids because "waiting
// for my decision" is exactly "the employee's assigned manager is me (or
// someone I'm standing in for)" — see resolveActingCapacity. That also keeps
// the parameter list short: one array of manager ids instead of a subtree's
// worth of employee ids.
//
// `escalatedEmployeeIds` is the second, narrower half of the same question, and
// it *has* to be employee-keyed rather than manager-keyed: an escalated request
// is precisely one whose assigned manager is not the person who should decide it
// (see leaveRequestService.resolveEscalationForSubmission), so no manager id
// identifies it. Passing an HR-tier caller's own scope here counts the requests
// that were routed past a manager to them. A single query with an OR rather than
// two summed counts, because an escalated request whose manager happens to be
// the caller as well would otherwise be counted twice.
export async function countPendingDecisionsForManagers(managerIds, escalatedEmployeeIds = []) {
    if (managerIds.length === 0 && escalatedEmployeeIds.length === 0) {
        return 0;
    }
    const result = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM leave_requests lr
         JOIN users u ON u.id = lr.employee_id
         WHERE lr.status = 'SUBMITTED'
           AND (u.manager_id = ANY($1::uuid[]) OR (lr.hr_escalated AND lr.employee_id = ANY($2::uuid[])))`,
        [managerIds, escalatedEmployeeIds]
    );
    return result.rows[0].count;
}

// FR-024: HR's filterable browse view — every filter is optional and, unlike
// findTeamLeaveRequests above, nothing is excluded by default (a WITHDRAWN
// request is exactly the kind of thing HR might deliberately filter *for*
// when browsing/reporting, unlike the approvals views where it's just dead
// weight). The WHERE clause is built up dynamically since every filter is
// optional, but every value is still passed as a placeholder — never string-
// concatenated — so this stays immune to SQL injection regardless of which
// filters are present. `startDate`/`endDate` use the standard interval-
// overlap test (a request overlaps the filter window at all), the same
// shape already used for holidays and overlap detection elsewhere.
// The WHERE clause behind both functions below, built once so a paginated
// page of results and its total can never disagree about what they're
// counting. Returns the clause plus its parameter list, ready for whatever
// each caller appends (a LIMIT/OFFSET, nothing at all).
function buildFilteredWhere({ employeeId, leaveTypeId, status, startDate, endDate, employeeIds }) {
    const conditions = [];
    const params = [];

    if (employeeIds) {
        params.push(employeeIds);
        conditions.push(`lr.employee_id = ANY($${params.length}::uuid[])`);
    }
    if (employeeId) {
        params.push(employeeId);
        conditions.push(`lr.employee_id = $${params.length}`);
    }
    if (leaveTypeId) {
        params.push(leaveTypeId);
        conditions.push(`lr.leave_type_id = $${params.length}`);
    }
    if (status) {
        params.push(status);
        conditions.push(`lr.status = $${params.length}`);
    }
    if (startDate) {
        params.push(startDate);
        conditions.push(`lr.end_date >= $${params.length}`);
    }
    if (endDate) {
        params.push(endDate);
        conditions.push(`lr.start_date <= $${params.length}`);
    }

    return { whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

// `limit`/`offset` (both optional) page the results — passed by HR's browse
// view, omitted by callers that want the whole (already narrow) result set,
// like listOnLeaveToday's "approved, overlapping today". Omitting them keeps
// the old unbounded behaviour rather than silently applying a default cap,
// which would quietly truncate a caller that wasn't expecting pages.
//
// `ORDER BY lr.start_date DESC` is what makes paging stable, and is why
// migration 037 adds (employee_id, start_date DESC): without it, every page
// sorts the whole filtered set before discarding all but one page's worth.
export async function findLeaveRequestsFiltered(filters = {}) {
    // `employeeIds`, when passed, is the acting HR admin's own reporting
    // subtree (leaveRequestService.listFilteredLeaveRequests) — an
    // authorization boundary, not a user-facing filter, so it's applied
    // before any of the optional filters below and short-circuits the query
    // entirely for an HR admin with no subtree at all.
    if (filters.employeeIds && filters.employeeIds.length === 0) {
        return [];
    }

    const { whereClause, params } = buildFilteredWhere(filters);

    let pagination = "";
    if (filters.limit !== undefined) {
        params.push(filters.limit, filters.offset ?? 0);
        pagination = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
    }

    const result = await pool.query(
        `SELECT ${JOINED_COLUMNS} ${JOINED_FROM} ${whereClause} ORDER BY lr.start_date DESC ${pagination}`,
        params
    );
    return result.rows;
}

// The row count for the exact same filters, so a paginated caller can render
// "showing 1–25 of 4,312" and know whether a next page exists. Same shape as
// notificationRepository's countNotificationsForUser, which backs the only
// other paginated list in the app.
export async function countLeaveRequestsFiltered(filters = {}) {
    if (filters.employeeIds && filters.employeeIds.length === 0) {
        return 0;
    }

    const { whereClause, params } = buildFilteredWhere(filters);
    const result = await pool.query(
        `SELECT COUNT(*)::int AS count FROM leave_requests lr ${whereClause}`,
        params
    );
    return result.rows[0].count;
}

// FR-024's "report of leave taken per employee over a period": one row per
// employee who has at least one APPROVED request overlapping [startDate,
// endDate] (INNER JOIN via GROUP BY — an employee who took no leave in the
// period simply doesn't appear, rather than showing a zero row for every
// employee in the company). "Taken" means APPROVED specifically — pending,
// rejected, withdrawn, and cancelled requests never actually consumed leave.
// A request is counted in full (its whole snapshotted `working_days`, not a
// pro-rated slice) whenever it overlaps the period at all, even if only
// partially — the same simplification already made for the year-boundary
// debit rule in submitLeaveRequest, documented for the same reason: a
// day-by-day split would need re-deriving the working-day calculation for
// an arbitrary sub-range, which is a lot more machinery for a case the
// brief doesn't ask this precisely for.
export async function findLeaveTakenReport({ startDate, endDate, employeeIds }) {
    // Same subtree authorization boundary as findLeaveRequestsFiltered above
    // — see that function's comment.
    if (employeeIds && employeeIds.length === 0) {
        return [];
    }

    const conditions = ["lr.status = 'APPROVED'", "lr.end_date >= $1", "lr.start_date <= $2"];
    const params = [startDate, endDate];
    if (employeeIds) {
        params.push(employeeIds);
        conditions.push(`u.id = ANY($${params.length}::uuid[])`);
    }

    const result = await pool.query(
        `SELECT
            u.id AS employee_id,
            u.first_name AS employee_first_name,
            u.last_name AS employee_last_name,
            employee_role.role_name AS employee_role,
            COUNT(lr.id)::int AS request_count,
            SUM(lr.working_days)::numeric AS total_days_taken
         FROM leave_requests lr
         JOIN users u ON u.id = lr.employee_id
         JOIN roles employee_role ON employee_role.id = u.role_id
         WHERE ${conditions.join(" AND ")}
         GROUP BY u.id, u.first_name, u.last_name, employee_role.role_name
         ORDER BY u.first_name, u.last_name`,
        params
    );
    return result.rows;
}

// FR-015: a request overlaps another of the same employee's if their date
// ranges intersect (the standard interval-overlap test, same shape already
// used for holidays) and the other request hasn't already been
// rejected/withdrawn/cancelled — only SUBMITTED/APPROVED requests hold a
// claim on the calendar.
//
// Returns the offending row's dates and status alongside its id, not just a
// truthy marker: delegationService.createDelegation refuses a nomination whose
// window collides with the candidate's own leave, and a refusal that cannot say
// *which* dates collide leaves the manager guessing at their next attempt.
export async function findOverlappingLeaveRequest({ employeeId, startDate, endDate }) {
    const result = await pool.query(
        `SELECT id, start_date, end_date, status FROM leave_requests
         WHERE employee_id = $1
           AND status IN ('SUBMITTED', 'APPROVED')
           AND start_date <= $3 AND end_date >= $2
         LIMIT 1`,
        [employeeId, startDate, endDate]
    );
    return result.rows[0] || null;
}

// Input: the request id, the new status, who caused the change, and an
// optional comment. Output: the updated base row, or null if the id doesn't
// exist. `decided_by`/`decided_at` are reused for every transition (approve,
// reject, withdraw, cancel, override) as "who/when changed the status most
// recently" — not only for manager approval decisions.
export async function updateLeaveRequestStatus(id, { status, decidedBy, decisionComment = null }) {
    const result = await pool.query(
        `UPDATE leave_requests
         SET status = $2, decided_by = $3, decided_at = CURRENT_TIMESTAMP, decision_comment = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING ${BASE_COLUMNS}`,
        [id, status, decidedBy, decisionComment]
    );
    return result.rows[0] || null;
}

// Module 5 v2: LOP (loss of pay) days for one employee's payroll period —
// the sum of `working_days` on their APPROVED requests of any leave type
// flagged `counts_as_lop`, overlapping [startDate, endDate] (same interval-
// overlap test as findLeaveTakenReport above). Reuses existing leave data
// instead of a separate attendance system, which doesn't exist in this app.
// Requests still awaiting a decision long after the leave itself has passed.
//
// Input: a cutoff date key — requests whose start_date is on or before it and
// which are still SUBMITTED. Output: rows carrying the employee, their manager
// and the names both notifications need, so the sweep needs no follow-up
// lookups per row.
//
// Ordered oldest-first so the log line from a large first sweep reads
// chronologically. No limit: the set is naturally tiny (anything already
// notified today is deduped downstream), and capping it would silently leave
// the oldest requests unreported.
// Live requests whose dates overlap a given range.
//
// Input: two "YYYY-MM-DD" keys. Output: rows carrying enough to recompute and
// report — the stored working_days, the half-day flags, the employee and the
// leave type name.
//
// Only SUBMITTED and APPROVED, because those are the two statuses holding days
// in the ledger. A rejected, withdrawn or cancelled request has already
// released its days, so recounting it would move a balance for a request that
// no longer affects one.
export async function findLiveRequestsOverlapping(startDate, endDate) {
    const result = await pool.query(
        `SELECT lr.id, lr.employee_id, lr.leave_type_id, lr.start_date, lr.end_date,
                lr.start_half_day, lr.end_half_day, lr.working_days, lr.status,
                lt.name AS leave_type_name
         FROM leave_requests lr
         JOIN leave_types lt ON lt.id = lr.leave_type_id
         WHERE lr.status IN ('SUBMITTED', 'APPROVED')
           AND lr.end_date >= $1 AND lr.start_date <= $2
         ORDER BY lr.start_date`,
        [startDate, endDate]
    );
    return result.rows;
}

// Rewrites a request's cached working-day count.
//
// Input: a request id and the recomputed count. Output: the updated row, or
// `null` for an unknown id.
//
// `working_days` is a derived cache, not history — the append-only record of
// what happened lives in audit_logs, and the balance effect lives in
// leave_balance_ledger. So correcting it in place is right, provided a
// compensating ledger entry goes with it, which is what
// leaveRequestService.reconcileWorkingDaysForHolidayChange does.
export async function updateLeaveRequestWorkingDays(id, workingDays) {
    const result = await pool.query(
        `UPDATE leave_requests SET working_days = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, working_days`,
        [id, workingDays]
    );
    return result.rows[0] || null;
}

export async function findOverdueSubmittedRequests(cutoffDate) {
    const result = await pool.query(
        `SELECT lr.id, lr.employee_id, lr.start_date, lr.end_date, lr.working_days,
                u.first_name AS employee_first_name, u.last_name AS employee_last_name,
                u.manager_id AS employee_manager_id,
                lt.name AS leave_type_name
         FROM leave_requests lr
         JOIN users u ON u.id = lr.employee_id
         JOIN leave_types lt ON lt.id = lr.leave_type_id
         WHERE lr.status = 'SUBMITTED' AND lr.start_date <= $1
         ORDER BY lr.start_date ASC`,
        [cutoffDate]
    );
    return result.rows;
}

export async function findLopWorkingDays(employeeId, startDate, endDate) {
    const result = await pool.query(
        `SELECT COALESCE(SUM(lr.working_days), 0) AS lop_days
         FROM leave_requests lr
         JOIN leave_types lt ON lt.id = lr.leave_type_id
         WHERE lr.employee_id = $1
           AND lr.status = 'APPROVED'
           AND lt.counts_as_lop = true
           AND lr.end_date >= $2 AND lr.start_date <= $3`,
        [employeeId, startDate, endDate]
    );
    return Number(result.rows[0].lop_days);
}

// Module 5 v2: total leave days for one employee's payroll period -- same
// overlap query as findLopWorkingDays above, but summed across every leave
// type (not just ones flagged counts_as_lop), so a slip can show "total
// leave taken" as a superset of the LOP-only figure rather than nothing at
// all for leave that doesn't affect pay.
export async function findTotalLeaveWorkingDays(employeeId, startDate, endDate) {
    const result = await pool.query(
        `SELECT COALESCE(SUM(lr.working_days), 0) AS total_leave_days
         FROM leave_requests lr
         WHERE lr.employee_id = $1
           AND lr.status = 'APPROVED'
           AND lr.end_date >= $2 AND lr.start_date <= $3`,
        [employeeId, startDate, endDate]
    );
    return Number(result.rows[0].total_leave_days);
}

// How many requests of one leave type are still awaiting a decision.
//
// Input: a leave type id. Output: a count.
//
// Used only to warn HR when they deactivate a type: deactivating blocks new
// requests but not decisions on existing ones, so a type can vanish from the
// picker while approvals on it keep landing.
export async function countSubmittedRequestsForLeaveType(leaveTypeId) {
    const result = await pool.query(
        "SELECT COUNT(*)::int AS count FROM leave_requests WHERE leave_type_id = $1 AND status = 'SUBMITTED'",
        [leaveTypeId]
    );
    return result.rows[0].count;
}
