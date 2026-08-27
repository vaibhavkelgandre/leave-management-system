-- Rule 5 of the delegation flow: a leave request submitted by someone who was,
-- at that moment, actively standing in as a delegate for their *own* manager is
-- routed to HR instead of that manager, because the manager being away is the
-- whole reason a delegate exists. HR may then decide it directly, which is
-- otherwise impossible in this app (HR is override-only — see
-- leaveRequestService.resolveActingCapacity).
--
-- Stored rather than derived, and that is the point of the column. The
-- equivalent question could be asked of the delegations table at decision time
-- ("was this employee serving a delegation when they submitted?"), but the
-- answer changes the moment the delegation window lapses — so an escalated
-- request nobody got round to deciding would silently stop being HR's to
-- decide, which is exactly the dead end the escalation exists to prevent.
-- Decided once at submit time, never rewritten afterwards.
--
-- Defaults to false so every request that predates this column reads as "the
-- ordinary manager-decides flow", which is what they all were.
ALTER TABLE leave_requests
    ADD COLUMN IF NOT EXISTS hr_escalated BOOLEAN NOT NULL DEFAULT false;

-- HR's pending-approvals badge counts escalated requests across their whole
-- scope (leaveRequestRepository.countPendingDecisionsForManagers), which is a
-- status + flag lookup over every request in a branch. Partial, because only
-- the true rows are ever searched for and they are a small minority.
CREATE INDEX IF NOT EXISTS idx_leave_requests_hr_escalated
    ON leave_requests (employee_id, status)
    WHERE hr_escalated;
