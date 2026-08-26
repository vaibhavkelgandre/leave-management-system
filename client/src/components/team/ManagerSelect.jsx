const ROLE_GROUP_LABELS = {
    SUPER_ADMIN: "Super admin",
    HR_ADMIN: "HR admins",
    MANAGER: "Managers",
};

// `currentUserId`: labels that option "You" instead of their own name —
// most relevant when `targetRole` is "HR_ADMIN" (the inviting/editing HR
// admin themself is almost always the natural default), but harmless to
// apply everywhere a manager candidate happens to be the viewer.
export function ManagerSelect({ id, label, value, onChange, options, allowNone = true, targetRole, required, currentUserId }) {
    const grouped = options.reduce((groups, option) => {
        (groups[option.role] ||= []).push(option);
        return groups;
    }, {});

    // A freshly set-up organisation has only a SUPER_ADMIN, and the reporting
    // rules (reportingService.ALLOWED_MANAGER_ROLES) let SUPER_ADMIN be the
    // manager of an HR_ADMIN and nothing else. So picking "Employee" or
    // "Manager" as the very first invite leaves this list genuinely empty —
    // and an empty <select> with no explanation reads as a broken form rather
    // than as "invite an HR admin first", which is the actual next step.
    const hasCandidates = options.length > 0;

    const helperText = !hasCandidates
        ? targetRole === "MANAGER"
          ? "There's no HR admin to report to yet. Invite an HR admin first — managers can only report to one."
          : "There's no manager or HR admin to report to yet. Invite an HR admin first, and they can build out the rest of the team."
        : targetRole === "MANAGER"
          ? "Managers report directly to an HR admin — pick who they'll answer to."
          : targetRole === "HR_ADMIN"
            ? "HR admins report to whichever HR admin created them — pick yourself or another HR admin."
            : "Pick the person they'll go to for approvals and questions.";

    return (
        <div>
            <div className="relative">
                <select
                    id={id}
                    aria-label={label}
                    value={value}
                    onChange={onChange}
                    required={required}
                    disabled={!hasCandidates && !allowNone}
                    className={`w-full appearance-none rounded-md border border-slate-300 px-3 py-2 pr-8 text-sm shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                        !hasCandidates && !allowNone
                            ? "cursor-not-allowed bg-slate-50 text-slate-400"
                            : "cursor-pointer bg-white text-slate-900 hover:border-indigo-300"
                    }`}
                >
                    {allowNone && <option value="">No manager</option>}
                    {!allowNone && (
                        <option value="" disabled>
                            {hasCandidates ? "Who will they report to?" : "Nobody available yet"}
                        </option>
                    )}
                    {["SUPER_ADMIN", "HR_ADMIN", "MANAGER"].map(
                        (role) =>
                            grouped[role]?.length > 0 && (
                                <optgroup key={role} label={ROLE_GROUP_LABELS[role]}>
                                    {grouped[role].map((option) => (
                                        <option key={option.id} value={option.id}>
                                            {option.id === currentUserId ? "You" : `${option.first_name} ${option.last_name}`}
                                        </option>
                                    ))}
                                </optgroup>
                            )
                    )}
                </select>
                <svg
                    className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                >
                    <path
                        fillRule="evenodd"
                        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                        clipRule="evenodd"
                    />
                </svg>
            </div>
            <p className={`mt-1 text-xs ${hasCandidates ? "text-slate-500" : "font-medium text-amber-700"}`}>
                {helperText}
            </p>
        </div>
    );
}
