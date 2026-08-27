import { describe, it, expect } from "vitest";
import { canDecideDirectly } from "./leaveRequestAuthz.js";

const HR = { id: "hr-1", role: "HR_ADMIN" };
const SUPER_ADMIN = { id: "sa-1", role: "SUPER_ADMIN" };
const MANAGER = { id: "mgr-1", role: "MANAGER" };

function requestFor(overrides = {}) {
    return { id: "req-1", employee_manager_id: "mgr-1", hr_escalated: false, ...overrides };
}

describe("canDecideDirectly", () => {
    // A manager/delegate's own team list is already scoped server-side to
    // exactly what they can act on, so this helper only ever narrows HR-tier.
    it("says yes for any non-HR-tier viewer", () => {
        expect(canDecideDirectly(requestFor(), MANAGER)).toBe(true);
    });

    it("says no for an HR-tier viewer who isn't the employee's assigned manager", () => {
        expect(canDecideDirectly(requestFor(), HR)).toBe(false);
        expect(canDecideDirectly(requestFor(), SUPER_ADMIN)).toBe(false);
    });

    it("says yes for an HR-tier viewer who *is* the employee's assigned manager", () => {
        expect(canDecideDirectly(requestFor({ employee_manager_id: HR.id }), HR)).toBe(true);
    });

    // The escalated case: the employee submitted this while covering their own
    // manager's approvals, so that manager is away and HR takes the first
    // decision. Without this, HR would see a request the server lets them decide
    // and no button to do it with.
    it("says yes for an HR-tier viewer on an escalated request", () => {
        expect(canDecideDirectly(requestFor({ hr_escalated: true }), HR)).toBe(true);
        expect(canDecideDirectly(requestFor({ hr_escalated: true }), SUPER_ADMIN)).toBe(true);
    });
});
