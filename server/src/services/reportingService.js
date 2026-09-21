// The reporting tree: who may report to whom, and the walks that answer "is
// this person in my team?".
//
// ALLOWED_MANAGER_ROLES below is the single server-side definition of
// reporting-line eligibility. Three places in the client hold their own copy of
// it for form filtering, so changing it here means changing those too — or the
// UI offers a reporting line the server will refuse.
//
// The subtree walks are recursive CTEs in the repository, and they are what
// every row-level authorization check in the app ultimately rests on.
import {
    findSubtreeUsers,
    countSubtreeUsers,
    findUserById,
    isUserInSubtree,
} from "../repositories/userRepository.js";
import { badRequest, conflict } from "../utils/appError.js";

// Encodes the reporting-line hierarchy rule for the org: an EMPLOYEE may
// report to a MANAGER or directly to HR_ADMIN, a MANAGER may only report to
// HR_ADMIN (managers can't report to other managers), and an HR_ADMIN may
// report to another HR_ADMIN — specifically whichever HR admin created them,
// forming a chain (A invites B, B reports to A; B invites C, C reports to B
// or A, whichever the inviting HR picks — see InviteEmployeeForm.jsx) — or to
// the single SUPER_ADMIN. SUPER_ADMIN itself is the true root of the tree,
// created once via POST /auth/register/hr, and is absent from this map
// entirely: assertManagerAllowed's `ALLOWED_MANAGER_ROLES[targetRole] || []`
// fallback already treats a missing key as "no manager ever allowed," so
// SUPER_ADMIN can never be assigned a manager through any code path.
const ALLOWED_MANAGER_ROLES = {
    EMPLOYEE: ["MANAGER", "HR_ADMIN"],
    MANAGER: ["HR_ADMIN"],
    HR_ADMIN: ["HR_ADMIN", "SUPER_ADMIN"],
};

// Answers the map's question without a database round trip: may someone whose
// role is `managerRole` be the manager of someone whose role is `targetRole`?
//
// Input: two role names. Output: boolean — `false` for any role with no entry
// in the map, which is what keeps SUPER_ADMIN unmanageable.
//
// Exists because `assertManagerAllowed` below takes a manager *id* and looks
// the row up, which is the wrong shape for two callers that already hold both
// roles in hand: a role change has to ask "would this person's existing
// reports still be legally managed afterwards?" for each report, and asking it
// as N id-lookups would re-fetch rows the caller already has. Kept here rather
// than exporting the raw map so the map stays the single definition.
export function isManagerRoleAllowedFor(targetRole, managerRole) {
    return (ALLOWED_MANAGER_ROLES[targetRole] || []).includes(managerRole);
}

// Whether a role is allowed to exist with no manager at all.
//
// Input: a role name. Output: boolean.
//
// Only MANAGER may sit without one (and SUPER_ADMIN, which never has one) —
// an EMPLOYEE with no manager has nobody to approve their leave, and an
// HR_ADMIN with none is the manager-less-root gap SUPER_ADMIN was introduced
// to close, so neither should be reachable by editing an existing account.
// `inviteEmployeeSchema` enforces the same rule at creation time; this is the
// copy a *change* to an existing account is checked against, which the schema
// cannot do because it never sees the stored row.
export function roleRequiresManager(role) {
    return role === "EMPLOYEE" || role === "HR_ADMIN";
}

// Returns everyone under a user in the reporting tree (used for the "my team"
// view) — excludes the user themselves so it's just their reports.
export async function getTeam(userId) {
    const subtree = await findSubtreeUsers(userId);
    return subtree.filter((user) => user.id !== userId);
}

// The count-only counterpart to getTeam above, for the dashboard's headcount
// chip — see userRepository.countSubtreeUsers for why that tile shouldn't be
// pulling every row of a 200-person subtree to read `.length`.
export async function getTeamSize(userId) {
    return countSubtreeUsers(userId);
}

// Shared by invite (brand-new user, no cycle possible yet) and reassignment
// (existing user, checked for cycles separately by assertNoCycle below).
export async function assertManagerAllowed(targetRole, newManagerId) {
    if (!newManagerId) {
        return null;
    }

    const manager = await findUserById(newManagerId);
    if (!manager || manager.status === "INACTIVE") {
        throw badRequest("Manager not found");
    }

    const allowedRoles = ALLOWED_MANAGER_ROLES[targetRole] || [];
    if (!allowedRoles.includes(manager.role)) {
        throw badRequest(
            targetRole === "MANAGER"
                ? "A manager's manager must be an HR admin"
                : targetRole === "HR_ADMIN"
                  ? "An HR admin's manager must be another HR admin"
                  : "Only a manager or HR admin can be assigned as a manager"
        );
    }

    return manager;
}

// Guards every manager reassignment against creating an infinite reporting
// loop. Naively setting user A's manager to B is fine on its own, but if B is
// already A's direct or indirect subordinate, A would end up reporting to
// someone who reports to A — a cycle with no top of the tree. isUserInSubtree
// walks B's ancestry-free subtree check (is A's candidate manager already
// underneath A?) to catch that case before it's written to the database.
export async function assertNoCycle(userId, newManagerId, targetRole) {
    if (!newManagerId) {
        return;
    }

    if (newManagerId === userId) {
        throw badRequest("A user cannot be their own manager");
    }

    await assertManagerAllowed(targetRole, newManagerId);

    const wouldCreateCycle = await isUserInSubtree(userId, newManagerId);
    if (wouldCreateCycle) {
        throw conflict("Assigning this manager would create a reporting cycle");
    }
}
