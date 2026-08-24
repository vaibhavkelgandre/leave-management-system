-- Adds EMPLOYMENT_DATES_UPDATED: tells an employee when HR changes their
-- joining date or records their last working day.
--
-- Both dates left the self-editable profile fields because they determine pay
-- (see userRepository's PROFILE_FIELD_COLUMNS note), which is exactly why a
-- change to one is worth telling the employee about — it is a change to their
-- own record that they can no longer make or see happen. SALARY_STRUCTURE_UPDATED
-- is the precedent, including its restraint: the message says the record
-- changed and never quotes a figure or a date, because a notification list is
-- glanced at casually and often over someone's shoulder.
--
-- One type for both the plain date edit and the exit action. They are the same
-- event from the employee's point of view ("HR updated my employment dates"),
-- and the exit action already produces its own SALARY_SLIP_VOIDED notifications
-- for any month it voids.
--
-- Reuses entity_type 'PROFILE' -- the same "about a user's own record" bucket as
-- every other profile-lifecycle notification -- so no entity_type change is
-- needed.
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
    'EMPLOYMENT_DATES_UPDATED'
));
