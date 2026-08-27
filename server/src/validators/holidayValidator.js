// Request-shape validation for the public-holiday calendar (FR-010).
//
// Holidays are stored as a date *range* rather than a single date, so every
// schema here deals with a start/end pair — see docs/3.db and holidayService.
import { z } from "zod";

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be in YYYY-MM-DD format");

// Body for declaring a holiday. The refine is the load-bearing part: an
// inverted range would otherwise be stored happily and then match no dates
// at all, making the holiday silently invisible to the working-day count.
export const createHolidaySchema = z
    .object({
        name: z.string().trim().min(1, "Name is required"),
        startDate: dateStringSchema,
        // Omitted entirely for a single-day holiday — the service defaults it
        // to startDate. Compared as plain strings, which sorts correctly
        // because the format is always zero-padded YYYY-MM-DD.
        endDate: dateStringSchema.optional(),
    })
    .refine((data) => !data.endDate || data.endDate >= data.startDate, {
        message: "endDate must be on or after startDate",
        path: ["endDate"],
    });

// Update takes the same shape as create — a holiday has no partial edit; the
// client always sends the whole record. Aliased rather than redefined so the
// two can never drift apart.
export const updateHolidaySchema = createHolidaySchema;

// The `:id` path parameter, UUID-checked before it reaches the database.
export const holidayIdParamSchema = z.object({
    id: z.string().uuid("id must be a valid id"),
});

// Query for the list endpoint. `z.coerce` because a query string is always a
// string, and the year is bounded so a typo can't ask Postgres to scan for
// holidays in the year 20000.
export const listHolidaysQuerySchema = z.object({
    year: z.coerce.number().int().min(2000).max(2100).optional(),
});
