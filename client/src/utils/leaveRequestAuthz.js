// Client-side mirror of leaveRequestService.resolveActingCapacity's
// APPROVE/REJECT gate — HR no longer has a blanket "act on your whole
// subtree" bypass there (client-requested change: the flow is always
// employee submits -> the actual manager decides -> HR overrides
// afterward). A manager/delegate's own team list (`getTeamLeaveRequests`)
// is already pre-scoped server-side to exactly what they can act on, so
// this only needs to narrow things further for an HR-tier viewer, whose
// team list spans a wider scope for visibility than what they can actually
// decide directly (an HR_ADMIN's whole reporting subtree; SUPER_ADMIN's
// direct-report HR_ADMINs only — see hrScopeService.js on the server).
export function canDecideDirectly(request, viewer) {
    if (!viewer || (viewer.role !== "HR_ADMIN" && viewer.role !== "SUPER_ADMIN")) return true;
    // An escalated request was submitted while the employee was covering
    // approvals for their own manager, so that manager is away and HR takes the
    // first decision instead of waiting for one (resolveActingCapacity's
    // hr_escalated branch). The list this renders from is already scope-filtered
    // server-side, so the flag alone is the whole client-side question.
    if (request.hr_escalated) return true;
    return request.employee_manager_id === viewer.id;
}
