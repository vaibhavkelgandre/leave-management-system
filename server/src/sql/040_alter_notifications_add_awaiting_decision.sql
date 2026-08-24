-- Adds LEAVE_REQUEST_AWAITING_DECISION, the employee-facing half of the
-- overdue-request sweep whose manager-facing half (LEAVE_REQUEST_OVERDUE) was
-- added in 039.
--
-- Two types for one event, following the MANAGER_REASSIGNED /
-- TEAM_MEMBER_ASSIGNED precedent: the two recipients need differently-worded
-- messages *and* different destinations when clicked. The manager goes to
-- Approvals to decide it; the employee goes to My Leave to withdraw it. That
-- distinction has to live in the type, because
-- client/src/utils/notificationRouting.js maps type -> destination and
-- deliberately takes no account of the viewer's role — a single shared type
-- would have to send one of the two audiences to the wrong page, and sending
-- an employee to /dashboard/approvals bounces them to /403.
--
-- Separate migration rather than an edit to 039 because 039 is already
-- applied: the runner stores a SHA-256 of every applied file and aborts the
-- whole run if one changed. That is the ledger working as intended, not an
-- inconvenience to route around.
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
    'PROFILE_CREATED'
));
