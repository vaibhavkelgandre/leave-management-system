// One person's row, shared by the read-only "All Employees" org view
// (EmployeesPage.jsx, `showActions={false}`) and the interactive "My Team"
// page (TeamPage.jsx, actions on by default) — the manager-reassign/
// activate-deactivate logic lives in exactly one place regardless of which
// page a person is currently rendered on. Renders as a single `<tr>` meant
// to sit inside EmployeeTable.jsx's `<table>`, never rendered standalone.
// The manager-edit form is a **separate full-width row** under the person's
// own (same pattern as SalarySlipList.jsx's void-reason prompt), reversing an
// earlier "keep it in the Employee cell" decision that turned out to break
// the table: ManagerSelect renders a `w-full` <select> *plus* helper text, and
// a cell can't contain something wider than its column without stretching it,
// so opening the dropdown visibly re-laid-out every column. A `colSpan` row
// is the only version that can't affect column widths at all. Short
// per-person errors (a failed status toggle) do stay in the cell.
import { useState } from "react";
import { Check, Pencil, UserCheck, UserCog, UserX, X } from "lucide-react";
import { updateManager, updateRole, updateStatus } from "../../services/userService.js";
import { toErrorMessage } from "../../services/httpError.js";
import { useAuth } from "../../hooks/useAuth.js";
import { ManagerSelect } from "./ManagerSelect.jsx";
import { Avatar } from "../ui/Avatar.jsx";
import { IconButton } from "../ui/IconButton.jsx";
import { Badge, RoleBadge, StatusBadge } from "../ui/Badge.jsx";
import { ROLE_LABELS, STATUS_BADGE_CLASSES } from "../../constants/badges.js";
import { ROLES } from "../../constants/roles.js";

const ALLOWED_MANAGER_ROLES = {
    MANAGER: ["HR_ADMIN"],
    EMPLOYEE: ["MANAGER", "HR_ADMIN"],
    // An HR admin's manager must be another HR admin — specifically
    // whichever HR admin created them (see the edit-permission note below) —
    // or the single SUPER_ADMIN.
    HR_ADMIN: ["HR_ADMIN", "SUPER_ADMIN"],
};

// The roles HR may promote or demote someone into. Deliberately the same
// three the invite form offers, because role *change* permits exactly what
// role *creation* permits — and SUPER_ADMIN is a schema-enforced singleton the
// server refuses as a destination outright.
const ASSIGNABLE_ROLES = ["EMPLOYEE", "MANAGER", "HR_ADMIN"];

const tdClasses = "px-3 py-3 align-top text-sm text-slate-700";

// Badge cells get 4px of left padding instead of the usual 12px, so that the
// badge's own `px-2` makes up the difference and its *text* starts exactly
// where the column heading's does. With a flat `px-3` everywhere the pill's
// padding stacked on the cell's and every badge column read as indented ~8px
// relative to its heading, which is what made the whole table look subtly
// misaligned next to the plain-text columns.
const badgeTdClasses = "py-3 pr-3 pl-1 align-top text-sm text-slate-700";

// One action control's footprint, matching IconButton's own `md` size. Rendered
// in place of a control the viewer can't use so the remaining icons stay in
// their own column: every row's "change manager" button lines up with every
// other row's, and likewise for activate/deactivate. Without it the flex row's
// `justify-end` slid a lone pencil into the status toggle's position, so the
// two controls appeared to swap places from row to row.
function ActionSlot() {
    return <span className="h-9 w-9 shrink-0" aria-hidden="true" />;
}

function dash(value) {
    return value || "—";
}

// `showReportsTo`/`showActions`/`showProfileStatus`: passed down from
// EmployeeTable.jsx, which owns the `<thead>` these rows must match
// column-for-column — see that file for what decides each flag.
// `highlighted`: tints the row (the manager's own row atop their team's
// table, EmployeeTeamCard.jsx) so it reads as that table's header rather
// than just another report, without needing a second component.
export function EmployeePersonRow({
    user,
    users,
    onChanged,
    showReportsTo = false,
    showActions = true,
    showProfileStatus = false,
    showPhone = true,
    highlighted = false,
    columnCount = 1,
}) {
    const { user: currentUser } = useAuth();
    const [isEditingManager, setIsEditingManager] = useState(false);
    const [selectedManagerId, setSelectedManagerId] = useState(user.manager_id || "");
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    const [statusError, setStatusError] = useState(null);
    const [statusSaving, setStatusSaving] = useState(false);

    const [isEditingRole, setIsEditingRole] = useState(false);
    const [selectedRole, setSelectedRole] = useState(user.role);
    // Tracked separately from `selectedManagerId` because a role change can
    // *require* a reporting-line change that the manager editor would never
    // make on its own: a MANAGER may only report to an HR_ADMIN, so promoting
    // an employee who reports to a manager is only legal together with a new
    // manager. The server takes both in one call for exactly that reason.
    const [selectedRoleManagerId, setSelectedRoleManagerId] = useState(user.manager_id || "");
    const [roleError, setRoleError] = useState(null);
    const [roleSaving, setRoleSaving] = useState(false);

    // Both endpoints behind these controls (PATCH /users/:id/manager and
    // /status) are `requireRole("HR_ADMIN", "SUPER_ADMIN")` server-side, so
    // HR-tier is the whole client-side rule — a plain MANAGER is offered
    // neither, on any row, because the request would 403 whatever the row
    // says. Deliberately *not* also checking `user.invited_by` here: the
    // service's own rule is "the creator OR someone in my HR scope", and
    // actions only ever render on My Team (TeamPage.jsx), whose rows are the
    // viewer's own subtree by construction — so scope is already satisfied
    // for every row an HR-tier viewer can see, and re-checking creation would
    // just hide controls for anyone they inherited rather than invited. The
    // server re-checks per request regardless.
    const canManagePeople = currentUser.role === ROLES.HR_ADMIN || currentUser.role === ROLES.SUPER_ADMIN;
    const manager = users.find((u) => u.id === user.manager_id);
    const allowedManagerRoles = ALLOWED_MANAGER_ROLES[user.role] || [];
    const managerOptions = users.filter((u) => u.id !== user.id && allowedManagerRoles.includes(u.role));
    const fullName = `${user.first_name} ${user.last_name}`;
    const isSelf = user.id === currentUser.id;
    const isActive = user.status === "ACTIVE";
    const isInvited = user.status === "INVITED";
    // One flag, two controls: they've always had identical permissions, and
    // two names that could drift apart was the more confusing shape.
    const canEditManager = canManagePeople;
    const canEditStatus = canManagePeople;
    // Two extra conditions beyond HR-tier, both of which the server refuses
    // anyway — offered here only so the control isn't a button that can just
    // fail: the super admin's role is unchangeable (demoting the root would be
    // unrecoverable, since a second one cannot be created), and nobody may
    // change their own role.
    const canEditRole = canManagePeople && !isSelf && user.role !== ROLES.SUPER_ADMIN;

    // Recomputed from whichever role is currently selected in the editor, not
    // from `user.role` — the whole point is to offer the managers the *new*
    // role permits.
    const roleManagerOptions = users.filter(
        (u) => u.id !== user.id && (ALLOWED_MANAGER_ROLES[selectedRole] || []).includes(u.role)
    );

    function startEditing() {
        setSelectedManagerId(user.manager_id || "");
        setError(null);
        setIsEditingRole(false);
        setIsEditingManager(true);
    }

    function startEditingRole() {
        setSelectedRole(user.role);
        setSelectedRoleManagerId(user.manager_id || "");
        setRoleError(null);
        setIsEditingManager(false);
        setIsEditingRole(true);
    }

    function cancelEditingRole() {
        setIsEditingRole(false);
        setRoleError(null);
    }

    // Re-picks the reporting line whenever the chosen role changes, keeping the
    // existing manager when the new role still permits them and clearing it
    // when it doesn't — so HR is asked for a new one instead of submitting a
    // combination the server will refuse. A plain event handler rather than an
    // effect on `selectedRole`, which would trip `set-state-in-effect`.
    function handleRoleSelect(nextRole) {
        setSelectedRole(nextRole);
        const allowed = ALLOWED_MANAGER_ROLES[nextRole] || [];
        setSelectedRoleManagerId(manager && allowed.includes(manager.role) ? manager.id : "");
    }

    async function saveRole() {
        setRoleSaving(true);
        setRoleError(null);
        try {
            // managerId is always sent, so what HR saw in the picker is
            // exactly what gets applied — an omitted key would mean "leave the
            // stored line alone", which is not what an emptied picker says.
            await updateRole(user.id, { role: selectedRole, managerId: selectedRoleManagerId || null });
            setIsEditingRole(false);
            await onChanged();
        } catch (err) {
            setRoleError(toErrorMessage(err, "Unable to update role"));
        } finally {
            setRoleSaving(false);
        }
    }

    function cancelEditing() {
        setIsEditingManager(false);
        setError(null);
    }

    async function saveManager() {
        setSaving(true);
        setError(null);
        try {
            await updateManager(user.id, selectedManagerId || null);
            setIsEditingManager(false);
            await onChanged();
        } catch (err) {
            setError(toErrorMessage(err, "Unable to update manager"));
        } finally {
            setSaving(false);
        }
    }

    async function toggleStatus() {
        const nextStatus = isActive ? "INACTIVE" : "ACTIVE";
        setStatusSaving(true);
        setStatusError(null);
        try {
            await updateStatus(user.id, nextStatus);
            await onChanged();
        } catch (err) {
            setStatusError(toErrorMessage(err, "Unable to update status"));
        } finally {
            setStatusSaving(false);
        }
    }

    // The person's row, then (only while editing) the manager-edit row — two
    // sibling <tr>s in a fragment rather than one row, which is what keeps the
    // form out of any single column.
    const personRow = (
        <tr
            className={`transition hover:bg-slate-50/80 ${
                isSelf ? "bg-indigo-50/60" : highlighted ? "bg-indigo-50/40" : ""
            }`}
        >
            <td className={tdClasses}>
                <div className="flex min-w-0 items-start gap-3">
                    <Avatar firstName={user.first_name} lastName={user.last_name} size="sm" />
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-slate-900">{fullName}</span>
                            {isSelf && <Badge className="bg-indigo-100 text-indigo-700">You</Badge>}
                        </div>

                        {error && !isEditingManager && (
                            <p role="alert" className="mt-1 text-xs text-red-600">
                                {error}
                            </p>
                        )}
                        {statusError && (
                            <p role="alert" className="mt-1 text-xs text-red-600">
                                {statusError}
                            </p>
                        )}
                    </div>
                </div>
            </td>
            <td className={tdClasses}>{dash(user.designation)}</td>
            <td className={tdClasses}>{dash(user.department)}</td>
            <td className={badgeTdClasses}>
                <RoleBadge role={user.role} />
            </td>
            <td className={badgeTdClasses}>
                <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={user.status} />
                    {showProfileStatus && user.profile_status && (
                        <Badge className={STATUS_BADGE_CLASSES[user.profile_status]}>{user.profile_status}</Badge>
                    )}
                </div>
            </td>
            <td className={tdClasses}>{user.email}</td>
            {showPhone && <td className={tdClasses}>{dash(user.phone)}</td>}
            {showReportsTo && (
                <td className={tdClasses}>{manager ? `${manager.first_name} ${manager.last_name}` : "—"}</td>
            )}
            {showActions && (
                <td className={`${tdClasses} text-right whitespace-nowrap`}>
                    {/* Three fixed slots, always all rendered, so the icons
                        form straight columns down the table instead of drifting
                        with however many controls a given row happens to offer.
                        Order is fixed too: change-manager, change-role, status. */}
                    <div className="flex shrink-0 items-center justify-end gap-1">
                        {canEditManager && !isEditingManager ? (
                            <IconButton icon={Pencil} label="Change manager" tooltipPortal onClick={startEditing} />
                        ) : (
                            <ActionSlot />
                        )}
                        {canEditRole && !isEditingRole ? (
                            <IconButton icon={UserCog} label="Change role" tooltipPortal onClick={startEditingRole} />
                        ) : (
                            <ActionSlot />
                        )}
                        {/* Your own row keeps showing this (disabled) even though
                            you didn't "create yourself" — deactivating yourself is
                            already independently blocked below, and hiding it
                            entirely here would read as a missing control rather
                            than an intentional one. An invited-but-not-yet-joined
                            account gets the same treatment for the same reason,
                            and it's genuinely not actionable yet: `updateStatus`
                            moves a row between ACTIVE and INACTIVE, and INVITED
                            is neither — the account only becomes deactivatable
                            once the person accepts and turns ACTIVE. Showing the
                            control greyed out says "this will be here" where an
                            absent icon just looked like a hole in the column. */}
                        {isInvited || isSelf || canEditStatus ? (
                            <IconButton
                                icon={isInvited || isActive ? UserX : UserCheck}
                                label={
                                    isInvited
                                        ? `Deactivate — available once ${user.first_name} accepts the invite`
                                        : isSelf
                                          ? "You cannot deactivate your own account"
                                          : isActive
                                            ? "Deactivate"
                                            : "Activate"
                                }
                                variant={isInvited || isActive ? "danger" : "success"}
                                loading={statusSaving}
                                disabled={isInvited || isSelf}
                                tooltipPortal
                                onClick={toggleStatus}
                            />
                        ) : (
                            <ActionSlot />
                        )}
                    </div>
                </td>
            )}
        </tr>
    );

    if (isEditingRole) {
        return (
            <>
                {personRow}
                <tr className="bg-slate-50/80">
                    <td colSpan={columnCount} className="px-3 pb-3">
                        {roleError && (
                            <p role="alert" className="mb-1 text-xs text-red-600">
                                {roleError}
                            </p>
                        )}
                        <div className="flex max-w-xl flex-wrap items-start gap-1.5">
                            <div className="min-w-0 flex-1">
                                <label
                                    htmlFor={`role-${user.id}`}
                                    className="mb-1 block text-xs font-medium text-slate-700"
                                >
                                    {`Role for ${fullName}`}
                                </label>
                                <select
                                    id={`role-${user.id}`}
                                    value={selectedRole}
                                    onChange={(event) => handleRoleSelect(event.target.value)}
                                    className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                >
                                    {ASSIGNABLE_ROLES.map((role) => (
                                        <option key={role} value={role}>
                                            {ROLE_LABELS[role]}
                                        </option>
                                    ))}
                                </select>
                                {/* Said out loud because it is the surprising
                                    part: a role is not authority in this app.
                                    Approval rights come from whose reporting
                                    line points at you, so a promotion on its
                                    own would otherwise look like it did
                                    nothing. */}
                                {selectedRole === ROLES.MANAGER && user.role !== ROLES.MANAGER && (
                                    <p className="mt-1 text-xs text-slate-500">
                                        Managers only approve leave for people who report to them — move their
                                        reporting lines here too.
                                    </p>
                                )}
                            </div>
                            {selectedRole !== user.role && (
                                <div className="min-w-0 flex-1">
                                    <ManagerSelect
                                        id={`role-manager-${user.id}`}
                                        label="Reports to"
                                        value={selectedRoleManagerId}
                                        onChange={(event) => setSelectedRoleManagerId(event.target.value)}
                                        options={roleManagerOptions}
                                        targetRole={selectedRole}
                                        currentUserId={currentUser.id}
                                    />
                                </div>
                            )}
                            <div className="flex items-start gap-1.5 pt-6">
                                <IconButton
                                    icon={Check}
                                    label="Save"
                                    variant="primary"
                                    loading={roleSaving}
                                    disabled={selectedRole === user.role}
                                    tooltipPortal
                                    onClick={saveRole}
                                />
                                <IconButton icon={X} label="Cancel" variant="ghost" tooltipPortal onClick={cancelEditingRole} />
                            </div>
                        </div>
                    </td>
                </tr>
            </>
        );
    }

    if (!isEditingManager) return personRow;

    return (
        <>
            {personRow}
            <tr className="bg-slate-50/80">
                <td colSpan={columnCount} className="px-3 pb-3">
                    {error && (
                        <p role="alert" className="mb-1 text-xs text-red-600">
                            {error}
                        </p>
                    )}
                    {/* Capped at a readable width and left-aligned rather than
                        stretched across every column — a full-width <select>
                        on a wide table would be absurd; the row exists for the
                        layout guarantee, not to use all the space. */}
                    <div className="flex max-w-md items-start gap-1.5">
                        <div className="min-w-0 flex-1">
                            <ManagerSelect
                                id={`manager-${user.id}`}
                                label={`Manager for ${fullName}`}
                                value={selectedManagerId}
                                onChange={(event) => setSelectedManagerId(event.target.value)}
                                options={managerOptions}
                                targetRole={user.role}
                                currentUserId={currentUser.id}
                            />
                        </div>
                        <IconButton icon={Check} label="Save" variant="primary" loading={saving} tooltipPortal onClick={saveManager} />
                        <IconButton icon={X} label="Cancel" variant="ghost" tooltipPortal onClick={cancelEditing} />
                    </div>
                </td>
            </tr>
        </>
    );
}
