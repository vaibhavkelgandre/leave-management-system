// Routes for Module 3's manager delegation (FR-020). Nominating a delegate
// and listing what you've nominated is manager-only — but the delegate side
// (GET /as-delegate) is deliberately open to any authenticated role, since a
// manager can nominate a plain EMPLOYEE as their delegate (createDelegation
// only checks the candidate exists and is ACTIVE, not their role), and that
// employee still needs a way to find out. There's no HR/admin view of
// delegations, since the brief doesn't ask for one and scope discipline says
// not to add it unasked.
import express from "express";
import * as controller from "../controllers/delegationController.js";
import { requireAuth } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/requireRole.js";
import { validateBody } from "../validators/validate.js";
import { createDelegationSchema, updateDelegationSchema } from "../validators/delegationValidator.js";

const router = express.Router();

router.use(requireAuth);

router.post("/", requireRole("MANAGER"), validateBody(createDelegationSchema), controller.create);
// Editing is MANAGER-only like creating, but the role gate is not what protects
// it: ownership is checked in the service, which answers 404 for another
// manager's delegation rather than 403 (NFR-5).
router.patch("/:id", requireRole("MANAGER"), validateBody(updateDelegationSchema), controller.update);
router.get("/mine", requireRole("MANAGER"), controller.listMine);
router.get("/as-delegate", controller.listAsDelegate);

export default router;
