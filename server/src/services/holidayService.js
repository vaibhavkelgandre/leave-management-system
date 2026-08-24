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

export async function createHoliday({ name, startDate, endDate }, actorId) {
    const resolvedEndDate = endDate || startDate;

    if (await findOverlappingHoliday({ startDate, endDate: resolvedEndDate })) {
        throw conflict("A holiday already covers one or more of these dates");
    }

    const holiday = await insertHoliday({ name, startDate, endDate: resolvedEndDate });
    const { adjusted } = await reconcileWorkingDaysForHolidayChange(actorId, startDate, resolvedEndDate);
    return { holiday, adjusted };
}

export async function listHolidays(year) {
    return findAllHolidays({ year });
}

export async function getHolidayById(id) {
    const holiday = await findHolidayById(id);
    if (!holiday) {
        throw notFound("Holiday not found");
    }
    return holiday;
}

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
