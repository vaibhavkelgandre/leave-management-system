import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, makeAuthValue } from "../tests/renderWithProviders.jsx";
import { TeamPage } from "./TeamPage.jsx";
import * as userService from "../services/userService.js";
import { makeUser } from "../tests/fixtures/users.js";
import { ROLES } from "../constants/roles.js";

vi.mock("../services/userService.js");

const managerAuthValue = makeAuthValue({ user: { id: "mgr-1", first_name: "Manoj", role: ROLES.MANAGER } });
const hrAuthValue = makeAuthValue({ user: { id: "hr-viewer", first_name: "Priya", role: ROLES.HR_ADMIN } });

describe("TeamPage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("splits direct reports from the extended team", async () => {
        const asha = makeUser({ id: "emp-1", first_name: "Asha", manager_id: "mgr-1" });
        const kiran = makeUser({ id: "emp-2", first_name: "Kiran", manager_id: "mgr-1" });
        const rina = makeUser({ id: "emp-3", first_name: "Rina", manager_id: "emp-1" });
        userService.getMyTeam.mockResolvedValue([asha, kiran, rina]);

        renderWithProviders(<TeamPage />, { authValue: managerAuthValue });

        const directSection = (await screen.findByText("Direct reports")).closest("section");
        expect(within(directSection).getByText(/Asha/)).toBeInTheDocument();
        expect(within(directSection).getByText(/Kiran/)).toBeInTheDocument();
        expect(within(directSection).queryByText(/Rina/)).not.toBeInTheDocument();

        const extendedSection = screen.getByText("Extended team").closest("section");
        expect(within(extendedSection).getByText(/Rina/)).toBeInTheDocument();
        // Asha appears in the extended section too — as the *heading* of the
        // group of people who report to her, not as a table row.
        expect(within(extendedSection).getByRole("heading", { name: /Asha User/ })).toBeInTheDocument();
    });

    // Replaces the old flat extended-team table with a "Reports To" column:
    // one small table per manager, with the manager named above it, which
    // frees that column's width for the fields people actually read.
    it("groups the extended team under each manager, with no Reports To column", async () => {
        const asha = makeUser({ id: "emp-1", first_name: "Asha", role: ROLES.MANAGER, manager_id: "mgr-1" });
        const bala = makeUser({ id: "emp-2", first_name: "Bala", role: ROLES.MANAGER, manager_id: "mgr-1" });
        const rina = makeUser({ id: "emp-3", first_name: "Rina", manager_id: "emp-1" });
        const sam = makeUser({ id: "emp-4", first_name: "Sam", manager_id: "emp-2" });
        userService.getMyTeam.mockResolvedValue([asha, bala, rina, sam]);

        renderWithProviders(<TeamPage />, { authValue: managerAuthValue });

        const extendedSection = (await screen.findByText("Extended team")).closest("section");
        // One group per manager, each naming the manager and their headcount.
        const ashaGroup = within(extendedSection).getByRole("heading", { name: /Asha User/ }).closest("section");
        const balaGroup = within(extendedSection).getByRole("heading", { name: /Bala User/ }).closest("section");
        expect(within(ashaGroup).getByText("Rina User")).toBeInTheDocument();
        expect(within(ashaGroup).queryByText("Sam User")).not.toBeInTheDocument();
        expect(within(balaGroup).getByText("Sam User")).toBeInTheDocument();
        expect(within(ashaGroup).getByText("1 report")).toBeInTheDocument();

        // The column those headings replace is gone from the grouped tables.
        expect(within(ashaGroup).queryByRole("columnheader", { name: /reports to/i })).not.toBeInTheDocument();
    });

    // Only reachable with inconsistent data, but it must not silently drop
    // people — and with no manager heading to carry it, the column comes back.
    it("keeps an unresolvable-manager report visible, with the Reports To column", async () => {
        const orphan = makeUser({ id: "emp-9", first_name: "Nina", manager_id: "someone-not-in-this-team" });
        userService.getMyTeam.mockResolvedValue([orphan]);

        renderWithProviders(<TeamPage />, { authValue: managerAuthValue });

        const group = (await screen.findByText("Elsewhere in your reporting line")).closest("section");
        expect(within(group).getByText("Nina User")).toBeInTheDocument();
        expect(within(group).getByRole("columnheader", { name: /reports to/i })).toBeInTheDocument();
    });

    it("tags each report with their profile verification status, so HR can tell who's verified at a glance", async () => {
        const verified = makeUser({ id: "emp-1", first_name: "Asha", manager_id: "mgr-1", profile_status: "VERIFIED" });
        const incomplete = makeUser({
            id: "emp-2",
            first_name: "Kiran",
            manager_id: "mgr-1",
            profile_status: "INCOMPLETE",
        });
        userService.getMyTeam.mockResolvedValue([verified, incomplete]);

        renderWithProviders(<TeamPage />, { authValue: managerAuthValue });

        const ashaRow = (await screen.findByText("Asha User")).closest("tr");
        const kiranRow = (await screen.findByText("Kiran User")).closest("tr");
        expect(within(ashaRow).getByText("VERIFIED")).toBeInTheDocument();
        expect(within(kiranRow).getByText("INCOMPLETE")).toBeInTheDocument();
    });

    it("shows an empty state for a user with no reports", async () => {
        userService.getMyTeam.mockResolvedValue([]);
        renderWithProviders(<TeamPage />, { authValue: managerAuthValue });

        expect(await screen.findByText("You have no direct reports yet.")).toBeInTheDocument();
    });

    it("shows an error state when the request fails", async () => {
        userService.getMyTeam.mockRejectedValue(new Error("network error"));
        renderWithProviders(<TeamPage />, { authValue: managerAuthValue });

        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load your team");
    });

    // HR-tier viewer, because that's who these two endpoints are gated to
    // server-side — see the MANAGER case below.
    it("lets HR change a report's manager", async () => {
        const employee = makeUser({ id: "emp-1", first_name: "Asha", manager_id: "hr-viewer", invited_by: "hr-viewer" });
        const otherManager = makeUser({ id: "mgr-2", first_name: "Rohit", role: ROLES.MANAGER });
        userService.getMyTeam.mockResolvedValue([employee, otherManager]);
        userService.updateManager.mockResolvedValue({ ...employee, manager_id: "mgr-2" });

        renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
        const ashaRow = within((await screen.findByText("Asha User")).closest("tr"));

        await userEvent.click(ashaRow.getByRole("button", { name: "Change manager" }));
        await userEvent.selectOptions(screen.getByLabelText(/manager for asha/i), "mgr-2");
        // Save/Cancel live in the edit row *below* the person's row now, not
        // inside it — hence `screen`, not `ashaRow`.
        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(userService.updateManager).toHaveBeenCalledWith("emp-1", "mgr-2");
    });

    // The form used to sit inside the Employee cell, where ManagerSelect's
    // full-width <select> plus helper text stretched that column and visibly
    // re-laid-out the whole table on open. A colSpan row can't do that.
    it("opens the manager form in its own full-width row, not inside a column", async () => {
        const employee = makeUser({ id: "emp-1", first_name: "Asha", manager_id: "hr-viewer", invited_by: "hr-viewer" });
        const otherManager = makeUser({ id: "mgr-2", first_name: "Rohit", role: ROLES.MANAGER });
        userService.getMyTeam.mockResolvedValue([employee, otherManager]);

        renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
        const personRow = (await screen.findByText("Asha User")).closest("tr");

        await userEvent.click(within(personRow).getByRole("button", { name: "Change manager" }));

        const select = screen.getByLabelText(/manager for asha/i);
        // In a different row from the person's, and that row spans the table.
        expect(personRow.contains(select)).toBe(false);
        const editCell = select.closest("td");
        expect(Number(editCell.getAttribute("colspan"))).toBeGreaterThan(1);

        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByLabelText(/manager for asha/i)).not.toBeInTheDocument();
    });

    it("lets HR deactivate a report", async () => {
        const employee = makeUser({
            id: "emp-1",
            first_name: "Kiran",
            status: "ACTIVE",
            manager_id: "hr-viewer",
            invited_by: "hr-viewer",
        });
        userService.getMyTeam.mockResolvedValue([employee]);
        userService.updateStatus.mockResolvedValue({ ...employee, status: "INACTIVE" });

        renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
        await screen.findByText("Kiran User");

        const deactivateButton = screen.getByRole("button", { name: /deactivate/i });
        expect(deactivateButton).toBeEnabled();

        await userEvent.click(deactivateButton);
        expect(userService.updateStatus).toHaveBeenCalledWith("emp-1", "INACTIVE");
    });

    // All Employees (where "Add Employee" used to live) is SUPER_ADMIN-only
    // now, so this is HR's only way into the invite form.
    it("offers HR an Add Employee action, and never offers it to a plain MANAGER", async () => {
        userService.getMyTeam.mockResolvedValue([]);

        const { unmount } = renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
        expect(await screen.findByRole("link", { name: /add employee/i })).toHaveAttribute(
            "href",
            "/dashboard/employees/new"
        );
        unmount();

        renderWithProviders(<TeamPage />, {
            authValue: makeAuthValue({ user: { id: "mgr-viewer", first_name: "Meera", role: ROLES.MANAGER } }),
        });
        expect(screen.queryByRole("link", { name: /add employee/i })).not.toBeInTheDocument();
    });

    describe("HR reporting-line edit restriction", () => {
        // Widened on direct request: an HR admin manages everyone on their
        // own team, not only the accounts they personally invited. Creator-only
        // meant no controls at all for anyone HR inherited rather than created,
        // which read as a missing feature. Everyone this page lists is inside
        // the viewer's own subtree by construction, and the server re-checks
        // that scope per request.
        it("shows the edit control for someone on the viewer's team that a colleague created", async () => {
            const otherCreator = makeUser({ id: "hr-other", first_name: "Rahul", role: ROLES.HR_ADMIN });
            const employee = makeUser({
                id: "emp-1",
                first_name: "Zara",
                manager_id: "hr-other",
                invited_by: "hr-other",
            });
            userService.getMyTeam.mockResolvedValue([otherCreator, employee]);

            renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
            const zaraRow = within((await screen.findByText("Zara User")).closest("tr"));

            expect(zaraRow.getByRole("button", { name: "Change manager" })).toBeInTheDocument();
        });

        // Both endpoints behind these controls are HR-tier server-side, so a
        // MANAGER is offered neither — including on a row whose `invited_by`
        // is the manager themself, a state only reachable synthetically (only
        // HR can invite) but worth pinning: the client must not offer a
        // control the server would 403.
        it("offers a plain MANAGER neither control, even on an account attributed to them", async () => {
            const inherited = makeUser({
                id: "emp-1",
                first_name: "Zara",
                manager_id: "mgr-viewer",
                invited_by: "hr-other",
            });
            const attributed = makeUser({
                id: "emp-2",
                first_name: "Yusuf",
                manager_id: "mgr-viewer",
                invited_by: "mgr-viewer",
            });
            userService.getMyTeam.mockResolvedValue([inherited, attributed]);

            renderWithProviders(<TeamPage />, {
                authValue: makeAuthValue({ user: { id: "mgr-viewer", first_name: "Meera", role: ROLES.MANAGER } }),
            });
            await screen.findByText("Zara User");

            for (const name of ["Zara User", "Yusuf User"]) {
                const row = within(screen.getByText(name).closest("tr"));
                expect(row.queryByRole("button", { name: "Change manager" })).not.toBeInTheDocument();
                expect(row.queryByRole("button", { name: /deactivate|activate/i })).not.toBeInTheDocument();
            }
        });

        it("lets the HR admin who created another HR admin change who they report to", async () => {
            const createdHr = makeUser({
                id: "hr-created",
                first_name: "Amit",
                role: ROLES.HR_ADMIN,
                manager_id: "hr-viewer",
                invited_by: "hr-viewer",
            });
            userService.getMyTeam.mockResolvedValue([createdHr]);

            renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
            const amitRow = within((await screen.findByText("Amit User")).closest("tr"));

            expect(amitRow.getByRole("button", { name: "Change manager" })).toBeInTheDocument();
        });

        // A downstream HR admin is on this viewer's team too, so the same
        // widening applies — what still can't be reached is a *different*
        // branch, which never appears on this page at all (getMyTeam only ever
        // returns the viewer's own subtree).
        it("shows the edit control for a downstream HR admin created by someone else", async () => {
            const otherCreator = makeUser({ id: "hr-other", first_name: "Rahul", role: ROLES.HR_ADMIN });
            const createdByOther = makeUser({
                id: "hr-created",
                first_name: "Amit",
                role: ROLES.HR_ADMIN,
                manager_id: "hr-other",
                invited_by: "hr-other",
            });
            userService.getMyTeam.mockResolvedValue([otherCreator, createdByOther]);

            renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
            const amitRow = within((await screen.findByText("Amit User")).closest("tr"));

            expect(amitRow.getByRole("button", { name: "Change manager" })).toBeInTheDocument();
        });

        // An account with no invitation record at all (registered directly, or
        // predating the invitation table) used to be uneditable by anyone —
        // now it's editable by the HR admin whose team it's on, which is the
        // main case the widening exists for.
        it("shows the edit control for an account with no recorded creator on the viewer's team", async () => {
            const orphan = makeUser({ id: "hr-root", first_name: "Amit", role: ROLES.HR_ADMIN, manager_id: "hr-viewer" });
            userService.getMyTeam.mockResolvedValue([orphan]);

            renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
            const amitRow = within((await screen.findByText("Amit User")).closest("tr"));

            expect(amitRow.getByRole("button", { name: "Change manager" })).toBeInTheDocument();
        });
    });

    // The Phone column is dropped on this page only (EmployeesPage keeps it) —
    // these tables carry an Actions column and a second Status badge on top of
    // everything All Employees shows, which was enough to need a horizontal
    // scrollbar to reach the action icons at all.
    it("drops the Phone column, so the action icons stay reachable without scrolling sideways", async () => {
        const employee = makeUser({ id: "emp-1", first_name: "Zara", manager_id: "hr-viewer", phone: "+91 90000 00001" });
        userService.getMyTeam.mockResolvedValue([employee]);

        renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
        await screen.findByText("Zara User");

        expect(screen.queryByRole("columnheader", { name: /phone/i })).not.toBeInTheDocument();
        expect(screen.queryByText("+91 90000 00001")).not.toBeInTheDocument();
        // The columns that stayed.
        expect(screen.getByRole("columnheader", { name: /email/i })).toBeInTheDocument();
    });

    describe("activate/deactivate restriction", () => {
        it("shows the activate/deactivate control for an employee the viewer created", async () => {
            const employee = makeUser({ id: "emp-1", first_name: "Zara", manager_id: "hr-viewer", invited_by: "hr-viewer" });
            userService.getMyTeam.mockResolvedValue([employee]);

            renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
            const zaraRow = within((await screen.findByText("Zara User")).closest("tr"));

            expect(zaraRow.getByRole("button", { name: /deactivate/i })).toBeInTheDocument();
        });

        it("shows the activate/deactivate control for someone on the team a colleague created", async () => {
            const otherCreator = makeUser({ id: "hr-other", first_name: "Rahul", role: ROLES.HR_ADMIN });
            const employee = makeUser({ id: "emp-1", first_name: "Zara", manager_id: "hr-other", invited_by: "hr-other" });
            userService.getMyTeam.mockResolvedValue([otherCreator, employee]);

            renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
            const zaraRow = within((await screen.findByText("Zara User")).closest("tr"));

            expect(zaraRow.getByRole("button", { name: /deactivate/i })).toBeInTheDocument();
        });

        it("shows the activate/deactivate control for an account with no recorded creator on the viewer's team", async () => {
            const orphan = makeUser({ id: "emp-1", first_name: "Zara", manager_id: "hr-viewer" });
            userService.getMyTeam.mockResolvedValue([orphan]);

            renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
            const zaraRow = within((await screen.findByText("Zara User")).closest("tr"));

            expect(zaraRow.getByRole("button", { name: /deactivate/i })).toBeInTheDocument();
        });

        // An invited account isn't deactivatable — `updateStatus` moves a row
        // between ACTIVE and INACTIVE and INVITED is neither — but the control
        // still renders, disabled, rather than being left out: omitting it made
        // the row's remaining icons slide into the empty slot, so the controls
        // appeared in different places from one row to the next.
        //
        // The count below is the number of *fixed slots*, not of live actions:
        // change-manager, change-role and status, in that order, every row.
        // It went from two to three when PATCH /users/:id/role was added — the
        // invariant being pinned is that it is the same on every row, so
        // update the number when a slot is added rather than dropping the
        // assertion.
        it("renders the deactivate control disabled on an invited row, keeping the icon columns aligned", async () => {
            const invited = makeUser({ id: "emp-1", first_name: "Zara", manager_id: "hr-viewer", status: "INVITED" });
            const active = makeUser({ id: "emp-2", first_name: "Yusuf", manager_id: "hr-viewer" });
            userService.getMyTeam.mockResolvedValue([invited, active]);

            renderWithProviders(<TeamPage />, { authValue: hrAuthValue });
            const invitedRow = within((await screen.findByText("Zara User")).closest("tr"));
            const activeRow = within(screen.getByText("Yusuf User").closest("tr"));

            const invitedToggle = invitedRow.getByRole("button", { name: /deactivate/i });
            expect(invitedToggle).toBeDisabled();
            expect(invitedToggle).toHaveAccessibleName(/available once Zara accepts the invite/i);
            // Same controls, same order, on a row where they are live.
            expect(activeRow.getByRole("button", { name: /^deactivate$/i })).toBeEnabled();
            for (const row of [invitedRow, activeRow]) {
                expect(row.getAllByRole("button")).toHaveLength(3);
            }
        });
    });
});
