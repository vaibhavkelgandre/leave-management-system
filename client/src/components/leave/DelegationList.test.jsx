import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../tests/renderWithProviders.jsx";
import { DelegationList } from "./DelegationList.jsx";
import { todayDateKey } from "../../utils/dates.js";

// Dates are relative to the real "today" on purpose here: the whole rule under
// test is "has this window ended yet", so a fixed 2027 fixture would stop
// exercising it the moment that year arrives. Nothing here goes through a
// working-day calculation, so the weekend trap that fixed dates exist to avoid
// elsewhere does not apply.
function dateOffsetFromToday(days) {
    const date = new Date(`${todayDateKey()}T00:00:00`);
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
}

function makeDelegation(overrides) {
    return {
        id: "deleg-1",
        delegate_first_name: "Rohit",
        delegate_last_name: "Peer",
        start_date: dateOffsetFromToday(5),
        end_date: dateOffsetFromToday(10),
        ...overrides,
    };
}

describe("DelegationList", () => {
    it("offers an edit action for a window that has not ended yet", async () => {
        const onEdit = vi.fn();
        const delegation = makeDelegation();
        renderWithProviders(<DelegationList delegations={[delegation]} onEdit={onEdit} />);

        await userEvent.click(screen.getByRole("button", { name: /edit delegation for rohit peer/i }));

        expect(onEdit).toHaveBeenCalledWith(delegation);
    });

    it("still offers it while the window is in progress", () => {
        renderWithProviders(
            <DelegationList
                delegations={[
                    makeDelegation({ start_date: dateOffsetFromToday(-2), end_date: dateOffsetFromToday(3) }),
                ]}
                onEdit={vi.fn()}
            />
        );

        expect(screen.getByRole("button", { name: /edit delegation for rohit peer/i })).toBeInTheDocument();
    });

    // The server refuses an edit to a delegation whose window has already
    // ended, so rendering the button would only produce a 409 — a control that
    // can only fail reads as broken rather than as a deliberate rule.
    it("hides the edit action once the window has ended", () => {
        renderWithProviders(
            <DelegationList
                delegations={[
                    makeDelegation({ start_date: dateOffsetFromToday(-10), end_date: dateOffsetFromToday(-1) }),
                ]}
                onEdit={vi.fn()}
            />
        );

        expect(screen.getByText(/rohit peer/i)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /edit delegation/i })).not.toBeInTheDocument();
    });

    // The manager's half of the "delegate booked leave over an upcoming window"
    // rule: allowed by design, notified once, and otherwise invisible on the
    // page the manager actually returns to.
    describe("when the delegate has booked leave inside the window", () => {
        const withConflict = (overrides) =>
            makeDelegation({
                conflict_leave_start_date: dateOffsetFromToday(6),
                conflict_leave_end_date: dateOffsetFromToday(7),
                conflict_leave_status: "SUBMITTED",
                ...overrides,
            });

        it("warns on the row, naming the colliding dates", () => {
            renderWithProviders(<DelegationList delegations={[withConflict()]} onEdit={vi.fn()} />);

            const notice = screen.getByRole("status");
            expect(notice).toHaveTextContent(/rohit peer has requested leave/i);
            expect(notice).toHaveTextContent(/overlaps this cover/i);
        });

        // The wording differs because the manager's next step does: an approved
        // absence is settled, a pending one is usually still their own decision.
        it("says 'approved leave' for an approved absence", () => {
            renderWithProviders(
                <DelegationList
                    delegations={[withConflict({ conflict_leave_status: "APPROVED" })]}
                    onEdit={vi.fn()}
                />
            );

            expect(screen.getByRole("status")).toHaveTextContent(/has approved leave/i);
        });

        // The warning's only suggested action is to reassign, so it must appear
        // beside a working edit control.
        it("keeps the edit action available alongside the warning", async () => {
            const onEdit = vi.fn();
            renderWithProviders(<DelegationList delegations={[withConflict()]} onEdit={onEdit} />);

            await userEvent.click(screen.getByRole("button", { name: /edit delegation for rohit peer/i }));

            expect(onEdit).toHaveBeenCalled();
        });

        // An ended window's clash is history and the server refuses the edit, so
        // a warning there would be the dead end this feature exists to remove.
        it("stays silent once the window has ended", () => {
            renderWithProviders(
                <DelegationList
                    delegations={[
                        withConflict({
                            start_date: dateOffsetFromToday(-10),
                            end_date: dateOffsetFromToday(-1),
                        }),
                    ]}
                    onEdit={vi.fn()}
                />
            );

            expect(screen.queryByRole("status")).not.toBeInTheDocument();
        });

        it("shows no warning for a delegation with no clash", () => {
            renderWithProviders(<DelegationList delegations={[makeDelegation()]} onEdit={vi.fn()} />);

            expect(screen.queryByRole("status")).not.toBeInTheDocument();
        });
    });

    it("renders read-only when no onEdit handler is given", () => {
        renderWithProviders(<DelegationList delegations={[makeDelegation()]} />);

        expect(screen.queryByRole("button", { name: /edit delegation/i })).not.toBeInTheDocument();
    });
});
