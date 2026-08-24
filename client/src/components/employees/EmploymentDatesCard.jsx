// HR's control over the two dates payroll computes from: the joining date, and
// the last working day.
//
// Neither is editable by the employee — both set the payable-day count on every
// payslip, so while they sat in the self-editable profile fields an employee
// could change their own pay. They live here instead, on an HR-only surface,
// and the joining date is meant to be entered from the signed offer letter at
// verification time rather than taken from whatever the employee typed.
//
// Two separate actions on purpose, because they aren't the same intent:
//   - "Save" edits a date. It is refused (409) when a payslip already covers an
//     affected period, because a bare edit would leave the slip and the record
//     disagreeing.
//   - "Record exit" is the operation that *resolves* that: it sets the leaving
//     date and corrects the payslips it invalidates in one go, reporting which
//     periods were voided and which were reissued.
import { useState } from "react";
import { Card } from "../ui/Card.jsx";
import { Button } from "../ui/Button.jsx";
import { updateEmploymentDates, recordEmployeeExit } from "../../services/userService.js";
import { toErrorMessage } from "../../services/httpError.js";

const labelClasses = "mb-1 block text-sm font-medium text-slate-700";
const inputClasses =
    "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";

export function EmploymentDatesCard({ employee, onChanged }) {
    const [joiningDate, setJoiningDate] = useState(employee.joining_date || "");
    const [exitOpen, setExitOpen] = useState(false);
    const [lastWorkingDay, setLastWorkingDay] = useState("");
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState("");

    async function handleSaveJoiningDate(event) {
        event.preventDefault();
        setError("");
        setResult("");
        setBusy(true);
        try {
            await updateEmploymentDates(employee.id, { joiningDate: joiningDate || null });
            setResult("Joining date saved.");
            onChanged?.();
        } catch (err) {
            setError(toErrorMessage(err, "Unable to save the joining date"));
        } finally {
            // Always, not only in catch: onChanged() re-fetches and re-renders
            // this component with new props rather than remounting it, so a
            // busy flag set only in the failure path stays stuck on success.
            setBusy(false);
        }
    }

    async function handleRecordExit(event) {
        event.preventDefault();
        setError("");
        setResult("");
        setBusy(true);
        try {
            const outcome = await recordEmployeeExit(employee.id, { lastWorkingDay, reason });
            // Say what actually happened to the payslips. HR has no other way
            // to find out, and "exit recorded" alone would hide the fact that a
            // payslip was just reissued with different figures.
            const parts = [`Exit recorded for ${lastWorkingDay}.`];
            if (outcome.regenerated?.length) {
                parts.push(`Payslip reissued, pro-rated: ${outcome.regenerated.join(", ")}.`);
            }
            if (outcome.voided?.length) {
                parts.push(`Payslip voided (period entirely after the exit): ${outcome.voided.join(", ")}.`);
            }
            setResult(parts.join(" "));
            setExitOpen(false);
            setReason("");
            onChanged?.();
        } catch (err) {
            setError(toErrorMessage(err, "Unable to record the exit"));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card className="p-6">
            <h2 className="text-base font-semibold text-slate-900">Employment dates</h2>
            <p className="mt-1 text-sm text-slate-600">
                Payroll computes payable days from these. The employee cannot edit them — set the joining date from the
                signed offer letter.
            </p>

            <form onSubmit={handleSaveJoiningDate} className="mt-4 flex flex-wrap items-end gap-3">
                <div className="min-w-48">
                    <label htmlFor="joiningDate" className={labelClasses}>
                        Joining date
                    </label>
                    <input
                        id="joiningDate"
                        name="joiningDate"
                        type="date"
                        className={inputClasses}
                        value={joiningDate}
                        onChange={(event) => setJoiningDate(event.target.value)}
                    />
                </div>
                <Button type="submit" variant="secondary" loading={busy}>
                    Save
                </Button>
            </form>

            <div className="mt-5 border-t border-slate-200 pt-4">
                <p className={labelClasses}>Last working day</p>
                <p className="text-sm text-slate-700">
                    {employee.last_working_day || "Still employed — no leaving date recorded."}
                </p>

                {!exitOpen && (
                    <Button type="button" variant="danger" size="sm" className="mt-3" onClick={() => setExitOpen(true)}>
                        Record exit
                    </Button>
                )}

                {exitOpen && (
                    <form onSubmit={handleRecordExit} className="mt-3 space-y-3">
                        <div className="min-w-48">
                            <label htmlFor="lastWorkingDay" className={labelClasses}>
                                Last working day
                            </label>
                            <input
                                id="lastWorkingDay"
                                name="lastWorkingDay"
                                type="date"
                                required
                                className={inputClasses}
                                value={lastWorkingDay}
                                onChange={(event) => setLastWorkingDay(event.target.value)}
                            />
                        </div>
                        <div>
                            <label htmlFor="exitReason" className={labelClasses}>
                                Reason
                            </label>
                            <input
                                id="exitReason"
                                name="exitReason"
                                required
                                className={inputClasses}
                                placeholder="e.g. Resigned, notice served"
                                value={reason}
                                onChange={(event) => setReason(event.target.value)}
                            />
                            {/* Not decoration: this text is recorded on the void
                                of any payslip the exit corrects, and it is the
                                only answer to "why was this voided". */}
                            <p className="mt-1 text-xs text-slate-500">
                                Recorded against any payslip this correction voids.
                            </p>
                        </div>
                        <div className="flex gap-2">
                            <Button type="submit" variant="danger" size="sm" loading={busy}>
                                Confirm exit
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => setExitOpen(false)}>
                                Cancel
                            </Button>
                        </div>
                    </form>
                )}
            </div>

            {result && <p className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">{result}</p>}
            {error && (
                <p role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                </p>
            )}
        </Card>
    );
}
