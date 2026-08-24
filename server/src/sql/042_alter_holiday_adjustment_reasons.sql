-- Two CHECK constraints widened for one change: correcting leave requests when
-- a public holiday is added, moved or removed.
--
-- `leave_requests.working_days` is computed once at submit and never
-- recomputed, and the ledger entries that move days to pending/taken use that
-- stored value. So a holiday declared *after* a request was approved left the
-- employee charged for a day that had become a holiday — five days deducted for
-- a Mon-Fri leave with a Wednesday holiday in it, permanently one day short. The
-- reverse (a holiday deleted in error) under-charges the same way.
--
-- The correction is an append, not an edit, which is the whole reason
-- leave_balance_ledger exists (NFR-2: a balance must agree with the history that
-- produced it). HOLIDAY_ADJUSTMENT is that entry's reason -- descriptive only,
-- like every other value in this list; no query branches on it.
--
-- LEAVE_DAYS_ADJUSTED tells the employee their leave was recounted. It reuses
-- entity_type 'LEAVE_REQUEST', so no entity_type change is needed.
ALTER TABLE leave_balance_ledger DROP CONSTRAINT IF EXISTS leave_balance_ledger_reason_check;
ALTER TABLE leave_balance_ledger ADD CONSTRAINT leave_balance_ledger_reason_check CHECK (reason IN (
    'SUBMIT', 'APPROVE', 'REJECT', 'WITHDRAW', 'CANCEL',
    'HR_OVERRIDE_APPROVE', 'HR_OVERRIDE_REJECT',
    'HOLIDAY_ADJUSTMENT'
));

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
    'LEAVE_REQUEST_SUBMITTED',
    'LEAVE_REQUEST_DECIDED',
    'LEAVE_REQUEST_WITHDRAWN_CANCELLED',
    'LEAVE_REQUEST_OVERDUE',
    'LEAVE_REQUEST_AWAITING_DECISION',
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
    'PROFILE_CREATED',
    'EMPLOYMENT_DATES_UPDATED',
    'LEAVE_DAYS_ADJUSTED'
));
