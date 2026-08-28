// Pure parameterized SQL for the delegations table (FR-020).
import pool from "../config/db.js";

const JOINED_COLUMNS = `
    d.id, d.manager_id, d.delegate_id,
    u.first_name AS delegate_first_name, u.last_name AS delegate_last_name,
    d.start_date, d.end_date, d.created_at, d.updated_at
`;

// Input: the manager, the nominated delegate, and the active date range.
// Output: the newly created row (joined shape). No failure mode beyond a DB
// constraint (e.g. manager_id = delegate_id, rejected by chk_delegations_not_self).
export async function insertDelegation({ managerId, delegateId, startDate, endDate }) {
    const result = await pool.query(
        `INSERT INTO delegations (manager_id, delegate_id, start_date, end_date)
         VALUES ($1, $2, $3, $4)
         RETURNING id, manager_id, delegate_id, start_date, end_date, created_at`,
        [managerId, delegateId, startDate, endDate]
    );
    const inserted = result.rows[0];
    return findDelegationById(inserted.id);
}

// Input: a delegation id and the full resulting `{ delegateId, startDate,
// endDate }` — every column, already merged with the stored row by the
// service, never a partial patch. Output: the updated row (joined shape), or
// null when no row has that id.
//
// The service resolves the merge rather than this taking optional columns and
// building a dynamic SET list: whether a given field was supplied changes
// which *guards* run (a new delegate must be re-checked against their own
// leave, a moved window against the manager's other delegations), so the
// service has to know the resulting values anyway. Passing them all down keeps
// one statement here with no branching.
export async function updateDelegation({ id, delegateId, startDate, endDate }) {
    const result = await pool.query(
        `UPDATE delegations
         SET delegate_id = $2, start_date = $3, end_date = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id`,
        [id, delegateId, startDate, endDate]
    );
    if (!result.rows[0]) {
        return null;
    }
    return findDelegationById(id);
}

// Input: a delegation id. Output: the joined row, or null.
export async function findDelegationById(id) {
    const result = await pool.query(
        `SELECT ${JOINED_COLUMNS} FROM delegations d JOIN users u ON u.id = d.delegate_id WHERE d.id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

// Input: a manager id. Output: every delegation that manager has ever
// nominated, most recent start date first — each carrying
// `conflict_leave_start_date`/`conflict_leave_end_date`/`conflict_leave_status`,
// which are non-null when the nominated delegate holds a live leave request
// overlapping the window they are supposed to cover.
//
// Why those three columns exist: a nomination over existing leave is refused
// outright (assertDelegateIsNotOnLeave, on both create and edit), so an overlap
// found on a stored delegation can only have arrived *afterwards* — the
// delegate booked leave inside a window that had not started yet, which is
// deliberately allowed. Both sides get a DELEGATION_LEAVE_CONFLICT notification
// at that moment, but a notification is read once and then gone, while the
// delegation itself is what the manager comes back to. Without this the
// Delegations page shows a nomination that looks fine and is not.
//
// A LATERAL join rather than a query per row: /mine returns every delegation a
// manager has ever created, so asking per delegation is an N+1 that grows with
// their history. LIMIT 1 because the row only needs to say *that* there is a
// clash and name one set of dates — the manager's next step (edit the
// nomination) is the same whether there are one or three.
//
// SUBMITTED and APPROVED, the same two statuses the nomination guard blocks on
// and for the same reason: a pending request is usually this manager's own
// decision to make, so it is a clash they are already holding.
export async function findDelegationsForManager(managerId) {
    const result = await pool.query(
        `SELECT ${JOINED_COLUMNS},
                clash.start_date AS conflict_leave_start_date,
                clash.end_date   AS conflict_leave_end_date,
                clash.status     AS conflict_leave_status
         FROM delegations d
         JOIN users u ON u.id = d.delegate_id
         LEFT JOIN LATERAL (
             SELECT lr.start_date, lr.end_date, lr.status
             FROM leave_requests lr
             WHERE lr.employee_id = d.delegate_id
               AND lr.status IN ('SUBMITTED', 'APPROVED')
               AND lr.start_date <= d.end_date AND lr.end_date >= d.start_date
             ORDER BY lr.start_date ASC
             LIMIT 1
         ) clash ON TRUE
         WHERE d.manager_id = $1
         ORDER BY d.start_date DESC`,
        [managerId]
    );
    return result.rows;
}

// Input: a delegate id. Output: every delegation where they're the
// delegate, most recent start date first — the flip side of
// findDelegationsForManager, joined against the manager instead of the
// delegate so the UI can show whose approvals they're covering.
export async function findDelegationsForDelegate(delegateId) {
    const result = await pool.query(
        `SELECT d.id, d.manager_id, d.delegate_id,
                m.first_name AS manager_first_name, m.last_name AS manager_last_name,
                d.start_date, d.end_date, d.created_at
         FROM delegations d
         JOIN users m ON m.id = d.manager_id
         WHERE d.delegate_id = $1
         ORDER BY d.start_date DESC`,
        [delegateId]
    );
    return result.rows;
}

// Input: a delegate id and a "YYYY-MM-DD" date. Output: the manager ids this
// delegate is actively standing in for on that date — plural, since nothing
// stops the same person delegating for two different managers at once (only
// a single manager's own ranges can't overlap each other, see
// findOverlappingDelegationForManager below). Used by
// leaveRequestService.listTeamLeaveRequests to merge each covered manager's
// team into the delegate's own approvals view for the active window.
export async function findActiveDelegatedManagerIds(delegateId, onDate) {
    const result = await pool.query(
        `SELECT manager_id FROM delegations
         WHERE delegate_id = $1 AND start_date <= $2 AND end_date >= $2`,
        [delegateId, onDate]
    );
    return result.rows.map((row) => row.manager_id);
}

// Input: a delegate id and a candidate leave date range. Output: every
// delegation naming this user as the delegate whose own window intersects that
// range, joined against the nominating manager's name, earliest first.
//
// One query serves both halves of the delegation-vs-leave rule, because the two
// differ only in *when* the colliding window starts, and the caller already
// knows today's date:
//   - a window that has already begun (start_date <= today) means the person is
//     mid-coverage, and leave inside it is refused;
//   - a window still in the future is allowed and merely warned about, since
//     refusing it would let a nomination the delegate never agreed to block
//     their leave, and FR-020 gives them no way to decline.
// Splitting this into two queries would put that "today" comparison in SQL in
// one place and in JavaScript in the other, which is how the two halves of one
// rule end up disagreeing.
export async function findDelegationsForDelegateOverlapping({ delegateId, startDate, endDate }) {
    const result = await pool.query(
        `SELECT d.id, d.manager_id, d.delegate_id, d.start_date, d.end_date,
                m.first_name AS manager_first_name, m.last_name AS manager_last_name
         FROM delegations d
         JOIN users m ON m.id = d.manager_id
         WHERE d.delegate_id = $1 AND d.start_date <= $3 AND d.end_date >= $2
         ORDER BY d.start_date ASC`,
        [delegateId, startDate, endDate]
    );
    return result.rows;
}

// Input: a "YYYY-MM-DD" date. Output: every delegation whose window begins
// that day, joined against the delegate's name — backs
// notificationSweepService.js's daily check for "should the manager be told
// their delegate's coverage starts today" (a time-based trigger, unlike
// every other notification in this app, which fires from a request handler).
export async function findDelegationsStartingOn(date) {
    const result = await pool.query(
        `SELECT d.id, d.manager_id, d.delegate_id, d.start_date, d.end_date,
                u.first_name AS delegate_first_name, u.last_name AS delegate_last_name
         FROM delegations d
         JOIN users u ON u.id = d.delegate_id
         WHERE d.start_date = $1`,
        [date]
    );
    return result.rows;
}

// The flip side of findDelegationsStartingOn — every delegation whose
// window ends that day.
export async function findDelegationsEndingOn(date) {
    const result = await pool.query(
        `SELECT d.id, d.manager_id, d.delegate_id, d.start_date, d.end_date,
                u.first_name AS delegate_first_name, u.last_name AS delegate_last_name
         FROM delegations d
         JOIN users u ON u.id = d.delegate_id
         WHERE d.end_date = $1`,
        [date]
    );
    return result.rows;
}

// FR-020's overlap guard: two delegations for the *same* manager must not
// have overlapping date ranges, or "who's the active delegate today" would be
// ambiguous. Same interval-overlap test already used for holidays.
//
// `excludeId` omits one delegation from the comparison, and exists for the
// edit path: a row always overlaps itself, so without it every PATCH that left
// the dates alone would be refused as clashing with the very row it updates.
export async function findOverlappingDelegationForManager({ managerId, startDate, endDate, excludeId = null }) {
    const result = await pool.query(
        `SELECT id FROM delegations
         WHERE manager_id = $1 AND start_date <= $3 AND end_date >= $2
           AND ($4::uuid IS NULL OR id <> $4)
         LIMIT 1`,
        [managerId, startDate, endDate, excludeId]
    );
    return result.rows[0] || null;
}

// Input: a candidate manager/delegate pair and a "YYYY-MM-DD" date. Output:
// the delegation row if `delegateId` is actively standing in for `managerId`
// on that date, else null — this is the exact question
// leaveRequestService.assertCanActOnLeaveRequest needs answered for every
// approve/reject attempt by someone who isn't the request's direct manager.
export async function findActiveDelegation({ managerId, delegateId, onDate }) {
    const result = await pool.query(
        `SELECT id FROM delegations
         WHERE manager_id = $1 AND delegate_id = $2 AND start_date <= $3 AND end_date >= $3
         LIMIT 1`,
        [managerId, delegateId, onDate]
    );
    return result.rows[0] || null;
}
