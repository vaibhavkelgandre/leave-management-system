-- Adds DELEGATION_REVOKED and DELEGATION_UPDATED: the two things a manager
-- editing a delegation (PATCH /api/delegations/:id) has to tell the delegate.
--
-- Before the edit endpoint a delegation was write-once, so the only thing a
-- delegate ever needed telling was that they had been nominated
-- (DELEGATION_NOMINATED). An edit produces two further events, and they are
-- separate types rather than one because they are not the same news:
--   - DELEGATION_REVOKED goes to the person who has just been swapped *out*.
--     Their delegation no longer names them at all, so typing it as an
--     "update" would misdescribe it.
--   - DELEGATION_UPDATED goes to the delegate who is still the delegate, when
--     only the dates moved.
-- The newly-chosen delegate of a swap needs no new type — from their side it
-- is an ordinary nomination, so it reuses DELEGATION_NOMINATED.
--
-- Both reuse entity_type 'DELEGATION' and, like DELEGATION_NOMINATED, route to
-- the dashboard: FR-020 still gives a delegate no page of their own.
--
-- The value list below is copied from 044 (the newest declaration) with two
-- values appended. There is no ADD VALUE for a CHECK constraint, so every
-- migration here re-declares the whole list, and copying an older ancestor's
-- list silently deletes everything added in between -- which is exactly what
-- 044 did to LEAVE_DAYS_ADJUSTED. notificationTypeConstraint.test.js guards it.
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
    'LEAVE_DAYS_ADJUSTED',
    'DELEGATION_REVOKED',
    'DELEGATION_UPDATED'
));
