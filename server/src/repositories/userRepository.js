import pool from "../config/db.js";

// `invited_by` is a scalar subquery, not a JOIN, so a user with more than one
// invitations row can never multiply this user into extra rows the way a LEFT
// JOIN would. Re-inviting a pending employee exists now
// (invitationService.inviteEmployee) and deliberately *updates* the live row
// rather than inserting a second one, so today there's still only ever one row
// per user — this stays defensive rather than load-bearing.
// `ORDER BY created_at ASC LIMIT 1` picks the
// original invite if that ever changes. NULL for anyone who registered
// through a path with no invitation row at all (the root HR_ADMIN via
// POST /auth/register/hr) — used by userService.changeManager to restrict
// who may edit an HR_ADMIN's own reporting line to whoever created them.
// Profile columns (phone through bank_name) are added here unconditionally
// for every reader of this shape — masking pan_number/aadhar_number/
// bank_account_number/bank_ifsc_code/bank_name for a manager viewing a
// report is a row-level authorization decision, so it belongs in
// userService.js (maskSensitiveProfileFields), not here. Repositories stay
// pure SQL, no business rules, matching the rest of this file.
const PUBLIC_USER_COLUMNS = `
    u.id,
    u.first_name,
    u.last_name,
    u.email,
    r.role_name AS role,
    u.manager_id,
    u.department_id,
    u.status,
    u.employee_code,
    u.designation,
    u.department,
    u.phone,
    u.date_of_birth,
    u.highest_education,
    u.passport_number,
    u.passport_expiry_date,
    u.joining_date,
    u.last_working_day,
    u.blood_group,
    u.marital_status,
    u.current_address,
    u.permanent_address,
    u.nearest_airport,
    u.health_problem,
    u.health_insurance_status,
    u.emergency_contact_1_phone,
    u.emergency_contact_1_relationship,
    u.emergency_contact_2_phone,
    u.emergency_contact_2_relationship,
    u.pan_number,
    u.aadhar_number,
    u.bank_account_number,
    u.bank_ifsc_code,
    u.bank_name,
    u.profile_status,
    u.profile_verified_by,
    u.profile_verified_at,
    u.profile_send_back_reason,
    u.profile_send_back_by,
    u.profile_send_back_at,
    u.created_at,
    u.updated_at,
    (SELECT i.invited_by FROM invitations i WHERE i.user_id = u.id ORDER BY i.created_at ASC LIMIT 1) AS invited_by
`;

// The self-service profile fields an employee may edit on their own
// profile — never role_id/manager_id/status/email/employee_code/
// profile_status, which stay HR/system managed via existing flows
// (updateManager/updateStatus above, profileVerificationStateMachine.js).
//
// joining_date and last_working_day are deliberately absent too, and that is a
// correctness rule rather than tidiness: both determine *pay*. joining_date
// drives computeSlip's effectiveStart, the payable-day count and the
// pre-joining deduction, so while it was self-editable an employee who really
// started on the 20th could set it to the 1st and grant themselves the
// difference — measured on a ₹50,000 salary in a 31-day month, ₹30,645.16 in
// one click. Setting it to a future date was worse in a different way: payroll
// skipped them entirely with "Not yet joined for this period". Both are now
// HR-set (updateEmploymentDates below), sourced from the signed offer letter at
// verification time, so the value payroll trusts was never supplied by the
// person being paid.
// Keyed by the camelCase name profileValidator.js's schema produces, mapped
// to its snake_case column — the same camelCase-in/snake_case-SQL
// convention insertUser above already uses.
const PROFILE_FIELD_COLUMNS = {
    designation: "designation",
    department: "department",
    phone: "phone",
    dateOfBirth: "date_of_birth",
    highestEducation: "highest_education",
    passportNumber: "passport_number",
    passportExpiryDate: "passport_expiry_date",
    bloodGroup: "blood_group",
    maritalStatus: "marital_status",
    currentAddress: "current_address",
    permanentAddress: "permanent_address",
    nearestAirport: "nearest_airport",
    healthProblem: "health_problem",
    healthInsuranceStatus: "health_insurance_status",
    emergencyContact1Phone: "emergency_contact_1_phone",
    emergencyContact1Relationship: "emergency_contact_1_relationship",
    emergencyContact2Phone: "emergency_contact_2_phone",
    emergencyContact2Relationship: "emergency_contact_2_relationship",
    panNumber: "pan_number",
    aadharNumber: "aadhar_number",
    bankAccountNumber: "bank_account_number",
    bankIfscCode: "bank_ifsc_code",
    bankName: "bank_name",
};

export async function findAllUsers() {
    const result = await pool.query(
        `SELECT ${PUBLIC_USER_COLUMNS}
         FROM users u
         JOIN roles r ON r.id = u.role_id
         ORDER BY u.created_at`
    );
    return result.rows;
}

// Removes people who never accepted their invite before it expired. Deleting the
// user (rather than just hiding them) is deliberate: users.email is UNIQUE, so a
// lingering stale row would permanently block HR from re-inviting that person.
// Scoped to status = 'INVITED' so an accepted account can never be caught by this,
// even if an old invitation row is left behind. Dependent rows (invitations,
// leave balances, oauth accounts, password resets) cascade.
export async function deleteExpiredInvitees() {
    const result = await pool.query(
        `DELETE FROM users u
         USING invitations i
         WHERE i.user_id = u.id
           AND u.status = 'INVITED'
           AND i.accepted_at IS NULL
           AND i.expires_at < CURRENT_TIMESTAMP
         RETURNING u.id`
    );
    return result.rows.map((row) => row.id);
}

export async function findUserById(id) {
    const result = await pool.query(
        `SELECT ${PUBLIC_USER_COLUMNS}
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

export async function findPasswordHashById(id) {
    const result = await pool.query("SELECT password_hash FROM users WHERE id = $1", [id]);
    return result.rows[0]?.password_hash ?? null;
}

// Minimal by-email lookup for the invite flow's "does this address already
// exist" branch.
// Input: an email (matched case-insensitively, the same way uq_users_email_lower
// enforces uniqueness). Output: `{ id, status }` or `null`.
//
// Deliberately not findAuthByEmail, which is otherwise the same query: that one
// selects password_hash, and there's no reason for a hash to travel into the
// invitation service just to answer a yes/no question.
export async function findInviteeByEmail(email) {
    const result = await pool.query("SELECT id, status FROM users WHERE lower(email) = lower($1)", [email]);
    return result.rows[0] || null;
}

export async function findAuthByEmail(email) {
    const result = await pool.query(
        `SELECT u.id, u.email, u.password_hash, u.status, r.role_name AS role, u.manager_id
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE lower(u.email) = lower($1)`,
        [email]
    );
    return result.rows[0] || null;
}

export async function findAuthContextById(id) {
    const result = await pool.query(
        `SELECT u.id, u.email, u.status, r.role_name AS role, u.manager_id
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

export async function countUsers() {
    const result = await pool.query("SELECT COUNT(*)::int AS count FROM users");
    return result.rows[0].count;
}

// Used by authService.registerHrRoot's singleton guard — SUPER_ADMIN may
// only ever be created once, so the bootstrap route checks this before
// inserting a second one. Deliberately not the guarantee itself: this is a
// check-then-insert, so the real enforcement is the partial unique index
// uq_users_single_super_admin (migration 038), which two simultaneous
// bootstraps cannot both pass. This check stays because it produces a clear
// 409 for the ordinary sequential case without reaching the insert at all.
export async function existsUserWithRole(roleId) {
    const result = await pool.query("SELECT EXISTS (SELECT 1 FROM users WHERE role_id = $1) AS role_exists", [
        roleId,
    ]);
    return result.rows[0].role_exists;
}

export async function insertUser({
    firstName,
    lastName,
    email,
    passwordHash = null,
    roleId,
    managerId = null,
    status = "ACTIVE",
}) {
    const result = await pool.query(
        `INSERT INTO users (first_name, last_name, email, password_hash, role_id, manager_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, first_name, last_name, email, role_id, manager_id, status, created_at, updated_at`,
        [firstName, lastName, email, passwordHash, roleId, managerId, status]
    );
    return result.rows[0];
}

export async function setPasswordHashAndActivate(id, passwordHash) {
    const result = await pool.query(
        `UPDATE users
         SET password_hash = $2, status = 'ACTIVE'
         WHERE id = $1
         RETURNING id, email, status`,
        [id, passwordHash]
    );
    return result.rows[0] || null;
}

export async function touchLastLogin(id) {
    await pool.query("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);
}

export async function updateStatus(id, status) {
    const result = await pool.query(
        `UPDATE users
         SET status = $2
         WHERE id = $1
         RETURNING id, status`,
        [id, status]
    );
    return result.rows[0] || null;
}

export async function updatePasswordHash(id, passwordHash) {
    await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [id, passwordHash]);
}

export async function updateManager(id, managerId) {
    const result = await pool.query(
        `UPDATE users
         SET manager_id = $2
         WHERE id = $1
         RETURNING id, manager_id`,
        [id, managerId]
    );
    return result.rows[0] || null;
}

// `fields` is a plain object keyed by snake_case column name — only keys in
// SELF_EDITABLE_PROFILE_COLUMNS are ever written, so a caller can never
// smuggle role_id/manager_id/status/email through here even by mistake;
// the zod schema in profileValidator.js is the primary defense, this is
// belt-and-suspenders at the data-access layer.
// HR-only writer for the two employment dates payroll depends on.
//
// Input: a user id and `{ joiningDate, lastWorkingDay }` — either key may be
// omitted to leave that date alone, and an explicit `null` clears it (which is
// how a rejoining employee is returned to the payroll list). Output: the
// updated public user row, or `null` for an unknown id.
//
// Separate from updateProfileFields on purpose: that function's whole contract
// is "fields the employee may change about themselves", and these two are the
// opposite of that — see the note on PROFILE_FIELD_COLUMNS above.
export async function updateEmploymentDates(id, { joiningDate, lastWorkingDay }) {
    const assignments = [];
    const values = [id];

    if (joiningDate !== undefined) {
        values.push(joiningDate);
        assignments.push(`joining_date = $${values.length}`);
    }
    if (lastWorkingDay !== undefined) {
        values.push(lastWorkingDay);
        assignments.push(`last_working_day = $${values.length}`);
    }

    if (!assignments.length) {
        return findUserById(id);
    }

    const result = await pool.query(
        `UPDATE users SET ${assignments.join(", ")}, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id`,
        values
    );

    return result.rows[0] ? findUserById(id) : null;
}

export async function updateProfileFields(id, fields) {
    const keys = Object.keys(PROFILE_FIELD_COLUMNS).filter((key) => Object.prototype.hasOwnProperty.call(fields, key));
    if (keys.length > 0) {
        const setClause = keys.map((key, index) => `${PROFILE_FIELD_COLUMNS[key]} = $${index + 2}`).join(", ");
        const values = keys.map((key) => fields[key]);
        await pool.query(`UPDATE users SET ${setClause} WHERE id = $1`, [id, ...values]);
    }
    return findUserById(id);
}

// Input: a root user id. Output: how many people are under them in the
// reporting tree, excluding themselves, as an int.
//
// The count-only counterpart to findSubtreeUsers above, for the dashboard's
// headcount chip: that function returns every row with all ~40 public
// columns (~240KB for 200 people) where the tile only ever reads
// `team.length`. Same recursive CTE and the same depth guard, so the two can
// never disagree about who's in the subtree.
// Just enough of a user to render an option in a picker: who they are, what
// role they hold, and whether the account is usable. Five columns instead of
// PUBLIC_USER_COLUMNS' ~40 — the four surfaces that fetch a user list purely
// to fill a dropdown (invite form, delegation form, HR reports, salary slips)
// were pulling every profile field, including the masked government-ID and
// bank ones, for ~240KB per page load at NFR-7's 200 employees.
//
// `status` is included because pickers care: a delegation can only name an
// ACTIVE user, and an INVITED account isn't a valid manager yet.
const USER_OPTION_COLUMNS = `
    u.id,
    u.first_name,
    u.last_name,
    r.role_name AS role,
    u.status
`;

export async function findAllUserOptions() {
    const result = await pool.query(
        `SELECT ${USER_OPTION_COLUMNS}
         FROM users u
         JOIN roles r ON r.id = u.role_id
         ORDER BY u.first_name, u.last_name`
    );
    return result.rows;
}

// Subtree variant, for a MANAGER — same recursion and depth guard as
// findSubtreeUsers, so the two can't disagree about who's in the subtree.
export async function findSubtreeUserOptions(rootId) {
    const result = await pool.query(
        `WITH RECURSIVE subtree AS (
            SELECT id, manager_id, 0 AS depth FROM users WHERE id = $1
            UNION
            SELECT u.id, u.manager_id, s.depth + 1
            FROM users u
            JOIN subtree s ON u.manager_id = s.id
            WHERE s.depth < 20
        )
        SELECT ${USER_OPTION_COLUMNS}
        FROM users u
        JOIN roles r ON r.id = u.role_id
        JOIN subtree s ON s.id = u.id
        ORDER BY u.first_name, u.last_name`,
        [rootId]
    );
    return result.rows;
}

export async function countSubtreeUsers(rootId) {
    const result = await pool.query(
        `WITH RECURSIVE subtree AS (
            SELECT id, manager_id, 0 AS depth FROM users WHERE id = $1
            UNION
            SELECT u.id, u.manager_id, s.depth + 1
            FROM users u
            JOIN subtree s ON u.manager_id = s.id
            WHERE s.depth < 20
        )
        SELECT COUNT(*)::int AS count FROM subtree WHERE id <> $1`,
        [rootId]
    );
    return result.rows[0].count;
}

export async function findDirectReports(managerId) {
    const result = await pool.query(
        `SELECT ${PUBLIC_USER_COLUMNS}
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.manager_id = $1
         ORDER BY u.first_name`,
        [managerId]
    );
    return result.rows;
}

// A plain, non-recursive check — deliberately *not* isUserInSubtree below,
// which is a transitive manager_id walk. Used to scope SUPER_ADMIN's HR-like
// authority to only the HR_ADMINs reporting straight to them, never those
// HR_ADMINs' own downstream teams (see authzScope.js).
export async function isDirectReport(managerId, employeeId) {
    const result = await pool.query(
        "SELECT EXISTS (SELECT 1 FROM users WHERE id = $2 AND manager_id = $1) AS is_direct_report",
        [managerId, employeeId]
    );
    return result.rows[0].is_direct_report;
}

export async function findSubtreeUsers(rootId) {
    const result = await pool.query(
        `WITH RECURSIVE subtree AS (
            SELECT id, manager_id, 0 AS depth FROM users WHERE id = $1
            UNION
            SELECT u.id, u.manager_id, s.depth + 1
            FROM users u
            JOIN subtree s ON u.manager_id = s.id
            WHERE s.depth < 20
        )
        SELECT ${PUBLIC_USER_COLUMNS}
        FROM users u
        JOIN roles r ON r.id = u.role_id
        JOIN subtree s ON s.id = u.id
        ORDER BY u.first_name`,
        [rootId]
    );
    return result.rows;
}

// HR's verification queue, scoped to their own subtree (the service layer
// passes `findSubtreeUsers`' ids in) — a plain WHERE ... IN, not another
// recursive CTE, since the subtree is already resolved by the caller.
export async function findEmployeesPendingVerification(employeeIds) {
    if (employeeIds.length === 0) return [];
    const result = await pool.query(
        `SELECT ${PUBLIC_USER_COLUMNS}
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = ANY($1::uuid[]) AND u.profile_status = 'SUBMITTED'
         ORDER BY u.first_name`,
        [employeeIds]
    );
    return result.rows;
}

// The "Verified Employees" section on HR's verification page — same shape
// and scoping as findEmployeesPendingVerification above, just the opposite
// status.
export async function findVerifiedEmployees(employeeIds) {
    if (employeeIds.length === 0) return [];
    const result = await pool.query(
        `SELECT ${PUBLIC_USER_COLUMNS}
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = ANY($1::uuid[]) AND u.profile_status = 'VERIFIED'
         ORDER BY u.first_name`,
        [employeeIds]
    );
    return result.rows;
}

// A single UPDATE handles all three profile-status transitions (submit,
// verify, send-back) — each caller only fills in the fields relevant to its
// own transition, and everything else defaults to null, which is what
// clears a stale value left over from an earlier transition (e.g.
// submitting again after a send-back clears that send-back's reason, since
// it's now addressed and no longer the current state).
export async function updateProfileStatus(
    id,
    { status, verifiedBy = null, verifiedAt = null, sendBackReason = null, sendBackBy = null, sendBackAt = null }
) {
    const result = await pool.query(
        `UPDATE users
         SET profile_status = $2, profile_verified_by = $3, profile_verified_at = $4,
             profile_send_back_reason = $5, profile_send_back_by = $6, profile_send_back_at = $7
         WHERE id = $1
         RETURNING id, profile_status, profile_send_back_reason`,
        [id, status, verifiedBy, verifiedAt, sendBackReason, sendBackBy, sendBackAt]
    );
    return result.rows[0] || null;
}

// Walks *up* the reporting chain via manager_id — the reverse direction of
// findSubtreeUsers/isUserInSubtree below — so a user can be shown who their
// direct manager is and which HR admin will end up verifying their profile.
// Ordered nearest-first (depth 1 = direct manager); the caller picks out the
// first HR_ADMIN role in the list as "their HR", since that's the same
// ancestor whose isUserInSubtree(theirId, employeeId) would return true.
export async function findReportingLine(userId) {
    const result = await pool.query(
        `WITH RECURSIVE chain AS (
            SELECT u.id, u.manager_id, u.first_name, u.last_name, u.email, r.role_name AS role, 0 AS depth
            FROM users u
            JOIN roles r ON r.id = u.role_id
            WHERE u.id = $1
            UNION ALL
            SELECT u.id, u.manager_id, u.first_name, u.last_name, u.email, r.role_name AS role, c.depth + 1
            FROM users u
            JOIN roles r ON r.id = u.role_id
            JOIN chain c ON u.id = c.manager_id
            WHERE c.depth < 20
        )
        SELECT id, first_name, last_name, email, role
        FROM chain
        WHERE depth > 0
        ORDER BY depth`,
        [userId]
    );
    return result.rows;
}

export async function isUserInSubtree(rootId, candidateId) {
    const result = await pool.query(
        `WITH RECURSIVE subtree AS (
            SELECT id, manager_id, 0 AS depth FROM users WHERE id = $1
            UNION
            SELECT u.id, u.manager_id, s.depth + 1
            FROM users u
            JOIN subtree s ON u.manager_id = s.id
            WHERE s.depth < 20
        )
        SELECT EXISTS (SELECT 1 FROM subtree WHERE id = $2) AS in_subtree`,
        [rootId, candidateId]
    );
    return result.rows[0].in_subtree;
}
