import request from "supertest";
import app from "../../app.js";
import { describe, it, expect } from "vitest";
import { createRootHr, createUser, createHoliday } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";

describe("Holidays", () => {
    it("requires authentication", async () => {
        const response = await request(app).get("/api/holidays");
        expect(response.statusCode).toBe(401);
    });

    it("lets HR create, update and delete a holiday", async () => {
        const hr = await createRootHr({ email: "hr-holidays-crud@example.com" });
        const agent = await loginAs(hr);

        const created = await agent.post("/api/holidays").send({ name: "New Year", startDate: "2027-01-01" });
        expect(created.statusCode).toBe(201);
        expect(created.body.data.holiday.end_date).toBe("2027-01-01");

        const updated = await agent
            .patch(`/api/holidays/${created.body.data.holiday.id}`)
            .send({ name: "New Year's Day", startDate: "2027-01-01" });
        expect(updated.statusCode).toBe(200);
        expect(updated.body.data.holiday.name).toBe("New Year's Day");

        const deleted = await agent.delete(`/api/holidays/${created.body.data.holiday.id}`);
        expect(deleted.statusCode).toBe(200);

        const list = await agent.get("/api/holidays");
        expect(list.body.data.find((h) => h.id === created.body.data.holiday.id)).toBeUndefined();
    });

    it("creates a multi-day holiday spanning a date range", async () => {
        const hr = await createRootHr({ email: "hr-holidays-range@example.com" });
        const agent = await loginAs(hr);

        const created = await agent
            .post("/api/holidays")
            .send({ name: "Diwali", startDate: "2027-10-16", endDate: "2027-10-20" });

        expect(created.statusCode).toBe(201);
        // A write response is now `{ holiday, adjusted }`: a holiday feeds the
        // working-day calculation, so creating one can recount live leave
        // requests, and HR needs to be told how many.
        expect(created.body.data.holiday.start_date).toBe("2027-10-16");
        expect(created.body.data.holiday.end_date).toBe("2027-10-20");
        expect(created.body.data.adjusted).toEqual([]);
    });

    it("rejects writes from a non-HR caller", async () => {
        const employee = await createUser({ role: "EMPLOYEE", email: "emp-holidays-write@example.com" });
        const agent = await loginAs(employee);

        const response = await agent.post("/api/holidays").send({ name: "Fake Holiday", startDate: "2027-05-01" });
        expect(response.statusCode).toBe(403);
    });

    it("rejects a holiday whose range overlaps an existing one", async () => {
        const hr = await createRootHr({ email: "hr-holidays-overlap@example.com" });
        const agent = await loginAs(hr);

        await createHoliday({ name: "Independence Day", startDate: "2027-08-15" });
        const exactDuplicate = await agent
            .post("/api/holidays")
            .send({ name: "Another Name", startDate: "2027-08-15" });
        expect(exactDuplicate.statusCode).toBe(409);

        await createHoliday({ name: "Diwali", startDate: "2027-10-16", endDate: "2027-10-20" });
        const overlappingRange = await agent
            .post("/api/holidays")
            .send({ name: "Overlaps Diwali", startDate: "2027-10-18", endDate: "2027-10-22" });
        expect(overlappingRange.statusCode).toBe(409);
    });

    it("filters by year, including a range that spans a year boundary", async () => {
        const hr = await createRootHr({ email: "hr-holidays-filter@example.com" });
        const agent = await loginAs(hr);

        await createHoliday({ name: "2026 Holiday", startDate: "2026-12-25" });
        await createHoliday({ name: "2027 Holiday", startDate: "2027-12-25" });
        await createHoliday({ name: "Year Boundary", startDate: "2028-12-30", endDate: "2029-01-02" });

        const response2026 = await agent.get("/api/holidays?year=2026");
        expect(response2026.body.data).toHaveLength(1);
        expect(response2026.body.data[0].name).toBe("2026 Holiday");

        const response2028 = await agent.get("/api/holidays?year=2028");
        expect(response2028.body.data.map((h) => h.name)).toContain("Year Boundary");

        const response2029 = await agent.get("/api/holidays?year=2029");
        expect(response2029.body.data.map((h) => h.name)).toContain("Year Boundary");
    });
});
