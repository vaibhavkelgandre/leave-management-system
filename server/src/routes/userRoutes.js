import express from "express";
import {
    inviteEmployee,
    getUsers,
    getUserOptions,
    getMyTeam,
    getMyTeamSize,
    getUserById,
    updateManager,
    updateRole,
    updateStatus,
    updateMyProfile,
    changePassword,
} from "../controllers/userController.js";
import { requireAuth } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/requireRole.js";
import { requireUserScope } from "../middlewares/requireUserScope.js";
import { validateBody, validateParams } from "../validators/validate.js";
import {
    inviteEmployeeSchema,
    userIdParamSchema,
    updateManagerSchema,
    updateRoleSchema,
    updateStatusSchema,
} from "../validators/userValidator.js";
import { updateMyProfileSchema, changePasswordSchema } from "../validators/profileValidator.js";

const router = express.Router();

// Every user-related endpoint requires a logged-in session — applied once here
// so individual routes below don't have to repeat it.
router.use(requireAuth);

router.post("/invite", requireRole("HR_ADMIN", "SUPER_ADMIN"), validateBody(inviteEmployeeSchema), inviteEmployee);
router.get("/me/team", getMyTeam);
// Registered next to /me/team, and before the dynamic "/:id" below like every
// other static path in this file.
router.get("/me/team/count", getMyTeamSize);
// Self-only by construction (always req.user.id, no :id param) — no
// requireUserScope needed, unlike GET /:id below.
router.patch("/me/profile", validateBody(updateMyProfileSchema), updateMyProfile);
router.post("/me/password", validateBody(changePasswordSchema), changePassword);
// Before "/:id" like every other static path here. Same scoping as GET "/",
// five columns wide — for the dropdowns that don't need a whole profile each.
router.get("/options", getUserOptions);
router.get("/", getUsers);
// requireUserScope restricts non-HR callers to only fetch their own record or
// direct reports, so employees/managers can't read arbitrary users by id.
router.get("/:id", validateParams(userIdParamSchema), requireUserScope("id"), getUserById);
router.patch(
    "/:id/manager",
    requireRole("HR_ADMIN", "SUPER_ADMIN"),
    validateParams(userIdParamSchema),
    validateBody(updateManagerSchema),
    updateManager
);
// HR-tier only, same as /manager and /status: a plain MANAGER must never be
// offered either, since promoting someone is an HR-desk action. Row-level
// entitlement (creator, or in the actor's own HR scope) is then checked inside
// changeRole — the role gate alone only answers "is this an HR admin".
router.patch(
    "/:id/role",
    requireRole("HR_ADMIN", "SUPER_ADMIN"),
    validateParams(userIdParamSchema),
    validateBody(updateRoleSchema),
    updateRole
);
router.patch(
    "/:id/status",
    requireRole("HR_ADMIN", "SUPER_ADMIN"),
    validateParams(userIdParamSchema),
    validateBody(updateStatusSchema),
    updateStatus
);

export default router;
