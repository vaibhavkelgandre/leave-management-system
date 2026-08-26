import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../tests/renderWithProviders.jsx";
import { RegisterSuperAdminPage } from "./RegisterSuperAdminPage.jsx";
import * as authService from "../services/authService.js";

vi.mock("../services/authService.js", async (importOriginal) => ({
    ...(await importOriginal()),
    registerSuperAdmin: vi.fn(),
}));

const VALID = {
    firstName: "Priya",
    lastName: "Sharma",
    email: "priya@example.com",
    password: "password123",
    code: "the-registration-code",
};

async function fillForm(user, overrides = {}) {
    const values = { ...VALID, ...overrides };
    await user.type(screen.getByLabelText("First name"), values.firstName);
    await user.type(screen.getByLabelText("Last name"), values.lastName);
    await user.type(screen.getByLabelText("Work email"), values.email);
    await user.type(screen.getByLabelText("Password"), values.password);
    await user.type(screen.getByLabelText("Confirm password"), values.confirmPassword ?? values.password);
    await user.type(screen.getByLabelText("Registration code"), values.code);
}

describe("RegisterSuperAdminPage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("submits every field the server requires, including the registration code", async () => {
        authService.registerSuperAdmin.mockResolvedValue({ id: "u1", role: "SUPER_ADMIN" });
        const user = userEvent.setup();
        renderWithProviders(<RegisterSuperAdminPage />);

        await fillForm(user);
        await user.click(screen.getByRole("button", { name: /create administrator account/i }));

        await waitFor(() => expect(authService.registerSuperAdmin).toHaveBeenCalledTimes(1));
        expect(authService.registerSuperAdmin).toHaveBeenCalledWith(
            expect.objectContaining({
                firstName: "Priya",
                lastName: "Sharma",
                email: "priya@example.com",
                password: "password123",
                registrationCode: "the-registration-code",
            })
        );
    });

    it("refuses a mismatched confirmation without calling the server", async () => {
        const user = userEvent.setup();
        renderWithProviders(<RegisterSuperAdminPage />);

        await fillForm(user, { confirmPassword: "different123" });
        await user.click(screen.getByRole("button", { name: /create administrator account/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent(/do not match/i);
        expect(authService.registerSuperAdmin).not.toHaveBeenCalled();
    });

    it("refuses a password under 8 characters without calling the server", async () => {
        const user = userEvent.setup();
        renderWithProviders(<RegisterSuperAdminPage />);

        await fillForm(user, { password: "short" });
        await user.click(screen.getByRole("button", { name: /create administrator account/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent(/at least 8 characters/i);
        expect(authService.registerSuperAdmin).not.toHaveBeenCalled();
    });

    it("shows the server's own message when the registration code is wrong", async () => {
        authService.registerSuperAdmin.mockRejectedValue(new Error("Invalid registration code"));
        const user = userEvent.setup();
        renderWithProviders(<RegisterSuperAdminPage />);

        await fillForm(user);
        await user.click(screen.getByRole("button", { name: /create administrator account/i }));

        // The code is the only gate on this endpoint, so a wrong one has to be
        // reported plainly rather than as a generic failure.
        expect(await screen.findByRole("alert")).toHaveTextContent(/invalid registration code/i);
    });

    it("reports the 409 when someone else has already set the deployment up", async () => {
        authService.registerSuperAdmin.mockRejectedValue(new Error("A super admin account already exists"));
        const user = userEvent.setup();
        renderWithProviders(<RegisterSuperAdminPage />);

        await fillForm(user);
        await user.click(screen.getByRole("button", { name: /create administrator account/i }));

        // Two people opening this page at once is the realistic race, and the
        // loser needs to know to sign in rather than retry.
        expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
        expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument();
    });

    it("says where the registration code comes from, since there is nowhere else to look", async () => {
        renderWithProviders(<RegisterSuperAdminPage />);

        expect(screen.getByText(/HR_REGISTRATION_CODE/)).toBeInTheDocument();
    });
});
