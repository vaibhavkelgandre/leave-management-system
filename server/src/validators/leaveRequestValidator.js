// Request-shape validation for leave requests (submit/preview/decide). Every
// write endpoint validates server-side, per NFR-4 — never trust the client.
import { z } from "zod";

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be in YYYY-MM-DD format");

// Shared by every paginated list here. 62 days covers the widest month
// grid a calendar can show (42) with room to spare, while still being a
// bound rather than an invitation to request a decade.
const DEFAULT_PAGE_SIZE = 25;
const MAX_WINDOW_DAYS = 62;

// Submitting with a document attached sends multipart/form-data (so multer
// can read the file), which arrives as string fields for everything else —
// unlike a plain JSON body, "false" comes through as the string "false", not
// a boolean. z.coerce.boolean() would wrongly treat "false" as truthy, so
// this maps the two string forms explicitly and passes actual booleans (the
// JSON, no-attachment case) through unchanged.
const booleanish = z.preprocess((value) => (typeof value === "string" ? value === "true" : value), z.boolean());

// Shared by both the preview and submit schemas: the date range must not run
// backwards, and a single-day request can't set both half-day flags (that
// would zero the request out, which is never what the employee meant).
function refineDateRange(data, ctx) {
    if (data.endDate < data.startDate) {
        ctx.addIssue({ code: "custom", path: ["endDate"], message: "endDate must be on or after startDate" });
    }
    if (data.startDate === data.endDate && data.startHalfDay && data.endHalfDay) {
        ctx.addIssue({
            code: "custom",
            path: ["endHalfDay"],
            message: "A single-day request can only have one half-day flag set",
        });
    }
}

// Body for the side-effect-free working-day preview. No leaveTypeId: the count
// depends only on the dates, the half-day flags, weekends and holidays — so
// asking for a preview costs the caller nothing they haven't decided yet.
export const previewLeaveRequestSchema = z
    .object({
        startDate: dateStringSchema,
        endDate: dateStringSchema,
        startHalfDay: z.boolean().optional().default(false),
        endHalfDay: z.boolean().optional().default(false),
    })
    .superRefine(refineDateRange);

// Body for a real submission. Same date fields as the preview plus the leave
// type and reason.
//
// The half-day flags use `booleanish` rather than z.boolean() because this
// route accepts multipart/form-data (an optional document rides along), and
// every multipart field arrives as a string — a plain boolean() would reject
// the literal "false".
export const submitLeaveRequestSchema = z
    .object({
        leaveTypeId: z.string().uuid("leaveTypeId must be a valid id"),
        startDate: dateStringSchema,
        endDate: dateStringSchema,
        startHalfDay: booleanish.optional().default(false),
        endHalfDay: booleanish.optional().default(false),
        reason: z.string().trim().min(1, "Reason is required"),
    })
    .superRefine(refineDateRange);

// The `:id` path parameter, shared by every per-request route. UUID-checked
// here so a malformed id is a 422 rather than a Postgres 22P02 surfacing as a
// 500.
export const leaveRequestIdParamSchema = z.object({
    id: z.string().uuid("id must be a valid id"),
});

// Body for approve/reject/withdraw/cancel — a comment is optional on all four
// (the brief only requires one when a manager rejects, but allowing it
// everywhere costs nothing and avoids arbitrarily blocking a manager who
// wants to leave a note on an approval too).
export const decisionSchema = z.object({
    comment: z.string().trim().optional(),
});

// Body for HR's override endpoint — `toStatus` picks which of the two legal
// override transitions to apply (see leaveRequestStateMachine.js). Unlike
// decisionSchema above, `comment` is required here (client-requested change)
// — overturning the employee's actual manager needs a stated reason, same
// reasoning as profileValidator's sendProfileBackSchema requiring one.
export const overrideSchema = z.object({
    toStatus: z.enum(["APPROVED", "REJECTED"]),
    comment: z.string().trim().min(1, "A reason is required to override a decision"),
});

// Query params for the team/approvals lists (GET /leave-requests/team and
// /all). Two bounded shapes, and no unbounded one — that's the whole point:
//
//   - a **page**: `limit`/`offset`, defaulting to the first 25, for the list;
//   - a **window**: `startDate`+`endDate`, for the approvals calendar, which
//     needs every request overlapping the month it's showing (a page can't
//     express that — page 1 of a busy team is not "this month").
//
// A window needs no `limit` because the window itself bounds it, but only if
// the window can't be widened indefinitely: hence both dates are required
// together and the span is capped at 62 days (a month grid spans at most 42).
// Without that cap, `?startDate=1900-01-01&endDate=2100-01-01` would be the
// unbounded query this endpoint was paginated to remove.
export const teamLeaveRequestsQuerySchema = z
    .object({
        startDate: dateStringSchema.optional(),
        endDate: dateStringSchema.optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        offset: z.coerce.number().int().min(0).optional().default(0),
    })
    .superRefine((data, ctx) => {
        const hasStart = Boolean(data.startDate);
        const hasEnd = Boolean(data.endDate);
        if (hasStart !== hasEnd) {
            ctx.addIssue({
                code: "custom",
                path: [hasStart ? "endDate" : "startDate"],
                message: "startDate and endDate must be given together",
            });
            return;
        }
        if (!hasStart) return;
        if (data.endDate < data.startDate) {
            ctx.addIssue({ code: "custom", path: ["endDate"], message: "endDate must be on or after startDate" });
            return;
        }
        const spanDays = (new Date(data.endDate) - new Date(data.startDate)) / (24 * 60 * 60 * 1000) + 1;
        if (spanDays > MAX_WINDOW_DAYS) {
            ctx.addIssue({
                code: "custom",
                path: ["endDate"],
                message: `The date window cannot be longer than ${MAX_WINDOW_DAYS} days`,
            });
        }
    })
    .transform((data) => ({
        ...data,
        // A windowed request is bounded by its window, so it takes no page; an
        // unwindowed one always gets one. Applied here rather than as a zod
        // `.default()` so the two shapes can't overlap into "page 1 of this
        // month", which would silently hide events from the calendar.
        limit: data.limit ?? (data.startDate ? undefined : DEFAULT_PAGE_SIZE),
    }));

// FR-024: query params for HR's filterable browse view (GET /leave-requests)
// — every filter is optional, so an HR admin can start broad and narrow down.
// `status` covers every value the state machine can ever produce, not just
// the "active" ones — deliberately including WITHDRAWN/CANCELLED, since this
// is a browse/report view rather than an action queue.
export const listLeaveRequestsQuerySchema = z
    .object({
        employeeId: z.string().uuid("employeeId must be a valid id").optional(),
        leaveTypeId: z.string().uuid("leaveTypeId must be a valid id").optional(),
        status: z.enum(["SUBMITTED", "APPROVED", "REJECTED", "WITHDRAWN", "CANCELLED"]).optional(),
        startDate: dateStringSchema.optional(),
        endDate: dateStringSchema.optional(),
        // Pagination, same shape and reasoning as
        // notificationValidator.listNotificationsQuerySchema: coerced because
        // query-string values are always strings, defaulted so even a caller
        // that asks for no page still gets a bounded one, and capped so nobody
        // can request the whole unbounded table with limit=100000.
        limit: z.coerce.number().int().min(1).max(100).optional().default(25),
        offset: z.coerce.number().int().min(0).optional().default(0),
    })
    .refine((data) => !data.startDate || !data.endDate || data.endDate >= data.startDate, {
        message: "endDate must be on or after startDate",
        path: ["endDate"],
    });

// FR-024: query params for the leave-taken-per-employee report (and its CSV
// download) — unlike the browse filters above, the period is required: a
// report with no period at all (implicitly "all time") isn't a meaningful
// answer to "leave taken over a period".
export const leaveTakenReportQuerySchema = z
    .object({
        startDate: dateStringSchema,
        endDate: dateStringSchema,
    })
    .refine((data) => data.endDate >= data.startDate, {
        message: "endDate must be on or after startDate",
        path: ["endDate"],
    });
