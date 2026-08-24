// Shared "YYYY-MM" pay-period formatting — pulled out of
// notificationService.js once payslipPdfService.js also needed the same
// "August 2026"-style label, so the two don't carry independent copies of
// the same month-name table.
const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

// Input: a "YYYY-MM" pay period. Output: a human-readable "August 2026".
// No failure mode — payPeriod is already validated to this shape wherever
// it's produced (salarySlipValidator.js).
export function formatPayPeriod(payPeriod) {
    const [year, month] = payPeriod.split("-").map(Number);
    return `${MONTH_NAMES[month - 1]} ${year}`;
}

// Every "YYYY-MM" pay period a date range touches, inclusive.
//
// Input: two "YYYY-MM-DD" keys. Output: an ascending array of "YYYY-MM"
// strings — one entry for a range inside a single month, more when it spans a
// month boundary. A backwards range collapses to just the start month rather
// than returning nothing, matching eachDateKeyInRange's behaviour.
//
// Needed because a leave request is charged *in full* to every period it
// overlaps (findLopWorkingDays sums the whole request into any period whose
// dates it touches — a documented simplification, not pro-rating), so a
// request spanning 28 Jul to 3 Aug affects both months' payroll and both have
// to be considered when deciding whether it may be acted on.
export function payPeriodsInRange(startDate, endDate) {
    const [startYear, startMonth] = startDate.split("-").map(Number);
    const last = endDate && endDate >= startDate ? endDate : startDate;
    const [endYear, endMonth] = last.split("-").map(Number);

    const periods = [];
    let year = startYear;
    let month = startMonth;

    while (year < endYear || (year === endYear && month <= endMonth)) {
        periods.push(`${year}-${String(month).padStart(2, "0")}`);
        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
    }

    return periods;
}
