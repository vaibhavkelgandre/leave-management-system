import { useState } from "react";
import { createHoliday, updateHoliday } from "../../services/holidayService.js";
import { toErrorMessage } from "../../services/httpError.js";
import { Button } from "../ui/Button.jsx";
import { eachDateKeyInRange } from "../../utils/dates.js";

const inputClasses =
    "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
const labelClasses = "mb-1 block text-sm font-medium text-slate-700";

// An existing single-day holiday stores end_date === start_date; surfacing that
// as a blank End date keeps the "leave it empty for one day" affordance intact
// when editing.
function toFormState(holiday) {
    if (!holiday) return { name: "", startDate: "", endDate: "" };

    return {
        name: holiday.name,
        startDate: holiday.start_date,
        endDate: holiday.end_date === holiday.start_date ? "" : holiday.end_date,
    };
}

export function HolidayForm({ holiday, onSaved }) {
    const isEditing = Boolean(holiday);
    const [form, setForm] = useState(() => toFormState(holiday));
    const [formError, setFormError] = useState(null);
    const [submitting, setSubmitting] = useState(false);

    const dayCount = form.startDate ? eachDateKeyInRange(form.startDate, form.endDate).length : 0;

    function handleChange(event) {
        const { name, value } = event.target;
        setForm((prev) => ({ ...prev, [name]: value }));
    }

    async function handleSubmit(event) {
        event.preventDefault();

        if (form.endDate && form.endDate < form.startDate) {
            setFormError("End date can't be before the start date.");
            return;
        }

        setSubmitting(true);
        setFormError(null);

        let result;
        try {
            if (isEditing) {
                result = await updateHoliday(holiday.id, form);
            } else {
                result = await createHoliday(form);
            }
            // A holiday is global and feeds the working-day calculation, so
            // saving one can recount live leave requests and move balances.
            // The count is handed to the page rather than shown here, because
            // onSaved closes this form — a message inside it would vanish.
            onSaved(form.startDate, result?.adjusted ?? []);
        } catch (err) {
            setFormError(toErrorMessage(err, isEditing ? "Unable to update holiday" : "Unable to create holiday"));
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
                <label htmlFor="name" className={labelClasses}>
                    Name
                </label>
                <input
                    id="name"
                    name="name"
                    value={form.name}
                    onChange={handleChange}
                    required
                    placeholder="e.g. Diwali"
                    className={inputClasses}
                />
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
                        min={form.startDate || undefined}
                        value={form.endDate}
                        onChange={handleChange}
                        className={inputClasses}
                    />
                </div>
            </div>

            <p className="text-xs text-slate-500">
                {dayCount > 1
                    ? `This holiday will cover ${dayCount} days.`
                    : "Leave the end date blank for a single-day holiday, or set it for a multi-day one like Diwali."}
            </p>

            <Button type="submit" loading={submitting} className="w-full">
                {isEditing ? "Save changes" : "Add holiday"}
            </Button>
        </form>
    );
}
