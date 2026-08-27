// The public-holiday calendar (FR-010), and the recount every write triggers.
//
// Holidays are stored as a date *range*, not a single date, so a multi-day
// holiday is one row. There is no database-level uniqueness on those dates —
// ranges make exact-duplicate uniqueness meaningless — so overlap is checked
// here instead and answered with a 409, the same status the old constraint gave.
import {
    insertHoliday,
    findAllHolidays,
    findHolidayById,
    findOverlappingHoliday,
    updateHoliday as updateHolidayRepo,
    deleteHoliday as deleteHolidayRepo,
} from "../repositories/holidayRepository.js";
import { reconcileWorkingDaysForHolidayChange } from "./leaveRequestService.js";
import { conflict, notFound } from "../utils/appError.js";

// A holiday is global and feeds the working-day calculation, so adding,
// moving or removing one changes what every live leave request over those
// dates should have cost. Those requests stored their working-day count at
// submit time and nothing recomputed it, so the employee stayed charged for a
// day that had become a holiday — see
// leaveRequestService.reconcileWorkingDaysForHolidayChange for what the
// correction does and why it is a ledger append rather than a rewrite.
//
// Awaited, not fired and forgotten: the returned `adjusted` list is how HR
// finds out that adding one holiday moved a dozen balances, and a correction
// that silently failed would leave exactly the drift this exists to remove.
// A moved holiday reconciles the union of its old and new ranges, because both
// sets of dates changed meaning.

// Input: `{ name, startDate, endDate? }` and the acting HR user's id.
// Output: `{ holiday, adjusted }` — `adjusted` naming every live request whose
// day count changed. Throws 409 when the range overlaps an existing holiday.
//
// `endDate` is optional and defaults to `startDate`, which is what makes a
// single-day holiday the easy case for callers while the storage stays a range.
// `actorId` is needed only because the recount notifies affected employees and
// may void payslips — attributing that to a person is the point.
export async function createHoliday({ name, startDate, endDate }, actorId) {
    const resolvedEndDate = endDate || startDate;

    if (await findOverlappingHoliday({ startDate, endDate: resolvedEndDate })) {
        throw conflict("A holiday already covers one or more of these dates");
    }

    const holiday = await insertHoliday({ name, startDate, endDate: resolvedEndDate });
    const { adjusted } = await reconcileWorkingDaysForHolidayChange(actorId, startDate, resolvedEndDate);
    return { holiday, adjusted };
}

// Input: an optional year. Output: the matching holidays.
//
// Open to every role, deliberately: the working-day count is meaningless
// without the calendar behind it, so anyone who can request leave can read it.
export async function listHolidays(year) {
    return findAllHolidays({ year });
}

// Input: a holiday id. Output: the row. Throws 404 if it doesn't exist.
// Used as the existence guard by update and delete below.
export async function getHolidayById(id) {
    const holiday = await findHolidayById(id);
    if (!holiday) {
        throw notFound("Holiday not found");
    }
    return holiday;
}

// Input: the id, the full new definition, and the actor's id. Output:
// `{ holiday, adjusted }`. Throws 404 if it doesn't exist, 409 on overlap with
// a *different* holiday (its own row is excluded from that check, or every
// edit would collide with itself).
export async function updateHoliday(id, { name, startDate, endDate }, actorId) {
    const existing = await getHolidayById(id);
    const resolvedEndDate = endDate || startDate;

    if (await findOverlappingHoliday({ startDate, endDate: resolvedEndDate, excludeId: id })) {
        throw conflict("A holiday already covers one or more of these dates");
    }

    const updated = await updateHolidayRepo(id, { name, startDate, endDate: resolvedEndDate });
    if (!updated) {
        throw notFound("Holiday not found");
    }

    // The union of where it was and where it is now: a holiday moved from the
    // 15th to the 20th changes the count of requests covering either date.
    const from = existing.start_date < startDate ? existing.start_date : startDate;
    const to = existing.end_date > resolvedEndDate ? existing.end_date : resolvedEndDate;
    const { adjusted } = await reconcileWorkingDaysForHolidayChange(actorId, from, to);
    return { holiday: updated, adjusted };
}

// Input: the id and the actor's id. Output: `{ adjusted }` — there is no
// holiday left to return. Throws 404 if it doesn't exist.
//
// Recounts in the opposite direction to create: a date that was excluded from
// a live request becomes a working day again, so the employee is charged it
// back. Deleting a holiday declared by mistake is exactly the case this
// exists for, and without the recount it would leave them permanently
// under-charged.
export async function deleteHoliday(id, actorId) {
    // Read before deleting: the dates are needed to know which requests to
    // recount, and they're gone once the row is.
    const existing = await getHolidayById(id);

    const deleted = await deleteHolidayRepo(id);
    if (!deleted) {
        throw notFound("Holiday not found");
    }

    const { adjusted } = await reconcileWorkingDaysForHolidayChange(actorId, existing.start_date, existing.end_date);
    return { adjusted };
}
