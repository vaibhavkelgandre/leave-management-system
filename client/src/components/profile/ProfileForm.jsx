// Self-service profile edit (Module 5 v2) — always the caller's own
// record, so nothing here is masked (see userService.maskSensitiveProfileFields
// server-side, which only ever hides these fields from someone other than
// the owner or HR). Designation/department/joining date/last working day
// are shown here as editable, even though in practice HR usually sets them
// at onboarding — this app doesn't distinguish "HR-only" fields beyond
// role/manager/status/email, which stay on the existing HR-only flows.
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { updateMyProfile } from "../../services/userService.js";
import { toErrorMessage } from "../../services/httpError.js";
import { Button } from "../ui/Button.jsx";
import { ProfileDocumentUpload } from "./ProfileDocumentUpload.jsx";

const inputClasses =
    "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
const labelClasses = "mb-1 block text-sm font-medium text-slate-700";

function toFormState(user) {
    return {
        designation: user.designation || "",
        department: user.department || "",
        phone: user.phone || "",
        dateOfBirth: user.date_of_birth || "",
        highestEducation: user.highest_education || "",
        passportNumber: user.passport_number || "",
        passportExpiryDate: user.passport_expiry_date || "",
        bloodGroup: user.blood_group || "",
        maritalStatus: user.marital_status || "",
        currentAddress: user.current_address || "",
        permanentAddress: user.permanent_address || "",
        nearestAirport: user.nearest_airport || "",
        healthProblem: user.health_problem || "",
        healthInsuranceStatus: user.health_insurance_status || "",
        emergencyContact1Phone: user.emergency_contact_1_phone || "",
        emergencyContact1Relationship: user.emergency_contact_1_relationship || "",
        emergencyContact2Phone: user.emergency_contact_2_phone || "",
        emergencyContact2Relationship: user.emergency_contact_2_relationship || "",
        panNumber: user.pan_number || "",
        aadharNumber: user.aadhar_number || "",
        bankAccountNumber: user.bank_account_number || "",
        bankIfscCode: user.bank_ifsc_code || "",
        bankName: user.bank_name || "",
    };
}

// For facts the employee may see but not change. Rendered as text rather than
// a disabled input: a greyed-out box invites clicking and then reads as broken,
// while a plain value reads as information — which is what it is.
function ReadOnlyField({ label, value }) {
    return (
        <div>
            <p className={labelClasses}>{label}</p>
            <p className="px-3 py-2 text-sm text-slate-700">{value || "Not set by HR yet"}</p>
        </div>
    );
}

function Field({ id, label, ...inputProps }) {
    return (
        <div>
            <label htmlFor={id} className={labelClasses}>
                {label}
            </label>
            <input id={id} name={id} className={inputClasses} {...inputProps} />
        </div>
    );
}

// Collapsed by default except "Work details" — filling in every category
// at once is a wall of fields; opening one at a time keeps the form
// scannable. Collapsing never clears anything already typed in a hidden
// section — it's purely a display toggle over the same `form` state.
//
// The `<fieldset>` wraps only the field content, not the toggle button
// above it — a `<button>` inside a disabled `<fieldset>` is itself disabled
// (fieldset's disabled state cascades to every nested form control), so if
// the toggle were inside it, a read-only profile could never be expanded to
// look at. `className="contents"` keeps the fieldset itself out of the grid
// layout below it — only its children participate in the grid, exactly as
// if the fieldset weren't there.
function Section({ title, defaultOpen = false, editing, children }) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div className="border-b border-slate-100 pb-6 last:border-b-0 last:pb-0">
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                aria-expanded={open}
                className="flex w-full items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-left hover:bg-slate-100"
            >
                <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</h3>
                <ChevronDown
                    className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
                    aria-hidden="true"
                />
            </button>
            {open && (
                <fieldset disabled={!editing} className="contents">
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">{children}</div>
                </fieldset>
            )}
        </div>
    );
}

export function ProfileForm({ user, onSaved }) {
    const [form, setForm] = useState(() => toFormState(user));
    const [formError, setFormError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    // Opens as a read-only view of whatever's already saved — the employee
    // has to deliberately opt into changing anything rather than landing on
    // an already-editable form, so a stray keystroke can't alter saved data.
    const [editing, setEditing] = useState(false);
    // "I don't have one" toggles — these fields are optional anyway, but a
    // blank input reads as "haven't gotten to it yet" rather than "not
    // applicable"; checking either clears (and hides) the field so nothing
    // stale from before checking it gets submitted.
    const [noPassport, setNoPassport] = useState(false);
    const [noHealthInsurance, setNoHealthInsurance] = useState(false);

    function handleChange(event) {
        const { name, value } = event.target;
        setForm((prev) => ({ ...prev, [name]: value }));
    }

    function handleNoPassportChange(event) {
        const checked = event.target.checked;
        setNoPassport(checked);
        if (checked) {
            setForm((prev) => ({ ...prev, passportNumber: "", passportExpiryDate: "" }));
        }
    }

    function handleNoHealthInsuranceChange(event) {
        const checked = event.target.checked;
        setNoHealthInsurance(checked);
        if (checked) {
            setForm((prev) => ({ ...prev, healthInsuranceStatus: "" }));
        }
    }

    async function handleSubmit(event) {
        event.preventDefault();
        setSubmitting(true);
        setFormError(null);
        try {
            // A blank field is omitted rather than sent as "" — every field
            // is an optional partial-update on the server, and an empty
            // string would fail format validation (e.g. panNumber) instead
            // of just leaving the existing value untouched.
            const payload = Object.fromEntries(Object.entries(form).filter(([, value]) => value.trim() !== ""));
            const updated = await updateMyProfile(payload);
            onSaved?.(updated);
            setEditing(false);
        } catch (err) {
            setFormError(toErrorMessage(err, "Unable to update profile"));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            {formError && (
                <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                    {formError}
                </p>
            )}

            <label className="flex items-center gap-2 text-sm font-semibold text-indigo-700">
                <input
                    type="checkbox"
                    checked={editing}
                    onChange={(event) => setEditing(event.target.checked)}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                Edit details
            </label>

            <div className="space-y-6">
                <Section title="Work details" defaultOpen editing={editing}>
                    <Field id="designation" label="Designation" value={form.designation} onChange={handleChange} />
                    <Field id="department" label="Department" value={form.department} onChange={handleChange} />
                    {/* Joining date and last working day are HR-set, not
                        self-service: both determine pay (computeSlip's
                        payable-day count), so an editable field here would let
                        an employee change their own salary. Shown read-only so
                        they can still see what HR recorded. */}
                    <ReadOnlyField label="Joining date" value={user.joining_date} />
                    <ReadOnlyField label="Last working day" value={user.last_working_day} />
                </Section>

                <Section title="Personal details" editing={editing}>
                    <Field id="phone" label="Phone" value={form.phone} onChange={handleChange} placeholder="9876543210" />
                    <Field id="dateOfBirth" label="Date of birth" type="date" value={form.dateOfBirth} onChange={handleChange} />
                    <Field id="highestEducation" label="Highest education" value={form.highestEducation} onChange={handleChange} />
                    <Field id="bloodGroup" label="Blood group" value={form.bloodGroup} onChange={handleChange} placeholder="O+" />
                    <div>
                        <label htmlFor="maritalStatus" className={labelClasses}>
                            Marital status
                        </label>
                        <select
                            id="maritalStatus"
                            name="maritalStatus"
                            value={form.maritalStatus}
                            onChange={handleChange}
                            className={inputClasses}
                        >
                            <option value="">Select…</option>
                            <option value="SINGLE">Single</option>
                            <option value="MARRIED">Married</option>
                            <option value="OTHER">Other</option>
                        </select>
                    </div>
                    <Field id="nearestAirport" label="Nearest airport" value={form.nearestAirport} onChange={handleChange} />

                    <div className="sm:col-span-2">
                        <label className="flex items-center gap-2 text-sm text-slate-700">
                            <input
                                type="checkbox"
                                checked={noPassport}
                                onChange={handleNoPassportChange}
                                className="rounded border-slate-300"
                            />
                            I don't have a passport
                        </label>
                    </div>
                    {!noPassport && (
                        <>
                            <Field id="passportNumber" label="Passport number" value={form.passportNumber} onChange={handleChange} />
                            <Field id="passportExpiryDate" label="Passport expiry date" type="date" value={form.passportExpiryDate} onChange={handleChange} />
                        </>
                    )}

                    <div className="sm:col-span-2">
                        <Field id="healthProblem" label="Any health problem" value={form.healthProblem} onChange={handleChange} placeholder="Leave blank if none" />
                    </div>

                    <div className="sm:col-span-2">
                        <label className="flex items-center gap-2 text-sm text-slate-700">
                            <input
                                type="checkbox"
                                checked={noHealthInsurance}
                                onChange={handleNoHealthInsuranceChange}
                                className="rounded border-slate-300"
                            />
                            I don't have health insurance
                        </label>
                    </div>
                    {!noHealthInsurance && (
                        <Field id="healthInsuranceStatus" label="Health insurance status" value={form.healthInsuranceStatus} onChange={handleChange} />
                    )}
                </Section>

                <Section title="Address" editing={editing}>
                    <Field id="currentAddress" label="Current address" value={form.currentAddress} onChange={handleChange} />
                    <Field id="permanentAddress" label="Permanent address" value={form.permanentAddress} onChange={handleChange} />
                </Section>

                <Section title="Emergency contacts" editing={editing}>
                    <Field id="emergencyContact1Phone" label="Emergency contact 1 — phone" value={form.emergencyContact1Phone} onChange={handleChange} />
                    <Field id="emergencyContact1Relationship" label="Emergency contact 1 — relationship" value={form.emergencyContact1Relationship} onChange={handleChange} placeholder="e.g. Father" />
                    <Field id="emergencyContact2Phone" label="Emergency contact 2 — phone" value={form.emergencyContact2Phone} onChange={handleChange} />
                    <Field id="emergencyContact2Relationship" label="Emergency contact 2 — relationship" value={form.emergencyContact2Relationship} onChange={handleChange} placeholder="e.g. Spouse" />
                </Section>

                <Section title="Government ID & bank details" editing={editing}>
                    <Field id="panNumber" label="PAN number" value={form.panNumber} onChange={handleChange} placeholder="ABCDE1234F" />
                    <Field id="aadharNumber" label="Aadhar number" value={form.aadharNumber} onChange={handleChange} placeholder="123456789012" />
                    <Field id="bankAccountNumber" label="Bank account number" value={form.bankAccountNumber} onChange={handleChange} />
                    <Field id="bankIfscCode" label="Bank IFSC code" value={form.bankIfscCode} onChange={handleChange} placeholder="HDFC0001234" />
                    <div className="sm:col-span-2">
                        <Field id="bankName" label="Bank name" value={form.bankName} onChange={handleChange} />
                    </div>
                    <div className="sm:col-span-2">
                        <p className="mb-2 text-xs text-slate-500">
                            Upload these for HR to verify — the first three against the numbers above, the offer
                            letter against your joining date and salary.
                        </p>
                        <ProfileDocumentUpload />
                    </div>
                </Section>
            </div>

            {editing && (
                <Button type="submit" loading={submitting} className="w-full">
                    Save changes
                </Button>
            )}
        </form>
    );
}
