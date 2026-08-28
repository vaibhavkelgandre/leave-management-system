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

// Body for editing an existing delegation. Every field is optional — a manager
// swapping the delegate has no reason to resend dates that are not changing —
// but at least one must be present, or the request asks for nothing and the
// only honest answer is that it is malformed.
//
// The range is deliberately **not** refined here, unlike the create schema
// above: with both dates optional, either half of the resulting window can come
// from the stored row, so a body carrying only `startDate` can still invert it
// and this schema would never see the other value. That check lives in
// delegationService, which has the stored row in hand.
export const updateDelegationSchema = z
    .object({
        delegateId: z.string().uuid("delegateId must be a valid id").optional(),
        startDate: dateStringSchema.optional(),
        endDate: dateStringSchema.optional(),
    })
    .refine((data) => Object.values(data).some((value) => value !== undefined), {
        message: "Provide at least one of delegateId, startDate or endDate",
    });
