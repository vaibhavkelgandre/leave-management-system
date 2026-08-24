import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, Download, Eye } from "lucide-react";
import { getSalarySlipPdfUrl, voidSalarySlip } from "../../services/salarySlipService.js";
import { toErrorMessage } from "../../services/httpError.js";
import { StatusBadge } from "../ui/Badge.jsx";
import { Tooltip } from "../ui/Tooltip.jsx";
import { Button } from "../ui/Button.jsx";
import { Card } from "../ui/Card.jsx";

function money(value) {
    return Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const thClasses = "px-3 py-2 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase";
const thRightClasses = "px-3 py-2 text-right text-xs font-semibold tracking-wide text-slate-500 uppercase";
const tdClasses = "px-3 py-2 align-top text-sm text-slate-700";

// The full figure breakdown, shown as its own compact key-value table when a
// row is expanded — replaces the old cramped `<dl>` grid, which is exactly
// the "messed and not readable" layout this was asked to fix.
function SlipBreakdown({ slip }) {
    const isVoided = slip.status === "VOIDED";
    return (
        <table className="w-full max-w-md text-sm">
            <tbody className="divide-y divide-slate-200">
                <tr>
                    <td className="py-1.5 text-slate-500">Basic pay</td>
                    <td className="py-1.5 text-right font-medium text-slate-800">{money(slip.basic_pay)}</td>
                </tr>
                <tr>
                    <td className="py-1.5 text-slate-500">HRA</td>
                    <td className="py-1.5 text-right font-medium text-slate-800">{money(slip.hra)}</td>
                </tr>
                <tr>
                    <td className="py-1.5 text-slate-500">Special allowance</td>
                    <td className="py-1.5 text-right font-medium text-slate-800">{money(slip.special_allowance)}</td>
                </tr>
                <tr>
                    <td className="py-1.5 text-slate-500">PF (your contribution)</td>
                    <td className="py-1.5 text-right font-medium text-slate-800">
                        {money(slip.pf_employee_contribution)}
                    </td>
                </tr>
                <tr>
                    <td className="py-1.5 text-slate-500">ESIC</td>
                    <td className="py-1.5 text-right font-medium text-slate-800">{money(slip.esic)}</td>
                </tr>
                <tr>
                    <td className="py-1.5 text-slate-500">Income tax</td>
                    <td className="py-1.5 text-right font-medium text-slate-800">{money(slip.income_tax)}</td>
                </tr>
                <tr>
                    <td className="py-1.5 text-slate-500">Loss of pay</td>
                    <td className="py-1.5 text-right font-medium text-slate-800">
                        {slip.lop_days} day{Number(slip.lop_days) === 1 ? "" : "s"} ({money(slip.lop_deduction)})
                    </td>
                </tr>
                <tr>
                    <td className="py-1.5 text-slate-500">Total leave taken</td>
                    <td className="py-1.5 text-right font-medium text-slate-800">
                        {slip.total_leave_days} day{Number(slip.total_leave_days) === 1 ? "" : "s"}
                    </td>
                </tr>
                <tr>
                    <td className="py-1.5 text-slate-500">Payable days</td>
                    <td className="py-1.5 text-right font-medium text-slate-800">{slip.payable_days}</td>
                </tr>
                {isVoided && slip.void_reason && (
                    <tr>
                        <td className="py-1.5 text-slate-500">Void reason</td>
                        <td className="py-1.5 text-right font-medium text-slate-800">{slip.void_reason}</td>
                    </tr>
                )}
            </tbody>
        </table>
    );
}

// `canVoid`: only HR's team view offers this — an employee viewing their
// own slip history has no reason to void a slip themselves, and the server
// wouldn't allow it anyway (voidSalarySlip is HR-only). Voiding is a soft
// delete (a status flag, not a DELETE) so a slip generated for the wrong
// pay period leaves a record that it was corrected, not just disappears.
function SalarySlipRow({ slip, showEmployee, canVoid, onVoided, columnCount, expanded, onToggle }) {
    const [showVoidPrompt, setShowVoidPrompt] = useState(false);
    const [reason, setReason] = useState("");
    const [voiding, setVoiding] = useState(false);
    const [error, setError] = useState(null);
    const isVoided = slip.status === "VOIDED";
    // View links to DocumentViewerPage.jsx (a full page, not a modal — see
    // rules.md) rather than fetching a URL up front; that page builds the
    // `?disposition=inline` variant itself (the default `attachment` would
    // trigger a download the instant the page opened, same bug this exact
    // distinction already fixed for the modal version). Download still uses
    // the default `attachment` URL directly, unchanged.
    const downloadUrl = getSalarySlipPdfUrl(slip.id);

    async function handleVoid() {
        setVoiding(true);
        setError(null);
        try {
            await voidSalarySlip(slip.id, reason || undefined);
            setShowVoidPrompt(false);
            onVoided?.();
        } catch (err) {
            setError(toErrorMessage(err, "Unable to void this slip"));
        } finally {
            setVoiding(false);
        }
    }

    return (
        <>
            <tr className="hover:bg-slate-50">
                <td className={tdClasses}>
                    <button
                        type="button"
                        onClick={onToggle}
                        aria-expanded={expanded}
                        className="flex items-center gap-1.5 font-medium text-slate-900"
                    >
                        {expanded ? (
                            <ChevronUp className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                        ) : (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                        )}
                        {slip.pay_period}
                    </button>
                </td>
                {showEmployee && (
                    <td className={tdClasses}>
                        {slip.employee_first_name} {slip.employee_last_name}
                    </td>
                )}
                <td className={`${tdClasses} text-right font-semibold text-slate-900`}>{money(slip.net_pay)}</td>
                <td className={tdClasses}>
                    {/* The reason on hover, so "why is this voided?" is
                        answerable from the row rather than only by expanding
                        it. `portal` is required for any tooltip inside a table:
                        the wrapper is `overflow-x-auto`, which both clips the
                        floating label at the card's edge and counts its width
                        toward scrollWidth, producing a phantom scrollbar. */}
                    <Tooltip label={isVoided ? slip.void_reason : null} portal>
                        <StatusBadge status={slip.status} />
                    </Tooltip>
                </td>
                <td className={`${tdClasses} text-right`}>
                    <div className="flex items-center justify-end gap-1">
                        {canVoid && !isVoided && !showVoidPrompt && (
                            <Button size="sm" variant="danger" onClick={() => setShowVoidPrompt(true)}>
                                Void
                            </Button>
                        )}
                        <Link
                            to={`/dashboard/documents/preview?salarySlipId=${slip.id}&payPeriod=${slip.pay_period}`}
                            aria-label={`View payslip for ${slip.pay_period}`}
                            className="shrink-0 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                        >
                            <Eye className="h-4 w-4" aria-hidden="true" />
                        </Link>
                        <a
                            href={downloadUrl}
                            download
                            aria-label={`Download payslip for ${slip.pay_period}`}
                            className="shrink-0 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                        >
                            <Download className="h-4 w-4" aria-hidden="true" />
                        </a>
                    </div>
                </td>
            </tr>

            {showVoidPrompt && (
                <tr>
                    <td colSpan={columnCount} className="border-t border-slate-100 bg-red-50/40 px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <input
                                value={reason}
                                onChange={(event) => setReason(event.target.value)}
                                placeholder="Reason for voiding (optional)"
                                className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                            />
                            <Button size="sm" variant="danger" loading={voiding} onClick={handleVoid}>
                                Confirm void
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setShowVoidPrompt(false)}>
                                Cancel
                            </Button>
                        </div>
                    </td>
                </tr>
            )}
            {error && (
                <tr>
                    <td colSpan={columnCount} className="border-t border-slate-100 px-3 py-2">
                        <p role="alert" className="text-xs text-red-600">
                            {error}
                        </p>
                    </td>
                </tr>
            )}

            {expanded && (
                <tr>
                    <td colSpan={columnCount} className="border-t border-slate-100 bg-slate-50/60 px-3 py-3">
                        <SlipBreakdown slip={slip} />
                    </td>
                </tr>
            )}
        </>
    );
}

// `showEmployee`: HR's subtree view lists slips across many employees, so
// each row needs to say whose it is — the employee's own history (one
// person, many periods) doesn't need that repeated on every row.
export function SalarySlipList({ slips, showEmployee = false, canVoid = false, onVoided }) {
    const [expandedId, setExpandedId] = useState(null);

    if (slips.length === 0) {
        return <p className="text-sm text-slate-500">No salary slips yet.</p>;
    }

    const columnCount = showEmployee ? 5 : 4;

    return (
        <Card className="overflow-hidden">
            <div className="scrollbar-thin overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                        <tr>
                            <th scope="col" className={thClasses}>
                                Pay Period
                            </th>
                            {showEmployee && (
                                <th scope="col" className={thClasses}>
                                    Employee
                                </th>
                            )}
                            <th scope="col" className={thRightClasses}>
                                Net Pay
                            </th>
                            <th scope="col" className={thClasses}>
                                Status
                            </th>
                            <th scope="col" className={thRightClasses}>
                                Actions
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {slips.map((slip) => (
                            <SalarySlipRow
                                key={slip.id}
                                slip={slip}
                                showEmployee={showEmployee}
                                canVoid={canVoid}
                                onVoided={onVoided}
                                columnCount={columnCount}
                                expanded={expandedId === slip.id}
                                onToggle={() => setExpandedId((prev) => (prev === slip.id ? null : slip.id))}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
        </Card>
    );
}
