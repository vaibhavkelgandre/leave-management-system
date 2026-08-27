// Holidays are global and feed the working-day calculation, so every write here
// can change what live leave requests should have cost. Each mutating response
// therefore reports how many requests were recounted — HR has no other way to
// learn that declaring one holiday moved a dozen people's balances.
import * as holidayService from "../services/holidayService.js";
import { sendSuccess } from "../utils/apiResponse.js";

// "Holiday created. 3 leave request(s) recounted." — the count belongs in the
// message rather than only the payload, because it is the surprising part.
function withAdjustments(base, adjusted) {
    if (!adjusted.length) return base;
    return `${base} ${adjusted.length} leave request(s) recounted.`;
}

// POST /api/holidays — HR_ADMIN or SUPER_ADMIN.
// 201 with `{ holiday, adjusted }`. 409 when the range overlaps an existing
// holiday (checked in the service, since ranges make DB-level uniqueness
// meaningless). `adjusted` lists every live request whose day count changed.
export async function createHoliday(req, res, next) {
    try {
        const { holiday, adjusted } = await holidayService.createHoliday(req.body, req.user.id);
        sendSuccess(res, 201, withAdjustments("Holiday created.", adjusted), { holiday, adjusted });
    } catch (error) {
        next(error);
    }
}

// GET /api/holidays — any authenticated role; everyone needs the calendar to
// read a working-day count. Optional `year` narrows it; unpaginated because a
// year of holidays is inherently small.
export async function getHolidays(req, res, next) {
    try {
        const holidays = await holidayService.listHolidays(req.query.year);
        sendSuccess(res, 200, "Holidays retrieved", holidays);
    } catch (error) {
        next(error);
    }
}

// PATCH /api/holidays/:id — HR-tier. 404 if it doesn't exist, 409 on overlap.
//
// Moving a holiday reconciles the union of the old and new ranges, because
// both sets of dates changed meaning: the new ones became holidays and the old
// ones stopped being holidays, and only recounting both catches the second.
export async function updateHoliday(req, res, next) {
    try {
        const { holiday, adjusted } = await holidayService.updateHoliday(req.params.id, req.body, req.user.id);
        sendSuccess(res, 200, withAdjustments("Holiday updated.", adjusted), { holiday, adjusted });
    } catch (error) {
        next(error);
    }
}

// DELETE /api/holidays/:id — HR-tier. Returns `{ adjusted }` only; there is no
// holiday left to return.
//
// Recounts in the opposite direction: a day that was excluded from a live
// request now counts again, so employees are charged the day back. Deleting a
// holiday declared in error is exactly the case this exists for.
export async function deleteHoliday(req, res, next) {
    try {
        const { adjusted } = await holidayService.deleteHoliday(req.params.id, req.user.id);
        sendSuccess(res, 200, withAdjustments("Holiday deleted.", adjusted), { adjusted });
    } catch (error) {
        next(error);
    }
}
