-- Adds ROLE_CHANGED: the notification an employee gets when HR promotes or
-- demotes them (PATCH /api/users/:id/role).
--
-- Until now a role could only be set at invite time, so there was no event to
-- report. A role change is the employee's own business twice over: it changes
-- what the app lets them do, and a promotion to MANAGER is usually paired with
-- a reporting-line change they would otherwise only discover by looking.
--
-- The message deliberately **names the new role**, unlike the pay-affecting
-- notifications (SALARY_STRUCTURE_UPDATED, EMPLOYMENT_DATES_UPDATED), which
-- quote no figures. A role is not sensitive the way a salary is, and "your
-- role changed" without saying to what is not actionable — the same reasoning
-- as LEAVE_DAYS_ADJUSTED quoting both day counts.
--
-- Reuses entity_type 'PROFILE' — "something about this user's own record
-- changed" — rather than inventing an entity type per field, matching
-- MANAGER_REASSIGNED / ACCOUNT_STATUS_CHANGED / SALARY_STRUCTURE_UPDATED.
-- Routes to /dashboard/profile, the bucket every self-facing
-- profile-lifecycle notification already uses.
--
-- A promotion can also fire MANAGER_REASSIGNED and TEAM_MEMBER_ASSIGNED, when
-- the same call moves the reporting line. Those are deliberately left as
-- separate notifications rather than folded into this one: they have a
-- different audience (the new manager is told about their new report) and the
-- employee genuinely has two distinct things to read.
--
-- The value list below is copied from 046 (the newest declaration) with one
-- value appended. There is no ADD VALUE for a CHECK constraint, so every
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
    'DELEGATION_UPDATED',
    'ROLE_CHANGED'
));
