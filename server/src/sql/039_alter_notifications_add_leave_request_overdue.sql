-- Adds LEAVE_REQUEST_OVERDUE: told to both the employee and their manager
-- when a request is still SUBMITTED long after the leave itself has passed.
--
-- This exists because a SUBMITTED request holds days in leave_balance_ledger
-- as `pending`, and only APPROVE, REJECT or WITHDRAW release that hold
-- (leaveRequestService.ledgerDeltaForAction). A request nobody ever decides
-- therefore shrinks the employee's usable balance permanently, with nothing
-- anywhere reporting it. The payroll lock added alongside this makes it more
-- reachable still: once a payslip is issued for the period, the request can no
-- longer be approved or rejected at all, and withdrawal becomes the only exit.
--
-- Notifying rather than auto-closing is deliberate. Every auto-close needs a
-- decided_by/actor, and recording a manager as having rejected something they
-- never looked at attributes an action to a person who did not take it, which
-- is exactly what an append-only audit trail exists to prevent. A new EXPIRED
-- status would avoid that but is a product decision about what the employee
-- sees, not a technical one. So the sweep tells the two people who can act.
--
-- Reuses entity_type 'LEAVE_REQUEST' -- same bucket as every other
-- request-lifecycle notification -- so no entity_type change is needed.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
    'LEAVE_REQUEST_SUBMITTED',
    'LEAVE_REQUEST_DECIDED',
    'LEAVE_REQUEST_WITHDRAWN_CANCELLED',
    'LEAVE_REQUEST_OVERDUE',
    'PROFILE_SUBMITTED',
    'PROFILE_VERIFIED',
    'PROFILE_SENT_BACK',
    'SALARY_SLIP_GENERATED',
    'SALARY_SLIP_VOIDED',
    'MANAGER_REASSIGNED',
    'TEAM_MEMBER_ASSIGNED',
    'SALARY_STRUCTURE_UPDATED',
    'ACCOUNT_STATUS_CHANGED',
    'DELEGATION_NOMINATED',
    'DELEGATION_STARTED',
    'DELEGATION_ENDED',
    'INVITE_ACCEPTED',
    'PROFILE_CREATED'
));
