// The guard that decides whether the integration suite is allowed to run at
// all. Worth real tests rather than trust: it is the only thing standing
// between a stray environment variable and `TRUNCATE ... CASCADE` against a
// database somebody cares about, and the version that lived inline in
// setup.js had a hole in it for exactly as long as nobody could test it.
import { describe, it, expect } from "vitest";
import { assertTestDatabase } from "../integration/helpers/testDatabaseGuard.js";

const validEnv = { NODE_ENV: "test", DB_NAME: "leave_management_system_test" };

describe("assertTestDatabase", () => {
    it("allows a test database configured with the discrete DB_* vars", () => {
        expect(() => assertTestDatabase({ ...validEnv })).not.toThrow();
    });

    it("refuses when NODE_ENV isn't test", () => {
        expect(() => assertTestDatabase({ ...validEnv, NODE_ENV: "development" })).toThrow(/NODE_ENV must be 'test'/);
    });

    it("refuses when DB_NAME doesn't end in _test", () => {
        expect(() => assertTestDatabase({ ...validEnv, DB_NAME: "leave_management_system" })).toThrow(
            /DB_NAME must end with '_test'/
        );
    });

    it("refuses when DB_NAME is missing entirely", () => {
        expect(() => assertTestDatabase({ NODE_ENV: "test" })).toThrow(/DB_NAME must end with '_test'/);
    });

    // The hole this guard was rewritten to close. config/db.js prefers
    // DATABASE_URL over DB_NAME, so the old check passed on DB_NAME from
    // .env.test while the pool connected wherever DATABASE_URL pointed.
    it("refuses a DATABASE_URL pointing at a database that isn't a _test one, even when DB_NAME looks fine", () => {
        expect(() =>
            assertTestDatabase({
                ...validEnv,
                DATABASE_URL: "postgres://user:secret@db.example.com:5432/production_db?sslmode=require",
            })
        ).toThrow(/points at database 'production_db'/);
    });

    it("never puts the connection string in the error, since it carries a password", () => {
        let message = "";
        try {
            assertTestDatabase({
                ...validEnv,
                DATABASE_URL: "postgres://user:hunter2@db.example.com:5432/production_db",
            });
        } catch (error) {
            message = error.message;
        }

        expect(message).toContain("production_db");
        expect(message).not.toContain("hunter2");
        expect(message).not.toContain("db.example.com");
    });

    it("allows a DATABASE_URL that does point at a _test database", () => {
        expect(() =>
            assertTestDatabase({
                ...validEnv,
                DATABASE_URL: "postgres://user:secret@localhost:5432/leave_management_system_test",
            })
        ).not.toThrow();
    });

    it("treats a blank DATABASE_URL as unset, which is what .env.test relies on", () => {
        expect(() => assertTestDatabase({ ...validEnv, DATABASE_URL: "" })).not.toThrow();
    });

    it("refuses a DATABASE_URL it cannot parse, rather than assuming it's safe", () => {
        expect(() => assertTestDatabase({ ...validEnv, DATABASE_URL: "not-a-url" })).toThrow(
            /could not be read/
        );
    });

    it("refuses a DATABASE_URL that names no database at all", () => {
        expect(() => assertTestDatabase({ ...validEnv, DATABASE_URL: "postgres://user:secret@localhost:5432/" })).toThrow(
            /could not be read/
        );
    });
});
