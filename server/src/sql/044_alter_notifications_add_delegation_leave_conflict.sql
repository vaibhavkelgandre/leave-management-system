-- Adds DELEGATION_LEAVE_CONFLICT: rule 3 of the delegation flow.
--
-- A manager cannot nominate a delegate whose leave already overlaps the
-- coverage window (delegationService.createDelegation refuses it), but the same
-- clash can arrive in the opposite order: the delegation is created first, and
-- the delegate books leave inside it afterwards. That is deliberately *allowed*
-- as long as the window has not started yet — refusing it would leave someone
-- unable to take leave because of a nomination they never agreed to, and
-- FR-020 has no accept/reject flow for them to decline through.
--
-- So it is a notification rather than a refusal, and it goes to both sides: the
-- delegate is told they are expected to cover those dates and to contact their
-- manager if they cannot, and the nominating manager is told their chosen
-- delegate has just booked leave inside the window, since otherwise the manager
-- only finds out if the employee remembers to say so.
--
-- Reuses entity_type 'DELEGATION' -- the notification is about the delegation,
-- not the leave request -- so no entity_type change is needed.
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
    'DELEGATION_LEAVE_CONFLICT',
    'INVITE_ACCEPTED',
    'PROFILE_CREATED',
    'EMPLOYMENT_DATES_UPDATED',
    'LEAVE_DAYS_ADJUSTED'
));
