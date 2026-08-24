import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../tests/renderWithProviders.jsx";
import { HolidayForm } from "./HolidayForm.jsx";
import * as holidayService from "../../services/holidayService.js";

vi.mock("../../services/holidayService.js");

const diwali = { id: "h1", name: "Diwali", start_date: "2027-10-16", end_date: "2027-10-20" };
const newYear = { id: "h2", name: "New Year", start_date: "2027-01-01", end_date: "2027-01-01" };

describe("HolidayForm", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("creates a single-day holiday when the end date is left blank", async () => {
        holidayService.createHoliday.mockResolvedValue({});
        const onSaved = vi.fn();
        renderWithProviders(<HolidayForm onSaved={onSaved} />);

        await userEvent.type(screen.getByLabelText(/name/i), "Republic Day");
        await userEvent.type(screen.getByLabelText(/start date/i), "2027-01-26");
        await userEvent.click(screen.getByRole("button", { name: /add holiday/i }));

        expect(holidayService.createHoliday).toHaveBeenCalledWith({
            name: "Republic Day",
            startDate: "2027-01-26",
            endDate: "",
        });
        // The second argument is the list of live leave requests the holiday
        // recounted — a holiday feeds the working-day calculation, so saving one
        // can move balances, and the page needs to say so.
        expect(onSaved).toHaveBeenCalledWith("2027-01-26", []);
    });

    it("creates a multi-day holiday and previews how many days it covers", async () => {
        holidayService.createHoliday.mockResolvedValue({});
        renderWithProviders(<HolidayForm onSaved={vi.fn()} />);

        await userEvent.type(screen.getByLabelText(/name/i), "Diwali");
        await userEvent.type(screen.getByLabelText(/start date/i), "2027-10-16");
        await userEvent.type(screen.getByLabelText(/end date/i), "2027-10-20");

        expect(screen.getByText(/cover 5 days/i)).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: /add holiday/i }));
        expect(holidayService.createHoliday).toHaveBeenCalledWith({
            name: "Diwali",
            startDate: "2027-10-16",
            endDate: "2027-10-20",
        });
    });

    it("prefills an existing holiday's range and updates it", async () => {
        holidayService.updateHoliday.mockResolvedValue({});
        renderWithProviders(<HolidayForm holiday={diwali} onSaved={vi.fn()} />);

        expect(screen.getByLabelText(/name/i)).toHaveValue("Diwali");
        expect(screen.getByLabelText(/start date/i)).toHaveValue("2027-10-16");
        expect(screen.getByLabelText(/end date/i)).toHaveValue("2027-10-20");

        await userEvent.clear(screen.getByLabelText(/end date/i));
        await userEvent.type(screen.getByLabelText(/end date/i), "2027-10-19");
        await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

        expect(holidayService.updateHoliday).toHaveBeenCalledWith("h1", {
            name: "Diwali",
            startDate: "2027-10-16",
            endDate: "2027-10-19",
        });
    });

    it("shows a blank end date when editing a single-day holiday", () => {
        renderWithProviders(<HolidayForm holiday={newYear} onSaved={vi.fn()} />);
        expect(screen.getByLabelText(/end date/i)).toHaveValue("");
    });

    it("never submits an end date that falls before the start date", async () => {
        renderWithProviders(<HolidayForm onSaved={vi.fn()} />);

        await userEvent.type(screen.getByLabelText(/name/i), "Backwards");
        await userEvent.type(screen.getByLabelText(/start date/i), "2027-10-20");
        await userEvent.type(screen.getByLabelText(/end date/i), "2027-10-16");

        // The End date input carries min={startDate}, so the browser's own
        // constraint validation rejects the range before submit even fires.
        expect(screen.getByLabelText(/end date/i)).toHaveAttribute("min", "2027-10-20");

        await userEvent.click(screen.getByRole("button", { name: /add holiday/i }));
        expect(holidayService.createHoliday).not.toHaveBeenCalled();
    });

    it("explains a backwards range if native validation is bypassed", async () => {
        renderWithProviders(<HolidayForm onSaved={vi.fn()} />);

        await userEvent.type(screen.getByLabelText(/name/i), "Backwards");
        await userEvent.type(screen.getByLabelText(/start date/i), "2027-10-20");
        await userEvent.type(screen.getByLabelText(/end date/i), "2027-10-16");

        // Submitting the form directly skips constraint validation, which is
        // what the in-handler check exists to catch.
        fireEvent.submit(screen.getByRole("button", { name: /add holiday/i }).closest("form"));

        expect(await screen.findByRole("alert")).toHaveTextContent("End date can't be before the start date");
        expect(holidayService.createHoliday).not.toHaveBeenCalled();
    });

    it("surfaces the server's message when the range overlaps another holiday", async () => {
        holidayService.createHoliday.mockRejectedValue({
            response: { data: { message: "A holiday already covers one or more of these dates" } },
        });
        renderWithProviders(<HolidayForm onSaved={vi.fn()} />);

        await userEvent.type(screen.getByLabelText(/name/i), "Clash");
        await userEvent.type(screen.getByLabelText(/start date/i), "2027-10-18");
        await userEvent.click(screen.getByRole("button", { name: /add holiday/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent("already covers one or more of these dates");
    });
});
