import { Routes, Route } from "react-router-dom";
import { HomePage } from "./pages/HomePage.jsx";
import { LoginPage } from "./pages/LoginPage.jsx";
import { RegisterSuperAdminPage } from "./pages/RegisterSuperAdminPage.jsx";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage.jsx";
import { ResetPasswordPage } from "./pages/ResetPasswordPage.jsx";
import { AcceptInvitePage } from "./pages/AcceptInvitePage.jsx";
import { DashboardPage } from "./pages/DashboardPage.jsx";
import { TeamPage } from "./pages/TeamPage.jsx";
import { EmployeesPage } from "./pages/EmployeesPage.jsx";
import { AddEmployeePage } from "./pages/AddEmployeePage.jsx";
import { EmployeeDetailsPage } from "./pages/EmployeeDetailsPage.jsx";
import { HrReportsPage } from "./pages/HrReportsPage.jsx";
import { MyBalancesPage } from "./pages/MyBalancesPage.jsx";
import { ApplyLeavePage } from "./pages/ApplyLeavePage.jsx";
import { SalarySlipsPage } from "./pages/SalarySlipsPage.jsx";
import { PayrollRunPage } from "./pages/PayrollRunPage.jsx";
import { ProfilePage } from "./pages/ProfilePage.jsx";
import { NotificationsPage } from "./pages/NotificationsPage.jsx";
import { DocumentViewerPage } from "./pages/DocumentViewerPage.jsx";
import { EmployeeVerificationPage } from "./pages/EmployeeVerificationPage.jsx";
import { EmployeeVerificationDetailPage } from "./pages/EmployeeVerificationDetailPage.jsx";
import { LeaveTypesPage } from "./pages/LeaveTypesPage.jsx";
import { HolidaysPage } from "./pages/HolidaysPage.jsx";
import { ApprovalsPage } from "./pages/ApprovalsPage.jsx";
import { DelegationsPage } from "./pages/DelegationsPage.jsx";
import { NotFoundPage } from "./pages/NotFoundPage.jsx";
import { ForbiddenPage } from "./pages/ForbiddenPage.jsx";
import { AppLayout } from "./components/layout/AppLayout.jsx";
import { RequireAuth } from "./components/routing/RequireAuth.jsx";
import { RequireRole } from "./components/routing/RequireRole.jsx";
import { PublicOnlyRoute } from "./components/routing/PublicOnlyRoute.jsx";
import { BootstrapOnlyRoute } from "./components/routing/BootstrapOnlyRoute.jsx";
import { ROLES } from "./constants/roles.js";

function App() {
    return (
        <Routes>
            <Route path="/" element={<HomePage />} />

            <Route element={<PublicOnlyRoute />}>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />

                {/* Nested inside PublicOnlyRoute on purpose, so that guard
                    still owns where a newly-authenticated user lands — the
                    setup form signs its own creator in, and this route must
                    not race it to /login on a status answer that is stale the
                    instant the account exists. BootstrapOnlyRoute only decides
                    whether the form may be seen at all. */}
                <Route element={<BootstrapOnlyRoute />}>
                    <Route path="/register" element={<RegisterSuperAdminPage />} />
                </Route>
            </Route>

            <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
            <Route path="/invite/:token" element={<AcceptInvitePage />} />

            <Route element={<RequireAuth />}>
                <Route path="/dashboard" element={<AppLayout />}>
                    <Route index element={<DashboardPage />} />

                    <Route path="my-leave" element={<MyBalancesPage />} />
                    {/* Nested under my-leave, and reached only from that
                        page's "Request Leave" button — there's no sidebar
                        entry for it any more (direct request). Still a real
                        route rather than a modal on My Leave: see
                        ApplyLeavePage.jsx for why the modal/query-param
                        version couldn't work. */}
                    <Route path="my-leave/apply-leave" element={<ApplyLeavePage />} />

                    {/* Everyone can view the holiday calendar; only HR sees the
                        add/delete controls inside the page. */}
                    <Route path="holidays" element={<HolidaysPage />} />
                    {/* Everyone sees their own slip history; only HR sees the
                        upload controls and their team's slips inside the page. */}
                    <Route path="salary-slips" element={<SalarySlipsPage />} />
                    <Route path="profile" element={<ProfilePage />} />
                    <Route path="notifications" element={<NotificationsPage />} />
                    {/* No role gate: serves both an employee viewing their own
                        document and HR reviewing someone else's (query params
                        pick which) — the underlying signed-URL endpoints
                        already enforce self-or-HR-in-subtree server-side. */}
                    <Route path="documents/preview" element={<DocumentViewerPage />} />

                    <Route element={<RequireRole allowedRoles={[ROLES.MANAGER, ROLES.HR_ADMIN, ROLES.SUPER_ADMIN]} />}>
                        <Route path="team" element={<TeamPage />} />
                    </Route>

                    {/* A plain EMPLOYEE who is currently someone's active
                        delegate also needs this page — see RequireRole.jsx. */}
                    <Route
                        element={
                            <RequireRole
                                allowedRoles={[ROLES.MANAGER, ROLES.HR_ADMIN, ROLES.SUPER_ADMIN]}
                                alsoAllowIfActiveDelegate
                            />
                        }
                    >
                        <Route path="approvals" element={<ApprovalsPage />} />
                    </Route>

                    <Route element={<RequireRole allowedRoles={[ROLES.MANAGER]} />}>
                        <Route path="delegations" element={<DelegationsPage />} />
                    </Route>

                    {/* The company-wide roster is SUPER_ADMIN's alone now
                        (direct request) — an HR admin's view of people is
                        their own branch, via My Team. Note "employees/new"
                        is deliberately NOT in here: inviting is still an
                        HR_ADMIN capability, so it keeps the wider gate
                        below. */}
                    <Route element={<RequireRole allowedRoles={[ROLES.SUPER_ADMIN]} />}>
                        <Route path="employees" element={<EmployeesPage />} />
                    </Route>

                    <Route element={<RequireRole allowedRoles={[ROLES.HR_ADMIN, ROLES.SUPER_ADMIN]} />}>
                        <Route path="employees/new" element={<AddEmployeePage />} />
                        {/* Under /team, not /employees — reached from "My
                            Team" and from the "Verified Employees" list on
                            the verification page, not from "All Employees"
                            (which stays read-only, no drill-in). Still its
                            own HR_ADMIN-only RequireRole here, distinct from
                            the MANAGER-or-HR_ADMIN group "team" (no :id)
                            sits in below — a manager may see their team
                            list, but not open this HR-only detail page. */}
                        <Route path="team/:id" element={<EmployeeDetailsPage />} />
                        <Route path="leave-types" element={<LeaveTypesPage />} />
                        <Route path="reports" element={<HrReportsPage />} />
                        <Route path="profile-verification" element={<EmployeeVerificationPage />} />
                        <Route path="profile-verification/:id" element={<EmployeeVerificationDetailPage />} />
                        <Route path="payroll-run" element={<PayrollRunPage />} />
                    </Route>

                    <Route path="403" element={<ForbiddenPage />} />
                    <Route path="*" element={<NotFoundPage />} />
                </Route>
            </Route>
        </Routes>
    );
}

export default App;
