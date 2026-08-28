// A manager's own nominated delegations. Each row offers Edit — there is
// still no revoke endpoint, so a nomination is corrected by reassigning it or
// by letting the window lapse.
//
// A delegation whose window has already ended shows no Edit button: the server
// refuses those (that coverage already happened, and the leave-request audit
// trail records who acted for whom during it), and offering a control that can
// only fail reads as a broken button rather than as a deliberate rule.
//
// A row also carries a warning when the nominated delegate has since booked
// leave inside the window. That can only ever be leave booked *after* the
// nomination — nominating over existing leave is refused outright — and it is
// deliberately allowed, because the delegate never agreed to cover and FR-020
// gives them no way to decline. The manager is notified at the moment it
// happens, but a notification is read once and then gone, while this page is
// what they come back to; without the warning the nomination looks fine and is
// not. The warning and the Edit button sit in the same row on purpose: the
// remedy is to reassign, so the two belong together.
import { Pencil } from "lucide-react";
import { Card } from "../ui/Card.jsx";
import { IconButton } from "../ui/IconButton.jsx";
import { formatDateRange, todayDateKey } from "../../utils/dates.js";

// Input: one delegation row from GET /delegations/mine. Output: a sentence
// naming the colliding leave, or null when there is none.
//
// Kept out of the component body so the wording lives in one place and can be
// asserted directly. Says "has approved leave" versus "has requested leave"
// because the manager's next step differs: an approved absence is settled, a
// pending one is usually this manager's own decision still to make.
function describeLeaveConflict(delegation) {
    if (!delegation.conflict_leave_start_date) {
        return null;
    }

    const name = `${delegation.delegate_first_name} ${delegation.delegate_last_name}`;
    const verb = delegation.conflict_leave_status === "APPROVED" ? "has approved leave" : "has requested leave";
    const range = formatDateRange(delegation.conflict_leave_start_date, delegation.conflict_leave_end_date);

    return `${name} ${verb} for ${range}, which overlaps this cover. Reassign the delegation if they can't approve then.`;
}

export function DelegationList({ delegations, onEdit }) {
    const today = todayDateKey();

    return (
        <Card className="overflow-hidden">
            <ul className="divide-y divide-slate-100">
                {delegations.map((delegation) => {
                    const hasEnded = delegation.end_date < today;
                    const canEdit = Boolean(onEdit) && !hasEnded;
                    // Suppressed on an ended window: the clash is history, the
                    // server refuses an edit, and a warning whose only
                    // suggested action is unavailable is the dead end this
                    // feature exists to remove.
                    const conflict = hasEnded ? null : describeLeaveConflict(delegation);

                    return (
                        <li key={delegation.id} className="px-4 py-3">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <span className="font-semibold text-slate-900">
                                        {delegation.delegate_first_name} {delegation.delegate_last_name}
                                    </span>
                                    <p className="mt-0.5 text-xs text-slate-500">
                                        {formatDateRange(delegation.start_date, delegation.end_date)}
                                    </p>
                                </div>

                                {canEdit && (
                                    <IconButton
                                        icon={Pencil}
                                        label={`Edit delegation for ${delegation.delegate_first_name} ${delegation.delegate_last_name}`}
                                        onClick={() => onEdit(delegation)}
                                        // This list sits in a Card with overflow-hidden, which
                                        // clips a CSS-positioned tooltip outright — see the
                                        // employee-table note in the project rules.
                                        tooltipPortal
                                    />
                                )}
                            </div>

                            {conflict && (
                                // Same amber notice styling as PayrollRunForm's
                                // skipped-rows list and HolidaysPage's recount
                                // notice — this app states these in text, with
                                // no icon.
                                <p
                                    role="status"
                                    className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                                >
                                    {conflict}
                                </p>
                            )}
                        </li>
                    );
                })}
            </ul>
        </Card>
    );
}
