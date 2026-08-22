// Ensures a reviewer can log in as each role, and nothing else.
//
//   node src/scripts/seedDemo.js              plan only, writes nothing
//   node src/scripts/seedDemo.js --yes        actually create what's missing
//   node src/scripts/seedDemo.js --yes --allow-production
//
// Deliverable #2 asks for a deployed app seeded with a reporting structure at
// least three levels deep, two leave types, a holiday calendar, and one demo
// login per role. On both databases this project actually has, all of that
// already exists *except* the logins — nobody knows the passwords of the real
// accounts, and they aren't shareable even if they did. So this script is
// deliberately not an "environment builder": it is an **ensure** step that
// adds three accounts and leaves every existing record alone.
//
// What it will never do, each for a specific reason:
//   - Modify or delete an existing user, leave request, balance or ledger row.
//     There is real data in both databases and none of it is this script's.
//   - Create a leave type. Doing so backfills a balance row for *every* active
//     employee (leaveBalanceService.backfillBalancesForLeaveType) — a global
//     side effect on people who have nothing to do with the demo.
//   - Create a holiday. Holidays are global and feed the working-day
//     calculation, so adding one silently changes the day count of every
//     future request in the system, for everyone.
//   - Upload a document. That would put bytes in Cloudinary that no teardown
//     removes.
//   - Generate payroll, or the 200-employee NFR-7 dataset. Different jobs,
//     and the second one must never share a database with real records.
//
// There is no teardown in v1, on purpose: deleting a user cascades across
// requests, balances, ledger entries, documents and slips, with a mix of
// CASCADE and RESTRICT foreign keys, and a script whose entire value is being
// safe is the wrong place to guess about that. Removal is manual and
// documented in server/README.md.
import dotenv from "dotenv";
import pool from "../config/db.js";
import { findAllUsers, findUserById, findInviteeByEmail, insertUser, updateProfileStatus } from "../repositories/userRepository.js";
import { findRoleByName } from "../repositories/roleRepository.js";
import { findAllLeaveTypes } from "../repositories/leaveTypeRepository.js";
import { seedBalancesForUser } from "../services/leaveBalanceService.js";
import { submitLeaveRequest, decideLeaveRequest, previewWorkingDays } from "../services/leaveRequestService.js";
import { hashPassword } from "../utils/password.js";
import { todayDateKey, addDaysToDateKey, isWeekend } from "../utils/dates.js";
import { describeTarget, looksLikeProduction } from "./describeTarget.js";

dotenv.config();

// @example.com is reserved by IANA (RFC 2606) and can never be delivered to,
// so a demo account can't accidentally mail a real person even if some future
// flow decides to email it. Ordered parent-first: each entry's manager is the
// one above it, which is what produces the SUPER_ADMIN -> HR -> MANAGER ->
// EMPLOYEE chain the deliverable asks for.
const DEMO_ACCOUNTS = [
    { email: "demo.hr@example.com", firstName: "Demo", lastName: "HR", role: "HR_ADMIN" },
    { email: "demo.manager@example.com", firstName: "Demo", lastName: "Manager", role: "MANAGER" },
    { email: "demo.employee@example.com", firstName: "Demo", lastName: "Employee", role: "EMPLOYEE" },
];

// Returns the next `count` working days starting `offsetDays` from today,
// skipping weekends.
//
// Input: a positive day offset and how many dates to return. Output: an array
// of "YYYY-MM-DD" keys, all weekdays, all distinct and ascending.
//
// Weekends are skipped because submitLeaveRequest refuses a range with zero
// working days — the same trap that made two integration fixtures fail on a
// Saturday (see tests/integration/helpers/dates.js). Public holidays are not
// consulted here; the caller checks the resulting range with
// previewWorkingDays before submitting, which is the authoritative answer.
function upcomingWorkingDays(offsetDays, count) {
    const dates = [];
    let cursor = addDaysToDateKey(todayDateKey(), offsetDays);

    while (dates.length < count) {
        if (!isWeekend(cursor)) {
            dates.push(cursor);
        }
        cursor = addDaysToDateKey(cursor, 1);
    }

    return dates;
}

// Picks a leave type suitable for demo activity.
//
// Input: the list of leave types. Output: one type, or `null` if none fits.
//
// Requires `requires_document: false` — a type demanding a medical
// certificate would force a Cloudinary upload, which this script must not do.
// Requires a non-trivial entitlement so the three demo requests can't be
// refused for taking the balance below zero.
function pickDemoLeaveType(leaveTypes) {
    return (
        leaveTypes.find(
            (type) => type.is_active && !type.requires_document && Number(type.annual_entitlement) >= 5
        ) || null
    );
}

// Creates one demo account if its email isn't already taken.
//
// Input: the account definition, the manager's id, the role row's id, and the
// bcrypt hash to store. Output: `{ email, role, action, user }` where `action`
// is "created" or "exists".
//
// Idempotent by email lookup rather than a hardcoded UUID: `users.email` is
// uniquely indexed (case-insensitively) and is the identifier this deployment
// actually uses — `employee_code` is never populated. An existing account is
// returned untouched, never updated to match this file, because it might be
// somebody's real account that happens to share the address.
async function ensureAccount(account, managerId, roleId, passwordHash) {
    const existing = await findInviteeByEmail(account.email);
    if (existing) {
        return { email: account.email, role: account.role, action: "exists", user: await findUserById(existing.id) };
    }

    const created = await insertUser({
        firstName: account.firstName,
        lastName: account.lastName,
        email: account.email,
        passwordHash,
        roleId,
        managerId,
        status: "ACTIVE",
    });

    // VERIFIED at creation, not INCOMPLETE: a reviewer logging in should land
    // in the app, not in the onboarding form. The verification workflow is
    // demonstrable with the real accounts that are already mid-flow.
    await updateProfileStatus(created.id, { status: "VERIFIED" });

    // Every employee needs a balance row per active leave type before they can
    // request anything (FR-008). insertUser doesn't do this — invitationService
    // calls it separately — so the seed has to as well.
    await seedBalancesForUser(created.id);

    return { email: account.email, role: account.role, action: "created", user: await findUserById(created.id) };
}

// Creates a small amount of leave history for the demo employee, so a reviewer
// logging in as the manager has something waiting for a decision rather than
// an empty approvals page.
//
// Input: the demo employee and manager rows (as returned by findUserById), and
// the leave type to use. Output: an array of `{ description, action, reason }`.
//
// Driven entirely through submitLeaveRequest/decideLeaveRequest rather than
// direct inserts. That is the whole point: balances are derived from
// `leave_balance_ledger` and the audit trail is append-only, so hand-writing
// rows here would mean hand-maintaining both — against NFR-2, the top review
// criterion. Going through the services means the data is legal by
// construction, and a successful run is itself evidence those paths work.
//
// Never throws: a refusal (a holiday landing on the chosen date, a balance too
// small, an overlap with something already seeded) is reported and skipped.
// The accounts are the deliverable; the activity is a convenience.
async function seedDemoActivity(employee, manager, leaveType) {
    const results = [];
    const [pendingDate, approvedDate, rejectedDate] = upcomingWorkingDays(14, 3).map((date) => date);

    const cases = [
        { date: pendingDate, reason: "Demo: awaiting the manager's decision", decision: null },
        { date: approvedDate, reason: "Demo: approved leave", decision: { action: "APPROVE", comment: "Approved — enjoy." } },
        {
            date: rejectedDate,
            reason: "Demo: rejected leave",
            decision: { action: "REJECT", comment: "Rejected — two people are already out that week." },
        },
    ];

    for (const item of cases) {
        const label = `${item.decision ? item.decision.action.toLowerCase() : "pending"} request on ${item.date}`;

        try {
            // previewWorkingDays is the same calculation submitLeaveRequest
            // will apply, so checking it first turns "a public holiday happens
            // to fall here" into a clean skip instead of a thrown error.
            const workingDays = await previewWorkingDays({ startDate: item.date, endDate: item.date });
            if (workingDays <= 0) {
                results.push({ description: label, action: "skipped", reason: "no working days (holiday)" });
                continue;
            }

            const request = await submitLeaveRequest(employee.id, {
                leaveTypeId: leaveType.id,
                startDate: item.date,
                endDate: item.date,
                startHalfDay: false,
                endHalfDay: false,
                reason: item.reason,
            });

            if (item.decision) {
                await decideLeaveRequest(
                    { id: manager.id, role: manager.role },
                    request.id,
                    item.decision.action,
                    item.decision.comment
                );
            }

            results.push({ description: label, action: "created" });
        } catch (error) {
            results.push({ description: label, action: "skipped", reason: error.message });
        }
    }

    return results;
}

// Plans, and optionally performs, the demo seed.
//
// Input: `{ apply }` — false (the default) plans without writing anything.
// Output: a report object describing the target, what exists, what would be or
// was created, and what was deliberately left alone.
// Throws when the environment can't support a safe run: no DEMO_PASSWORD, no
// SUPER_ADMIN to hang the chain from, or a missing role row.
//
// Exported separately from the CLI below so it can be driven from a test
// rather than by spawning a process.
export async function seedDemoEnvironment({ apply = false } = {}) {
    const password = process.env.DEMO_PASSWORD;
    if (!password) {
        throw new Error(
            "DEMO_PASSWORD is not set. Set it for this command only (PowerShell: $env:DEMO_PASSWORD=\"...\"); it is deliberately never defaulted and never committed."
        );
    }

    const users = await findAllUsers();
    const superAdmin = users.find((user) => user.role === "SUPER_ADMIN");
    if (!superAdmin) {
        throw new Error(
            "No SUPER_ADMIN exists, so there is nothing to attach the demo chain to. Bootstrap the app first via POST /api/auth/register/hr (see server/README.md), then re-run."
        );
    }

    const leaveTypes = await findAllLeaveTypes({ includeInactive: true });
    const report = {
        target: describeTarget(),
        apply,
        superAdmin: { email: superAdmin.email, name: `${superAdmin.first_name} ${superAdmin.last_name}`.trim() },
        accounts: [],
        activity: [],
        untouched: {
            users: users.length,
            leaveTypes: leaveTypes.length,
            activeLeaveTypes: leaveTypes.filter((type) => type.is_active).length,
        },
    };

    // A plan run still reports which accounts are missing, which is the
    // question it exists to answer — it just resolves that from the database
    // without writing.
    if (!apply) {
        for (const account of DEMO_ACCOUNTS) {
            const existing = await findInviteeByEmail(account.email);
            report.accounts.push({
                email: account.email,
                role: account.role,
                action: existing ? "exists" : "would create",
            });
        }
        report.activity.push({
            description: "demo leave requests (pending / approved / rejected)",
            action: report.accounts.every((entry) => entry.action === "exists") ? "skipped" : "would create",
            reason: report.accounts.every((entry) => entry.action === "exists") ? "accounts already present" : undefined,
        });
        return report;
    }

    // One hash for all three: bcrypt salts internally, so the stored hashes
    // still differ, and this avoids paying the cost factor three times.
    const passwordHash = await hashPassword(password);

    let managerId = superAdmin.id;
    const created = {};

    for (const account of DEMO_ACCOUNTS) {
        const role = await findRoleByName(account.role);
        if (!role) {
            throw new Error(`Role ${account.role} is not configured — check the roles table.`);
        }

        const result = await ensureAccount(account, managerId, role.id, passwordHash);
        report.accounts.push({ email: result.email, role: result.role, action: result.action });
        created[account.role] = result.user;

        // The next account reports to this one, whether it was just created or
        // already existed — so a partially-seeded database still ends up with
        // the right chain.
        managerId = result.user.id;
    }

    const anyAccountCreated = report.accounts.some((entry) => entry.action === "created");
    const leaveType = pickDemoLeaveType(leaveTypes);

    if (!anyAccountCreated) {
        report.activity.push({
            description: "demo leave requests",
            action: "skipped",
            reason: "all demo accounts already existed, so this run added nothing",
        });
    } else if (!leaveType) {
        report.activity.push({
            description: "demo leave requests",
            action: "skipped",
            reason: "no active leave type with entitlement >= 5 that doesn't require a document",
        });
    } else {
        const activity = await seedDemoActivity(created.EMPLOYEE, created.MANAGER, leaveType);
        report.activity.push(...activity);
        report.leaveTypeUsed = leaveType.name;
    }

    return report;
}

// ---------------------------------------------------------------- CLI wrapper

function printReport(report, { apply }) {
    console.log(`Target: ${report.target}\n`);
    console.log(`Chain root: ${report.superAdmin.name} <${report.superAdmin.email}> (existing SUPER_ADMIN)\n`);

    console.log(apply ? "Accounts:" : "Accounts (plan only — nothing written):");
    for (const account of report.accounts) {
        console.log(`  ${account.action.padEnd(12)} ${account.email.padEnd(28)} ${account.role}`);
    }

    if (report.activity.length) {
        console.log("\nDemo leave activity:");
        for (const item of report.activity) {
            const reason = item.reason ? ` — ${item.reason}` : "";
            console.log(`  ${item.action.padEnd(12)} ${item.description}${reason}`);
        }
    }

    if (report.leaveTypeUsed) {
        console.log(`\nLeave type used for demo activity: ${report.leaveTypeUsed}`);
    }

    console.log(
        `\nLeft untouched: ${report.untouched.users} existing user(s), ` +
            `${report.untouched.leaveTypes} leave type(s) (${report.untouched.activeLeaveTypes} active), ` +
            `every holiday, and all existing leave/balance/ledger/payroll records.`
    );
}

async function main() {
    const flags = process.argv.slice(2);
    const apply = flags.includes("--yes");
    const allowProduction = flags.includes("--allow-production");

    try {
        // Checked before anything is read, and named explicitly in the message:
        // DATABASE_URL is how this project's Render database is configured, and
        // it staying set in a shell is exactly how a local command ends up
        // pointed at production.
        if (apply && looksLikeProduction() && !allowProduction) {
            console.error(`Target: ${describeTarget()}\n`);
            console.error(
                "Refusing to write: this looks like a managed or production database " +
                    "(NODE_ENV=production, or DATABASE_URL is set).\n" +
                    "Re-run with --allow-production if that is genuinely what you want."
            );
            process.exitCode = 1;
            return;
        }

        const report = await seedDemoEnvironment({ apply });
        printReport(report, { apply });

        if (!apply) {
            console.log("\nNothing was written. Re-run with --yes to apply.");
        }
    } catch (error) {
        console.error(`Target: ${describeTarget()}\n`);
        console.error(error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

// Only run when invoked directly, so importing this from a test doesn't seed
// anything or close the shared pool.
if (process.argv[1] && process.argv[1].endsWith("seedDemo.js")) {
    await main();
}
