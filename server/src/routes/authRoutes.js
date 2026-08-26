import express from "express";
import {
    getBootstrapStatus,
    registerHrAdmin,
    login,
    googleLogin,
    logout,
    getCurrentUser,
    verifyInvitation,
    acceptInvitation,
    requestPasswordReset,
    confirmPasswordReset,
} from "../controllers/authController.js";
import { requireAuth } from "../middlewares/authMiddleware.js";
import { validateBody } from "../validators/validate.js";
import {
    registerHrSchema,
    loginSchema,
    googleLoginSchema,
    verifyInviteSchema,
    acceptInviteSchema,
    requestPasswordResetSchema,
    confirmPasswordResetSchema,
} from "../validators/authValidator.js";

const router = express.Router();

// Public and unauthenticated on purpose — read by the login page before
// anyone can possibly hold a session. No validator: it takes no input.
router.get("/bootstrap-status", getBootstrapStatus);
router.post("/register/hr", validateBody(registerHrSchema), registerHrAdmin);
router.post("/login", validateBody(loginSchema), login);
router.post("/google", validateBody(googleLoginSchema), googleLogin);
router.post("/logout", logout);
// Only this route needs requireAuth explicitly — it's the one place a caller
// asks "who am I" using their existing session, the rest of the auth routes are pre-login.
router.get("/me", requireAuth, getCurrentUser);
router.post("/invitations/verify", validateBody(verifyInviteSchema), verifyInvitation);
router.post("/invitations/accept", validateBody(acceptInviteSchema), acceptInvitation);
router.post("/password-reset/request", validateBody(requestPasswordResetSchema), requestPasswordReset);
router.post("/password-reset/confirm", validateBody(confirmPasswordResetSchema), confirmPasswordReset);

export default router;
