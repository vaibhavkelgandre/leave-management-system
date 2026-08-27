// Request-shape validation for delegations (FR-020).
import { z } from "zod";

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be in YYYY-MM-DD format");

// Body for nominating a delegate. Dates are validated as a well-formed,
// non-inverted range here; *who* may be nominated and whether the window
// overlaps an existing delegation are business rules, checked in
// delegationService where the database is available.
export const createDelegationSchema = z
    .object({
        delegateId: z.string().uuid("delegateId must be a valid id"),
        startDate: dateStringSchema,
        endDate: dateStringSchema,
    })
    .refine((data) => data.endDate >= data.startDate, {
        message: "endDate must be on or after startDate",
        path: ["endDate"],
    });
