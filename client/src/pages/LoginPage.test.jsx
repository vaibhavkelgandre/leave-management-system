import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../tests/renderWithProviders.jsx";
import { LoginPage } from "./LoginPage.jsx";
import * as authService from "../services/authService.js";

vi.mock("../services/authService.js", async (importOriginal) => ({
    ...(await importOriginal()),
    needsBootstrap: vi.fn(),
}));

// Stubbed because it renders Google's <GoogleLogin>, which throws outside a
// GoogleOAuthProvider. These tests are about the bootstrap panel this page
// adds, not the form -- LoginForm has its own coverage.
vi.mock("../components/auth/LoginForm.jsx", () => ({
    LoginForm: () => <form aria-label="Sign in form" />,
}));

describe("LoginPage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("shows only the sign-in form on a configured deployment", async () => {
        authService.needsBootstrap.mockResolvedValue(false);

        renderWithProviders(<LoginPage />);

        expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
        // Nothing should appear later either — waiting rules out a late flash.
        await waitFor(() => expect(authService.needsBootstrap).toHaveBeenCalled());
        expect(screen.queryByText(/no administrator account yet/i)).not.toBeInTheDocument();
    });

    it("offers the setup route when the deployment has no super admin", async () => {
        authService.needsBootstrap.mockResolvedValue(true);

        renderWithProviders(<LoginPage />);

        // Without this, a fresh deployment's first visitor faces a form no
        // credential can satisfy, and the only way forward is the README.
        expect(await screen.findByText(/no administrator account yet/i)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /register as super admin/i })).toHaveAttribute("href", "/register");
    });

    it("keeps the sign-in form visible alongside the panel", async () => {
        authService.needsBootstrap.mockResolvedValue(true);

        renderWithProviders(<LoginPage />);

        // Deliberately a panel rather than a redirect: someone who mistyped a
        // URL, or who is checking whether their own account exists yet, should
        // still land somewhere recognisable.
        await screen.findByText(/no administrator account yet/i);
        expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    });

    it("falls back to the ordinary login page when the status call fails", async () => {
        // The service swallows errors and answers false, so a network blip or
        // an unmigrated database must never show a stranger a setup prompt.
        authService.needsBootstrap.mockResolvedValue(false);

        renderWithProviders(<LoginPage />);

        await waitFor(() => expect(authService.needsBootstrap).toHaveBeenCalled());
        expect(screen.queryByText(/no administrator account yet/i)).not.toBeInTheDocument();
    });
});
