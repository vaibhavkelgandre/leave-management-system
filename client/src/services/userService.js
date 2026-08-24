import apiClient, { unwrap } from "./apiClient.js";

export async function getUsers() {
    const response = await apiClient.get("/users");
    return unwrap(response);
}

// Picker-sized user list: id, name, role, status — nothing else. Use this for
// any dropdown; `getUsers()` returns every profile field of every user (~40
// columns each) and is only right for the All Employees roster, which
// actually displays them.
export async function getUserOptions() {
    const response = await apiClient.get("/users/options");
    return unwrap(response);
}

export async function getMyTeam() {
    const response = await apiClient.get("/users/me/team");
    return unwrap(response);
}

// Count-only sibling of getMyTeam, for the dashboard's headcount chip: that
// tile reads a single number, and getMyTeam returns every subtree row with all
// ~40 public columns.
export async function getMyTeamSize() {
    const response = await apiClient.get("/users/me/team/count");
    return unwrap(response).count;
}

export async function inviteEmployee({ firstName, lastName, email, role, managerId }) {
    const response = await apiClient.post("/users/invite", {
        firstName,
        lastName,
        email,
        role,
        managerId,
    });
    return unwrap(response);
}

export async function updateManager(userId, managerId) {
    const response = await apiClient.patch(`/users/${userId}/manager`, { managerId });
    return unwrap(response);
}

export async function updateStatus(userId, status) {
    const response = await apiClient.patch(`/users/${userId}/status`, { status });
    return unwrap(response);
}

export async function getUserById(userId) {
    const response = await apiClient.get(`/users/${userId}`);
    return unwrap(response);
}

export async function updateMyProfile(fields) {
    const response = await apiClient.patch("/users/me/profile", fields);
    return unwrap(response);
}

export async function changeMyPassword(currentPassword, newPassword) {
    const response = await apiClient.post("/users/me/password", { currentPassword, newPassword });
    return unwrap(response);
}

export async function submitProfileForVerification() {
    const response = await apiClient.post("/employees/me/profile/submit");
    return unwrap(response);
}

export async function getPendingVerification() {
    const response = await apiClient.get("/employees/pending-verification");
    return unwrap(response);
}

// Not getUserById (`/users/:id`) — that route lets any HR admin view any
// user company-wide; this one is scoped to the caller's own reporting
// subtree, matching every other HR-scoped action in this app.
export async function getEmployeeForVerification(employeeId) {
    const response = await apiClient.get(`/employees/${employeeId}`);
    return unwrap(response);
}

export async function getVerifiedEmployees() {
    const response = await apiClient.get("/employees/verified");
    return unwrap(response);
}

export async function verifyEmployeeProfile(employeeId) {
    const response = await apiClient.post(`/employees/${employeeId}/verify`);
    return unwrap(response);
}

export async function sendProfileBack(employeeId, reason) {
    const response = await apiClient.post(`/employees/${employeeId}/send-back`, { reason });
    return unwrap(response);
}

// HR records the two employment dates payroll depends on. Neither is
// self-editable — both determine the payable-day count on a payslip, so the
// value payroll trusts must not come from the person being paid.
export async function updateEmploymentDates(employeeId, dates) {
    const response = await apiClient.patch(`/employees/${employeeId}/employment-dates`, dates);
    return unwrap(response);
}

// HR records that an employee has left. One call: it sets the leaving date and
// corrects any payslip that date invalidates, returning which periods were
// voided and which were reissued so the UI can say what happened.
export async function recordEmployeeExit(employeeId, { lastWorkingDay, reason }) {
    const response = await apiClient.post(`/employees/${employeeId}/exit`, { lastWorkingDay, reason });
    return unwrap(response);
}
