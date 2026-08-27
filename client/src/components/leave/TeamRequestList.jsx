// The manager/HR approvals list — same card-list pattern as every other
// list in the app, with approve/reject on pending requests and an
// HR-only override on already-decided ones. The actions themselves (and
// their busy/error/reject-comment state) live in RequestActions, shared with
// RequestDetailModal so a decision can be made from either place.
// Actions render icon-only here (RequestActions' `iconOnly` prop, plus
// Details below) to keep a row compact — re-requested directly after an
// earlier version of this exact row was switched *to* labeled buttons for
// being "unreadable/cramped" with up to four actions plus a role badge; see
// the note in rules.md rather than assuming this is an oversight if it ever
// looks like a step backward. RequestDetailModal keeps its own labeled
// RequestActions instance untouched — it has the room icon-only doesn't need.
import { useEffect, useRef, useState } from "react";
import { Info, Repeat, ArrowUpRight } from "lucide-react";
import { useAuth } from "../../hooks/useAuth.js";
import { Card } from "../ui/Card.jsx";
import { IconButton } from "../ui/IconButton.jsx";
import { Badge, RoleBadge, StatusBadge } from "../ui/Badge.jsx";
import { RequestDetailModal } from "./RequestDetailModal.jsx";
import { RequestActions } from "./RequestActions.jsx";
import { formatDateRange } from "../../utils/dates.js";

function RequestRow({ request, canOverride, onChanged, onViewDetails, viewerId, readOnly = false, isSelected, registerRef }) {
    const workingDays = Number(request.working_days);
    // This list can now include a manager's team the viewer is only
    // standing in for as an active delegate (listTeamLeaveRequests merges
    // it in) alongside the viewer's own reports — flag those rows so it's
    // clear why an unfamiliar employee's request is showing up here.
    // Not shown in read-only mode (the HR "All Requests" tab): there, every
    // row's manager differs from the viewer as a matter of course, so the
    // badge would just be noise rather than flagging anything unusual.
    const isDelegatedRow = !readOnly && request.employee_manager_id && request.employee_manager_id !== viewerId;
    // An escalated request was submitted while the employee was covering their
    // own manager's approvals, so HR decides it instead of that manager
    // (resolveActingCapacity's hr_escalated branch). Worth saying on the row:
    // without it, an approve/reject button appearing for HR on someone else's
    // report — or a manager finding their own report's request already decided by
    // HR — reads as a permissions bug rather than as the intended routing.
    const isEscalatedRow = Boolean(request.hr_escalated);

    return (
        <li
            ref={registerRef}
            className={`px-4 py-3 transition ${
                isSelected ? "bg-indigo-50/80 ring-1 ring-inset ring-indigo-300" : "hover:bg-slate-50/80"
            }`}
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900">
                            {request.employee_first_name} {request.employee_last_name}
                        </span>
                        <RoleBadge role={request.employee_role} />
                        <StatusBadge status={request.status} />
                        {isDelegatedRow && (
                            <Badge className="flex items-center gap-1 bg-amber-100 text-amber-700">
                                <Repeat className="h-3 w-3" aria-hidden="true" />
                                Delegated for {request.manager_first_name} {request.manager_last_name}
                            </Badge>
                        )}
                        {isEscalatedRow && (
                            <Badge className="flex items-center gap-1 bg-sky-100 text-sky-700">
                                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                                Escalated to HR
                            </Badge>
                        )}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                        {request.leave_type_name} · {formatDateRange(request.start_date, request.end_date)} · {workingDays} day
                        {workingDays === 1 ? "" : "s"}
                    </p>
                    {request.reason && <p className="mt-1 text-xs text-slate-500">{request.reason}</p>}
                </div>

                <div className="flex flex-wrap items-center gap-1">
                    {!readOnly && (
                        <RequestActions request={request} canOverride={canOverride} onChanged={onChanged} iconOnly />
                    )}
                    {/* `tooltipPortal`: this list's `Card` is `overflow-hidden`,
                        and with no thead above the first row there's nothing for
                        a `top` tooltip to sit over — the first row's labels were
                        being clipped off at the card's top edge entirely. */}
                    <IconButton icon={Info} label="Details" size="sm" tooltipPortal onClick={() => onViewDetails(request)} />
                </div>
            </div>
        </li>
    );
}

// `readOnly`: the HR "All Requests" tab — every request in the company for
// browsing/context, but acting on one is scoped to the caller's own
// reporting subtree (enforced server-side regardless), so this tab shows no
// action buttons at all rather than showing buttons that would just 404 for
// most rows. Switch to "My Team" to actually act on something.
export function TeamRequestList({ requests, canOverride, onChanged, readOnly = false, selectedRequestId, autoOpenRequestId }) {
    // Optional chaining: some callers/tests render this before the auth
    // context has a user — the delegated-team badge just stays hidden then,
    // same as if every row were the viewer's own report.
    const { user } = useAuth();
    // Opens the detail modal automatically, once, for a notification-driven
    // target (NotificationBell.jsx/notificationRouting.js) — a lazy
    // initializer rather than an effect, same pattern ApplyLeavePage's
    // focusDate uses: it runs once on this list's first mount (always after
    // `requests` is already loaded, so the target is there to find) and
    // deliberately never re-fires on a later `requests` reload. `selectedRequestId`
    // (below) is the separate, reactive prop a calendar click also sets just to
    // highlight/scroll a row without popping the modal open uninvited.
    const [detailRequest, setDetailRequest] = useState(
        () => requests.find((request) => request.id === autoOpenRequestId) ?? null
    );
    const itemNodes = useRef(new Map());

    // Scrolls the row picked from TeamLeaveCalendar into view — the row
    // itself is already visible as "selected" via `isSelected` below
    // without this, but on a long list it can sit off-screen with no
    // scroll container of its own (the whole page scrolls).
    useEffect(() => {
        if (!selectedRequestId) return;
        itemNodes.current.get(selectedRequestId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, [selectedRequestId]);

    return (
        <Card className="overflow-hidden">
            <ul className="divide-y divide-slate-100">
                {requests.map((request) => (
                    <RequestRow
                        key={request.id}
                        request={request}
                        canOverride={canOverride}
                        onChanged={onChanged}
                        onViewDetails={setDetailRequest}
                        viewerId={user?.id}
                        readOnly={readOnly}
                        isSelected={request.id === selectedRequestId}
                        registerRef={(node) => {
                            if (node) itemNodes.current.set(request.id, node);
                            else itemNodes.current.delete(request.id);
                        }}
                    />
                ))}
            </ul>
            <RequestDetailModal
                request={detailRequest}
                open={detailRequest !== null}
                onClose={() => setDetailRequest(null)}
                canOverride={canOverride}
                readOnly={readOnly}
                onChanged={onChanged}
            />
        </Card>
    );
}
