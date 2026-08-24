// Read-only report on the two employment dates payroll now depends on.
//
//   node src/scripts/auditEmploymentDates.js
//
// Why this exists: `joining_date` was a self-editable profile field until
// recently, and it already drove `computeSlip`'s payable-day count — so every
// value currently in the database was either entered by the employee themself
// or left null, and none of it was ever checked against an offer letter. Exit
// proration is now correct, but it computes from that column, so the numbers are
// only as trustworthy as the dates.
//
// This writes nothing and takes no flags. It prints what HR needs in order to
// go and check: who has no joining date at all, whose date has already been
// used to pay them, and who has a leaving date recorded.
import dotenv from "dotenv";
import pool from "../config/db.js";
import { describeTarget } from "./describeTarget.js";

dotenv.config();

// Every non-invited user with their dates and how many live payslips exist.
//
// Input: none. Output: rows of `{ email, name, role, status, joining_date,
// last_working_day, active_slips, earliest_slip }`.
//
// INVITED users are excluded: they have never been paid and their profile isn't
// filled in yet, so they're noise in a report about data that needs checking.
// `active_slips` is what makes a row urgent rather than merely incomplete — a
// wrong joining date that has already been paid against is a wrong payslip,
// not just a wrong field.
async function fetchRows() {
    const result = await pool.query(
        `SELECT u.email,
                u.first_name || ' ' || u.last_name AS name,
                r.role_name AS role,
                u.status,
                u.joining_date,
                u.last_working_day,
                COUNT(s.id) FILTER (WHERE s.status = 'ACTIVE')::int AS active_slips,
                MIN(s.pay_period) FILTER (WHERE s.status = 'ACTIVE') AS earliest_slip
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN salary_slips s ON s.employee_id = u.id
         WHERE u.status <> 'INVITED'
         GROUP BY u.id, u.email, u.first_name, u.last_name, r.role_name, u.status,
                  u.joining_date, u.last_working_day
         ORDER BY (u.joining_date IS NULL) DESC, COUNT(s.id) DESC, u.email`
    );
    return result.rows;
}

function report(rows) {
    const missing = rows.filter((row) => !row.joining_date);
    const paidWithDate = rows.filter((row) => row.joining_date && row.active_slips > 0);
    const leaving = rows.filter((row) => row.last_working_day);

    console.log(`${rows.length} active/inactive employee(s) examined.\n`);

    console.log(`⚠ No joining date (${missing.length})`);
    if (missing.length) {
        // A null joining date is not neutral: computeSlip treats it as "no
        // restriction", so these people are paid a full month regardless of
        // when they actually started.
        console.log("  Treated as employed for the whole of every period, so a mid-month joiner is overpaid.");
        for (const row of missing) {
            const paid = row.active_slips ? `${row.active_slips} payslip(s) since ${row.earliest_slip}` : "no payslips";
            console.log(`  · ${row.email.padEnd(34)} ${row.role.padEnd(12)} ${paid}`);
        }
    } else {
        console.log("  None.");
    }

    console.log(`\n⚠ Joining date already used to pay someone (${paidWithDate.length})`);
    if (paidWithDate.length) {
        // These are the urgent ones: the date has already produced money.
        console.log("  Check each against the signed offer letter — these dates have already set a payable-day count.");
        for (const row of paidWithDate) {
            console.log(
                `  · ${row.email.padEnd(34)} joined ${row.joining_date}  ` +
                    `${row.active_slips} payslip(s) since ${row.earliest_slip}`
            );
        }
    } else {
        console.log("  None.");
    }

    console.log(`\n· Leaving date recorded (${leaving.length})`);
    for (const row of leaving) {
        console.log(`  · ${row.email.padEnd(34)} last day ${row.last_working_day}  (status ${row.status})`);
    }
    if (!leaving.length) console.log("  None.");

    console.log(
        "\nFix either with PATCH /api/employees/:id/employment-dates (a plain correction), " +
            "or POST /api/employees/:id/exit (records a leaving date and corrects the payslips it invalidates)."
    );
}

async function main() {
    try {
        console.log(`Target: ${describeTarget()}\n`);
        report(await fetchRows());
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

await main();
