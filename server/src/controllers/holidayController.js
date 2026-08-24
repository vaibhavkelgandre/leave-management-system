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

export async function createHoliday(req, res, next) {
    try {
        const { holiday, adjusted } = await holidayService.createHoliday(req.body, req.user.id);
        sendSuccess(res, 201, withAdjustments("Holiday created.", adjusted), { holiday, adjusted });
    } catch (error) {
        next(error);
    }
}

export async function getHolidays(req, res, next) {
    try {
        const holidays = await holidayService.listHolidays(req.query.year);
        sendSuccess(res, 200, "Holidays retrieved", holidays);
    } catch (error) {
        next(error);
    }
}

export async function updateHoliday(req, res, next) {
    try {
        const { holiday, adjusted } = await holidayService.updateHoliday(req.params.id, req.body, req.user.id);
        sendSuccess(res, 200, withAdjustments("Holiday updated.", adjusted), { holiday, adjusted });
    } catch (error) {
        next(error);
    }
}

export async function deleteHoliday(req, res, next) {
    try {
        const { adjusted } = await holidayService.deleteHoliday(req.params.id, req.user.id);
        sendSuccess(res, 200, withAdjustments("Holiday deleted.", adjusted), { adjusted });
    } catch (error) {
        next(error);
    }
}
