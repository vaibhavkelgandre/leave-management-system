import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "../../tests/renderWithProviders.jsx";
import { BootstrapOnlyRoute } from "./BootstrapOnlyRoute.jsx";
import * as authService from "../../services/authService.js";

vi.mock("../../services/authService.js", async (importOriginal) => ({
    ...(await importOriginal()),
    needsBootstrap: vi.fn(),
}));

function renderAt(path) {
    return renderWithProviders(
        <Routes>
            <Route element={<BootstrapOnlyRoute />}>
                <Route path="/register" element={<p>setup form</p>} />
            </Route>
            <Route path="/login" element={<p>sign in page</p>} />
        </Routes>,
        { route: path }
    );
}

describe("BootstrapOnlyRoute", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("renders the setup form while no super admin exists", async () => {
        authService.needsBootstrap.mockResolvedValue(true);

        renderAt("/register");

        expect(await screen.findByText("setup form")).toBeInTheDocument();
    });

    it("redirects to sign in once a super admin exists", async () => {
        authService.needsBootstrap.mockResolvedValue(false);

        renderAt("/register");

        // The page must not be bookmarkable or linkable after setup — the
        // server would answer 409 anyway, so showing the form is a dead end.
        expect(await screen.findByText("sign in page")).toBeInTheDocument();
        expect(screen.queryByText("setup form")).not.toBeInTheDocument();
    });

    it("shows neither until the answer arrives", async () => {
        // Never resolves, so this is the in-flight state.
        authService.needsBootstrap.mockReturnValue(new Promise(() => {}));

        renderAt("/register");

        // Rendering the form speculatively would flash a registration page at
        // every visitor of an already-configured deployment.
        expect(screen.queryByText("setup form")).not.toBeInTheDocument();
        expect(screen.queryByText("sign in page")).not.toBeInTheDocument();
    });
});
