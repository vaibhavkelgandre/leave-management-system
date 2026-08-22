import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { getUserOptions, inviteEmployee } from "../../services/userService.js";
import { toErrorMessage } from "../../services/httpError.js";
import { isValidEmail } from "../../utils/validation.js";
import { useAuth } from "../../hooks/useAuth.js";
import { ROLES } from "../../constants/roles.js";
import { Button } from "../ui/Button.jsx";
import { ManagerSelect } from "./ManagerSelect.jsx";

const emptyForm = { firstName: "", lastName: "", email: "", role: ROLES.EMPLOYEE, managerId: "" };

const inputClasses =
    "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
const labelClasses = "mb-1 block text-sm font-medium text-slate-700";

// `secondaryAction`: an optional node (e.g. a "Back"/"Cancel" link) rendered
// next to the Invite button itself, right-aligned, rather than stacked
// full-width below the form — AddEmployeePage.jsx uses this so both actions
// sit in one compact row instead of each spanning the form's full width.
export function InviteEmployeeForm({ onInvited, secondaryAction }) {
    const { user: currentUser } = useAuth();
    // Only needed to populate the manager dropdown — null until loaded so no
    // setState happens synchronously inside the effect.
    const [users, setUsers] = useState(null);

    const [form, setForm] = useState(emptyForm);
    const [inviteError, setInviteError] = useState(null);
    const [inviteResult, setInviteResult] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let cancelled = false;

        getUserOptions()
            .then((data) => {
                if (!cancelled) setUsers(data);
            })
            .catch(() => {
                // A failed load only costs us the manager suggestions; the form
                // itself still works, so this isn't surfaced as a page error.
                if (!cancelled) setUsers([]);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    function handleChange(event) {
        const { name, value } = event.target;
        setForm((prev) => ({
            ...prev,
            [name]: value,
            // Who they may report to depends on the role, so a previously picked
            // person can become invalid — clear it rather than submit a bad pair.
            // Switching to HR_ADMIN defaults to the inviter themself ("You") —
            // a new HR admin reports to whoever created them by default, still
            // changeable to another HR admin below.
            ...(name === "role" ? { managerId: value === ROLES.HR_ADMIN ? currentUser.id : "" } : {}),
        }));
    }

    // Mirrors the server's hierarchy rule (reportingService.js): an employee
    // may report to a manager or an HR admin, a manager only to an HR admin,
    // and an HR admin to another HR admin or to the super admin. Spelled out
    // explicitly (rather than "!== EMPLOYEE") now that a 4th role exists —
    // an employee/manager must never see SUPER_ADMIN as an option here.
    const reportingOptions = (users ?? []).filter((u) => {
        if (form.role === ROLES.HR_ADMIN) return u.role === ROLES.HR_ADMIN || u.role === ROLES.SUPER_ADMIN;
        if (form.role === ROLES.MANAGER) return u.role === ROLES.HR_ADMIN;
        return u.role === ROLES.MANAGER || u.role === ROLES.HR_ADMIN;
    });

    const reportingLabel =
        form.role === ROLES.MANAGER ? "Reporting HR admin" : form.role === ROLES.HR_ADMIN ? "Reports to" : "Manager";

    async function handleInvite(event) {
        event.preventDefault();
        setInviteError(null);
        setInviteResult(null);

        // The browser's type="email" check accepts a domain with no dot (e.g.
        // "viraj@123"), which the server then rejects. Catch it here so the user
        // gets a precise message instead of a failed round-trip.
        if (!isValidEmail(form.email.trim())) {
            setInviteError("Enter a valid email address");
            return;
        }

        setSubmitting(true);

        try {
            // Every role picks a reporting line now, including HR_ADMIN — an
            // HR admin's manager must be another HR admin (their creator, by
            // default). Only the root HR_ADMIN(s), created via the separate
            // public /register/hr flow rather than this form, ever have no
            // manager at all.
            const result = await inviteEmployee(form);
            setInviteResult(result);
            setForm(emptyForm);
            onInvited?.();
        } catch (err) {
            setInviteError(toErrorMessage(err, "Unable to invite employee"));
        } finally {
            setSubmitting(false);
        }
    }

    async function handleCopyLink() {
        try {
            await navigator.clipboard.writeText(inviteResult.inviteLink);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard access can fail (permissions, insecure context) — the
            // link is still visible to copy by hand, so this fails silently.
        }
    }

    return (
        <div>
            <p className="text-sm text-slate-500">
                We'll email them a single-use link to set their own password. It expires within hours, so invite
                them when they're ready to start.
            </p>

            <form onSubmit={handleInvite} className="mt-4 space-y-4">
                {inviteError && (
                    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                        {inviteError}
                    </p>
                )}

                {/* A horizontal grid, not one field per row — with only 5
                    fields this fits in two compact rows on anything wider
                    than a phone, so the Invite button stays visible without
                    scrolling instead of trailing a long vertical stack. */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                        <label htmlFor="firstName" className={labelClasses}>
                            First name
                        </label>
                        <input
                            id="firstName"
                            name="firstName"
                            value={form.firstName}
                            onChange={handleChange}
                            required
                            className={inputClasses}
                        />
                    </div>

                    <div>
                        <label htmlFor="lastName" className={labelClasses}>
                            Last name
                        </label>
                        <input
                            id="lastName"
                            name="lastName"
                            value={form.lastName}
                            onChange={handleChange}
                            required
                            className={inputClasses}
                        />
                    </div>

                    <div>
                        <label htmlFor="email" className={labelClasses}>
                            Email
                        </label>
                        <input
                            id="email"
                            name="email"
                            type="email"
                            value={form.email}
                            onChange={handleChange}
                            required
                            className={inputClasses}
                        />
                    </div>

                    <div>
                        <label htmlFor="role" className={labelClasses}>
                            Role
                        </label>
                        <select
                            id="role"
                            name="role"
                            value={form.role}
                            onChange={handleChange}
                            className={inputClasses}
                        >
                            <option value={ROLES.EMPLOYEE}>Employee</option>
                            <option value={ROLES.MANAGER}>Manager</option>
                            <option value={ROLES.HR_ADMIN}>HR Admin</option>
                        </select>
                    </div>

                    <div className="sm:col-span-2">
                        <label htmlFor="managerId" className={labelClasses}>
                            {reportingLabel}
                        </label>
                        <ManagerSelect
                            id="managerId"
                            label={reportingLabel}
                            value={form.managerId}
                            onChange={(event) => setForm((prev) => ({ ...prev, managerId: event.target.value }))}
                            options={reportingOptions}
                            targetRole={form.role}
                            allowNone={false}
                            required
                            currentUserId={currentUser.id}
                        />
                    </div>
                </div>

                {/* Right-aligned, content-sized buttons — not stretched to
                    match the input fields above, same weight as any other
                    form's action row in this app (e.g. PayrollRunForm.jsx). */}
                <div className="flex items-center justify-end gap-2 pt-2">
                    {secondaryAction}
                    <Button type="submit" loading={submitting}>
                        Invite
                    </Button>
                </div>
            </form>

            {/* Two shapes, deliberately not one: when the email went out, the
                link is a fallback and is shown as such (small, secondary);
                when it didn't — SMTP unconfigured, the flow switched off via
                MAIL_FEATURE_EMPLOYEE_INVITE, or a send failure — the link is
                the *only* way to onboard this person, so it's promoted back to
                the headline with a warning that nothing was sent. Server-side
                `emailSent` decides, since only the server knows which of those
                happened. */}
            {inviteResult && (
                <div
                    className={`mt-6 rounded-md px-3 py-3 text-sm ${
                        inviteResult.emailSent ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-900"
                    }`}
                >
                    <p className="font-medium">
                        {inviteResult.emailSent
                            ? `${inviteResult.reissued ? "Invitation resent" : "Invited"}. We emailed the link to ${
                                  inviteResult.user?.email ?? "them"
                              }.`
                            : `${
                                  inviteResult.reissued ? "New link created" : "Invited"
                              }, but the email wasn't sent — share this link with them yourself:`}
                    </p>
                    {/* Only shown for a resend, and it isn't a nicety: the
                        server reissues against the stored row and ignores the
                        name/role/reporting line submitted with it, so anything
                        HR retyped in this form was silently not applied.
                        Saying so here is the only place they'd find out. */}
                    {inviteResult.reissued && (
                        <p className="mt-2 text-xs">
                            This address already had a pending invitation, so the previous link stopped working. Their
                            existing name, role and reporting line were kept — change those from My Team.
                        </p>
                    )}
                    {inviteResult.inviteLink ? (
                        <>
                            {inviteResult.emailSent && (
                                <p className="mt-2 text-xs text-green-700">
                                    If it doesn't arrive, share this link instead:
                                </p>
                            )}
                            <div className="mt-2 flex items-center gap-2">
                                <code className="block flex-1 break-all rounded bg-white/70 px-2 py-1.5 text-xs">
                                    {inviteResult.inviteLink}
                                </code>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    icon={copied ? Check : Copy}
                                    onClick={handleCopyLink}
                                >
                                    {copied ? "Copied" : "Copy"}
                                </Button>
                            </div>
                            <p
                                className={`mt-3 text-xs ${
                                    inviteResult.emailSent ? "text-green-700" : "text-amber-800"
                                }`}
                            >
                                Open it in a private window — following it in this browser would sign you in as
                                them.
                            </p>
                        </>
                    ) : (
                        // No link at all means the server couldn't build one
                        // (CLIENT_BASE_URL unset) — there's nothing to copy,
                        // and saying so beats rendering an empty code block.
                        <p className="mt-2 text-xs">
                            The invite link couldn't be built on the server. Ask an administrator to check the
                            deployment's client URL setting, then invite them again.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
