// Request-shape validation for leave types (FR-007/FR-008). Rejects a bad
// payload before any handler runs, so services can assume the shape is sound
// and concern themselves only with the business rules.
import { z } from "zod";

// Enforces FR-009 (half-day leave) at the leave-type level: entitlements must
// land on a 0.5 boundary so balances derived from them stay half-day-accurate.
const isHalfDayIncrement = (value) => Number.isInteger(value * 2);

// Body for creating a leave type. Every field the table needs, with the four
// behaviour flags defaulted so an older client omitting them still gets the
// conservative choice rather than an undefined column.
export const createLeaveTypeSchema = z.object({
    name: z.string().trim().min(1, "Name is required"),
    annualEntitlement: z
        .number()
        .min(0, "annualEntitlement must be 0 or greater")
        .refine(isHalfDayIncrement, "annualEntitlement must be in increments of 0.5"),
    accrualType: z.enum(["UPFRONT", "MONTHLY"]),
    allowNegativeBalance: z.boolean().optional().default(false),
    requiresDocument: z.boolean().optional().default(false),
    // Module 5 v2: flags this leave type as unpaid for payroll purposes
    // (e.g. a "Loss of Pay" leave type) — see salarySlipService.js.
    countsAsLop: z.boolean().optional().default(false),
});

// Update takes one field create doesn't: whether the new entitlement should
// also be written onto this year's existing balance rows. Opt-in, defaulting to
// false, because `leave_balances.entitlement` is a snapshot and silently
// rewriting it would change numbers employees have already been shown — see
// leaveTypeService.updateLeaveType.
export const updateLeaveTypeSchema = createLeaveTypeSchema.extend({
    applyToCurrentYear: z.boolean().optional().default(false),
});

// The `:id` path parameter. Checked as a UUID before it reaches Postgres —
// a malformed id would otherwise raise 22P02 and surface as a 500 rather
// than the 422 it actually is.
export const leaveTypeIdParamSchema = z.object({
    id: z.string().uuid("id must be a valid id"),
});

// Body for activating/deactivating a type. Deliberately just the one flag:
// this endpoint exists so a status change can't be smuggled in alongside an
// entitlement edit, which has entirely different consequences.
export const updateLeaveTypeStatusSchema = z.object({
    isActive: z.boolean(),
});

// Query for the list endpoint. `z.coerce` because query strings are always
// strings — a bare boolean() would reject "true". Defaults to false so the
// common caller (a picker) never has to think about retired types.
export const listLeaveTypesQuerySchema = z.object({
    includeInactive: z.coerce.boolean().optional().default(false),
});
