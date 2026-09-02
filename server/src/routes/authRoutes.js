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
import {
    loginRateLimiter,
    registrationRateLimiter,
    passwordResetRateLimiter,
    tokenRateLimiter,
} from "../middlewares/rateLimiter.js";
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
// Every route below that takes a password, the shared registration code or a
// single-use token is rate limited by IP (rateLimiter.js) — these are the only
// endpoints in the API reachable without a session. The limiter runs before the
// validator so a flood of malformed bodies is capped too.
router.post("/register/hr", registrationRateLimiter, validateBody(registerHrSchema), registerHrAdmin);
router.post("/login", loginRateLimiter, validateBody(loginSchema), login);
router.post("/google", loginRateLimiter, validateBody(googleLoginSchema), googleLogin);
router.post("/logout", logout);
// Only this route needs requireAuth explicitly — it's the one place a caller
// asks "who am I" using their existing session, the rest of the auth routes are pre-login.
router.get("/me", requireAuth, getCurrentUser);
router.post("/invitations/verify", tokenRateLimiter, validateBody(verifyInviteSchema), verifyInvitation);
router.post("/invitations/accept", tokenRateLimiter, validateBody(acceptInviteSchema), acceptInvitation);
router.post(
    "/password-reset/request",
    passwordResetRateLimiter,
    validateBody(requestPasswordResetSchema),
    requestPasswordReset
);
router.post("/password-reset/confirm", tokenRateLimiter, validateBody(confirmPasswordResetSchema), confirmPasswordReset);

export default router;
