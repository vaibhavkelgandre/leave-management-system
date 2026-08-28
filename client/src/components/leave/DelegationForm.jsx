// Nominate-a-delegate form (FR-020), meant to sit inside a Modal opened from
// DelegationsPage. The delegate list comes from the existing role-scoped
// getUserOptions() call — no separate "eligible delegates" endpoint exists, so a
// manager currently picks from whichever users they can already see.
//
// Add **and** edit, the same shape as HolidayForm/LeaveTypeForm: pass
// `delegation` to edit (prefills, calls PATCH) or omit it to create (calls
// POST). Give it a `key` of the delegation's id so switching rows remounts it
// with fresh state.
import { useEffect, useState } from "react";
import { getUserOptions } from "../../services/userService.js";
import { createDelegation, updateDelegation } from "../../services/delegationService.js";
import { toErrorMessage } from "../../services/httpError.js";
import { useAuth } from "../../hooks/useAuth.js";
import { todayDateKey } from "../../utils/dates.js";
import { Button } from "../ui/Button.jsx";

function toFormState(delegation) {
    if (!delegation) {
        return { delegateId: "", startDate: "", endDate: "" };
    }

    // Dates arrive as "YYYY-MM-DD" strings (the server's DATE type parser keeps
    // them that way), which is exactly what <input type="date"> wants — no
    // formatting step, and nothing that could shift the day across a timezone.
    return {
        delegateId: delegation.delegate_id,
        startDate: delegation.start_date,
        endDate: delegation.end_date,
    };
}

const inputClasses =
    "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
const labelClasses = "mb-1 block text-sm font-medium text-slate-700";

// Input: `delegation` (omit to create), and `onSaved(delegation)`, called once
// the delegation is created or updated so the parent can close the modal and
// refresh its list.
export function DelegationForm({ delegation, onSaved }) {
    const { user } = useAuth();
    const isEditing = Boolean(delegation);
    const [users, setUsers] = useState(null);
    const [form, setForm] = useState(() => toFormState(delegation));
    const [formError, setFormError] = useState(null);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let cancelled = false;

        getUserOptions()
            .then((data) => {
                if (!cancelled) setUsers(data.filter((candidate) => candidate.id !== user.id));
            })
            .catch(() => {
                if (!cancelled) setUsers([]);
            });

        return () => {
            cancelled = true;
        };
    }, [user.id]);

    function handleChange(event) {
        const { name, value } = event.target;
        setForm((prev) => ({ ...prev, [name]: value }));
    }

    async function handleSubmit(event) {
        event.preventDefault();

        if (form.endDate < form.startDate) {
            setFormError("End date can't be before the start date.");
            return;
        }

        // Mirrors the server's rule, which refuses a window that has already
        // ended: a delegate's authority is resolved live against today's date,
        // so such a window could never make anyone a delegate. Only the end
        // date is checked — a window already in progress is ordinary cover.
        if (form.endDate < todayDateKey()) {
            setFormError("That date range has already ended, so nobody could cover it.");
            return;
        }

        setSubmitting(true);
        setFormError(null);

        try {
            const saved = isEditing ? await updateDelegation(delegation.id, form) : await createDelegation(form);
            onSaved(saved);
        } catch (err) {
            setFormError(toErrorMessage(err, isEditing ? "Unable to update delegation" : "Unable to create delegation"));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            {formError && (
                <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                    {formError}
                </p>
            )}

            <div>
                <label htmlFor="delegateId" className={labelClasses}>
                    Delegate
                </label>
                <select
                    id="delegateId"
                    name="delegateId"
                    value={form.delegateId}
                    onChange={handleChange}
                    required
                    className={inputClasses}
                >
                    <option value="" disabled>
                        Select who will approve on your behalf
                    </option>
                    {(users ?? []).map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                            {candidate.first_name} {candidate.last_name}
                        </option>
                    ))}
                </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label htmlFor="startDate" className={labelClasses}>
                        Start date
                    </label>
                    <input
                        id="startDate"
                        name="startDate"
                        type="date"
                        value={form.startDate}
                        onChange={handleChange}
                        required
                        className={inputClasses}
                    />
                </div>

                <div>
                    <label htmlFor="endDate" className={labelClasses}>
                        End date
                    </label>
                    <input
                        id="endDate"
                        name="endDate"
                        type="date"
                        // The later of the two bounds: the range can't invert,
                        // and it can't have already ended.
                        min={form.startDate > todayDateKey() ? form.startDate : todayDateKey()}
                        value={form.endDate}
                        onChange={handleChange}
                        required
                        className={inputClasses}
                    />
                </div>
            </div>

            <Button type="submit" loading={submitting} className="w-full">
                {isEditing ? "Save changes" : "Nominate delegate"}
            </Button>
        </form>
    );
}
