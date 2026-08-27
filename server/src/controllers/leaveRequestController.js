// Thin HTTP glue for leave requests — every handler just pulls from `req`,
// calls one leaveRequestService function, and reports success/failure. All
// business logic (authorization, the state machine, balance/ledger math)
// lives in the service, not here.
import * as leaveRequestService from "../services/leaveRequestService.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { toCsv } from "../utils/csv.js";

// POST /api/leave-requests/preview — any authenticated role.
// Answers "how many working days would this cost?" with weekends and public
// holidays already excluded, and writes nothing. Deliberately the same code
// path the real submit uses, so the number an employee is shown before
// submitting is always exactly what gets charged (Module 3, point 3).
export async function preview(req, res, next) {
    try {
        const workingDays = await leaveRequestService.previewWorkingDays(req.body);
        sendSuccess(res, 200, "Working days calculated", { workingDays });
    } catch (error) {
        next(error);
    }
}

// POST /api/leave-requests — any authenticated role, for themselves only.
// Accepts multipart/form-data so an optional `document` field can ride along.
// Returns 201 with the created request. Refused by the service for an
// inactive leave type, a zero-working-day range, an overlap with an existing
// pending/approved request, a balance the type won't let go negative, a
// missing document where the type requires one, or leave starting after the
// employee's last working day.
export async function submit(req, res, next) {
    try {
        // employee_id always comes from the authenticated session, never the
        // request body — a client can never submit a request on someone
        // else's behalf. req.file is undefined unless a "document" field was
        // sent (uploadLeaveRequestDocument middleware, only wired for this route).
        const request = await leaveRequestService.submitLeaveRequest(req.user.id, req.body, req.file);
        sendSuccess(res, 201, "Leave request submitted", request);
    } catch (error) {
        next(error);
    }
}

// GET /api/leave-requests/mine — the caller's own requests, every status,
// newest first. Needs no scope check: the employee id comes from the session.
export async function listMine(req, res, next) {
    try {
        const requests = await leaveRequestService.listMyLeaveRequests(req.user.id);
        sendSuccess(res, 200, "Leave requests retrieved", requests);
    } catch (error) {
        next(error);
    }
}

// Paginated `{ requests, total }`, same envelope as the browse and
// notification lists. `req.query` carries either a page (limit/offset) or a
// window (startDate/endDate) — see teamLeaveRequestsQuerySchema.
export async function listTeam(req, res, next) {
    try {
        const { rows, total } = await leaveRequestService.listTeamLeaveRequests(req.user, req.query);
        sendSuccess(res, 200, "Leave requests retrieved", { requests: rows, total });
    } catch (error) {
        next(error);
    }
}

// Count-only siblings of listTeam below — see the service functions for why
// the sidebar badge and the dashboard tile don't fetch the rows and count
// them client-side any more.
export async function pendingCount(req, res, next) {
    try {
        const count = await leaveRequestService.countPendingDecisions(req.user);
        sendSuccess(res, 200, "Pending count retrieved", { count });
    } catch (error) {
        next(error);
    }
}

// GET /api/leave-requests/on-leave-today — who in the caller's team is on
// approved leave today, for the dashboard tile. Unpaginated on purpose: the
// result is bounded by team size and by a single day.
// Scoped server-side, so an employee with no team gets [] rather than a 403.
export async function onLeaveToday(req, res, next) {
    try {
        const requests = await leaveRequestService.listOnLeaveToday(req.user);
        sendSuccess(res, 200, "On leave today retrieved", requests);
    } catch (error) {
        next(error);
    }
}

// GET /api/leave-requests/all — SUPER_ADMIN only (enforced on the route).
// The company-wide list, and the one read HR_ADMIN is deliberately refused:
// an HR admin's view of leave is their own branch, via /team. Takes either a
// page or a date window, never neither — see the query schema.
export async function listAll(req, res, next) {
    try {
        const { rows, total } = await leaveRequestService.listAllLeaveRequests(req.query);
        sendSuccess(res, 200, "Leave requests retrieved", { requests: rows, total });
    } catch (error) {
        next(error);
    }
}

// FR-024: HR's filterable browse view. `req.query` is already validated and
// coerced by validateQuery(listLeaveRequestsQuerySchema) before this runs.
// Paginated: `{ requests, total }`, the same envelope the notifications list
// uses (`{ notifications, total }`) so the client has one pagination idiom.
export async function listFiltered(req, res, next) {
    try {
        const { rows, total } = await leaveRequestService.listFilteredLeaveRequests(req.user, req.query);
        sendSuccess(res, 200, "Leave requests retrieved", { requests: rows, total });
    } catch (error) {
        next(error);
    }
}

// FR-024's leave-taken-per-employee report, as JSON for an on-screen table.
export async function getReport(req, res, next) {
    try {
        const rows = await leaveRequestService.generateLeaveTakenReport(req.user, req.query);
        sendSuccess(res, 200, "Report generated", rows);
    } catch (error) {
        next(error);
    }
}

// Same report as getReport above, formatted as a CSV file download instead
// of the JSON envelope. Column headers are spelled out for a human opening
// the file in a spreadsheet, not the raw snake_case row keys.
const REPORT_CSV_COLUMNS = [
    { key: "employee_first_name", header: "First Name" },
    { key: "employee_last_name", header: "Last Name" },
    { key: "employee_role", header: "Role" },
    { key: "request_count", header: "Requests" },
    { key: "total_days_taken", header: "Total Days Taken" },
];

// GET /api/leave-requests/report/csv — HR-tier. The same aggregation as
// /report, delivered as a file.
//
// CSV formatting lives here rather than in the service, which only ever
// returns structured rows — the same layering the document-download endpoint
// uses. Keeps the service reusable by a caller that wants the data, not a file.
export async function downloadReportCsv(req, res, next) {
    try {
        const rows = await leaveRequestService.generateLeaveTakenReport(req.user, req.query);
        const csv = toCsv(REPORT_CSV_COLUMNS, rows);

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="leave-report-${req.query.startDate}-to-${req.query.endDate}.csv"`
        );
        res.send(csv);
    } catch (error) {
        next(error);
    }
}

// GET /api/leave-requests/:id — the requester, their approver (or an active
// delegate), an in-branch HR admin, or SUPER_ADMIN.
// 404 for anyone else, deliberately not 403: someone with no legitimate
// reason to know the record exists learns nothing from the answer (NFR-5).
// This one rule backs the audit-trail and document endpoints below too.
export async function getOne(req, res, next) {
    try {
        const request = await leaveRequestService.getLeaveRequestById(req.user, req.params.id);
        sendSuccess(res, 200, "Leave request retrieved", request);
    } catch (error) {
        next(error);
    }
}

// GET /api/leave-requests/:id/audit — every state change with its actor,
// timestamp and comment, append-only and never edited (Module 3, point 10).
// Reuses getOne's viewing rule, so visibility can't drift between the two.
export async function getAuditTrail(req, res, next) {
    try {
        const trail = await leaveRequestService.getAuditTrail(req.user, req.params.id);
        sendSuccess(res, 200, "Audit trail retrieved", trail);
    } catch (error) {
        next(error);
    }
}

// GET /api/leave-requests/:id/document — metadata plus a freshly minted
// signed URL, good for five minutes. Same viewing rule as getOne.
//
// Generated per call and never cached, so there is no long-lived link to
// leak: Postgres stores only the Cloudinary public id, never a URL.
export async function getDocument(req, res, next) {
    try {
        const document = await leaveRequestService.getLeaveRequestDocument(req.user, req.params.id);
        sendSuccess(res, 200, "Document retrieved", document);
    } catch (error) {
        next(error);
    }
}

// Streams the document back with Content-Disposition: attachment so the
// browser saves it to disk instead of navigating to it — see
// cloudinaryService.fetchDocumentStream for why a plain signed-URL link
// can't do this on its own. `filename` is stripped of quotes/CRLF before
// going into the header since it's a user-supplied original filename, not a
// value this app generated.
export async function downloadDocument(req, res, next) {
    try {
        const { stream, filename, mimeType } = await leaveRequestService.downloadLeaveRequestDocument(
            req.user,
            req.params.id
        );
        const safeFilename = filename.replace(/["\r\n]/g, "");
        res.setHeader("Content-Type", mimeType);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
        );
        stream.on("error", next);
        stream.pipe(res);
    } catch (error) {
        next(error);
    }
}

// approve/reject/withdraw/cancel are identical glue apart from which action
// string they pass through to decideLeaveRequest — one factory instead of
// four near-duplicate functions.
function makeDecisionHandler(action) {
    return async function handleDecision(req, res, next) {
        try {
            const request = await leaveRequestService.decideLeaveRequest(req.user, req.params.id, action, req.body.comment);
            sendSuccess(res, 200, "Leave request updated", request);
        } catch (error) {
            next(error);
        }
    };
}

// POST /api/leave-requests/:id/{approve,reject,withdraw,cancel}. Which roles
// may call which is a row-level question, so it is answered in the service
// (resolveActingCapacity), not by a route gate: approve/reject need the
// employee's own manager or an active delegate; withdraw and cancel are the
// employee's alone. An illegal transition is 409, an unauthorized caller 404,
// and a decision against a period that already has a payslip is 409 too.
export const approve = makeDecisionHandler("APPROVE");
export const reject = makeDecisionHandler("REJECT");
export const withdraw = makeDecisionHandler("WITHDRAW");
export const cancel = makeDecisionHandler("CANCEL");

// POST /api/leave-requests/:id/override — HR_ADMIN only, and only within
// their own branch. SUPER_ADMIN can never override; that asymmetry is
// deliberate (see docs/7.role_permissions_matrix.md).
//
// Maps the requested target status onto one of the two HR_OVERRIDE_* actions,
// which the state machine only permits from an already-decided request — so
// "the manager decides first, HR revisits after" is enforced by the
// transition map rather than by a check here. The comment is required.
export async function override(req, res, next) {
    try {
        const action = req.body.toStatus === "APPROVED" ? "HR_OVERRIDE_TO_APPROVED" : "HR_OVERRIDE_TO_REJECTED";
        const request = await leaveRequestService.decideLeaveRequest(req.user, req.params.id, action, req.body.comment);
        sendSuccess(res, 200, "Leave request overridden", request);
    } catch (error) {
        next(error);
    }
}
