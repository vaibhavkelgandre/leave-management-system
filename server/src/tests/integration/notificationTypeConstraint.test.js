// Guards the one seam where the notification catalogue can silently lose a type.
//
// `notifications.type` is constrained by a CHECK list, and every migration that
// adds a type re-declares that whole list (`DROP CONSTRAINT` then `ADD`) rather
// than extending it — there is no `ADD VALUE` for a CHECK. So a new migration
// has to copy the *newest* list, and copying an older one silently deletes every
// type added in between. That is not hypothetical: 044 was written from 041's
// list and dropped `LEAVE_DAYS_ADJUSTED`, which 042 had added.
//
// The failure is invisible in normal use, which is why it needs a test rather
// than care. Every `notify*` helper catches and logs its own error and never
// rethrows — deliberately, since a notification must not fail the real action —
// so a type the constraint no longer accepts just stops producing notifications.
// The action succeeds, the response is 200, and nobody finds out.
//
// This asserts the two sides agree: every type string `notificationService.js`
// can emit is a type the live database will accept.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pool from "../../config/db.js";
import { createUser } from "./helpers/factories.js";

const SERVICE_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "services",
    "notificationService.js"
);

// Read the types out of the source rather than maintaining a second list here —
// a hand-kept copy is one more thing that can fall behind, which is the exact
// bug being guarded against. Matches the `type: "X"` property every
// insertNotification call passes.
function notificationTypesUsedInCode() {
    const source = fs.readFileSync(SERVICE_PATH, "utf8");
    const matches = source.matchAll(/\btype:\s*"([A-Z_]+)"/g);
    return [...new Set([...matches].map((match) => match[1]))].sort();
}

describe("notifications type CHECK constraint", () => {
    it("accepts every type notificationService.js can emit", async () => {
        const types = notificationTypesUsedInCode();
        // A guard on the guard: if the regex ever stops matching, an empty list
        // would make this test pass while checking nothing.
        expect(types.length).toBeGreaterThan(15);

        const recipient = await createUser({ email: "notif-type-constraint@example.com" });

        const rejected = [];
        for (const type of types) {
            try {
                await pool.query(
                    `INSERT INTO notifications (recipient_id, actor_id, type, entity_type, entity_id, message)
                     VALUES ($1, $1, $2, 'PROFILE', $1, 'constraint probe')`,
                    [recipient.id, type]
                );
            } catch (error) {
                // Only a violation of the type constraint is this test's concern;
                // anything else (a bad entity_type, a dead FK) is a different bug
                // and should surface as itself.
                if (error.constraint !== "notifications_type_check") throw error;
                rejected.push(type);
            }
        }

        expect(rejected).toEqual([]);
    });
});
