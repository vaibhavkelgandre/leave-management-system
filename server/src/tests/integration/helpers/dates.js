// Date helpers for fixtures that have to be anchored to the real "today"
// rather than a fixed future date — currently only the on-leave-today
// endpoint's tests, which are about overlap with the actual current date.
//
// Everything else in the suite uses the fixed dates in factories.js (2027),
// deliberately: a fixture that depends on what day it happens to be is a
// fixture that can fail on a Saturday for reasons that have nothing to do
// with the code under test. Reach for this only when "today" is genuinely
// part of the behaviour being tested.
import { todayDateKey, addDaysToDateKey, isWeekend } from "../../../utils/dates.js";

// A leave-request date range that contains today *and* at least one working
// day.
//
// Input: none. Output: `{ startDate, endDate }` as "YYYY-MM-DD" keys. No
// failure mode.
//
// Why this exists: submitLeaveRequest refuses a range with zero working days,
// so the obvious `startDate: today, endDate: today` fixture throws "This date
// range doesn't include any working days" every Saturday and Sunday — during
// setup, before the test reaches its own assertions. Widening to a fixed
// window (say today±1) would fix it, but silently changes the tightest case
// on a weekday too. So the range stays exactly today→today whenever today is
// a working day, and only stretches by one day onto the adjacent weekday when
// it has to: back to Friday on a Saturday, forward to Monday on a Sunday.
// Either way it still contains today, which is what "on leave today" needs.
export function leaveRangeCoveringToday() {
    const today = todayDateKey();

    if (!isWeekend(today)) {
        return { startDate: today, endDate: today };
    }

    const previousDay = addDaysToDateKey(today, -1);
    if (!isWeekend(previousDay)) {
        return { startDate: previousDay, endDate: today };
    }

    return { startDate: today, endDate: addDaysToDateKey(today, 1) };
}

// A single-day leave-request range a given number of days after today, moved
// forward to the next working day if it lands on a weekend.
//
// Input: a positive whole-day offset from today, large enough that the result
// can't overlap today. Output: `{ startDate, endDate }` (the same day twice)
// as "YYYY-MM-DD" keys. No failure mode.
//
// Why this exists: the same zero-working-day trap as above, but latent rather
// than visible. A fixture written as `today+10 … today+11` looks safe because
// it's two days wide — but two consecutive days land on Saturday *and* Sunday
// whenever today is a Wednesday, so it would have failed every Wednesday. Any
// window narrower than three days has some weekday it breaks on; rather than
// widening it (and changing what the fixture means), this shifts the whole
// thing onto the next working day.
export function leaveRangeAfterToday(offsetDays) {
    let target = addDaysToDateKey(todayDateKey(), offsetDays);

    while (isWeekend(target)) {
        target = addDaysToDateKey(target, 1);
    }

    return { startDate: target, endDate: target };
}
