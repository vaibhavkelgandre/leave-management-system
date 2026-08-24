// Routes for Module 5 v2's employee-onboarding admin actions: document
// upload/review and profile verification (salary structure routes are
// added in salaryStructureRoutes wiring, see app.js). Static-path routes
// (/me/*, /pending-verification) are registered before the dynamic /:id
// routes — same ordering reasoning as leaveRequestRoutes.js's header comment.
import express from "express";
import * as controller from "../controllers/employeeController.js";
import * as salaryStructureController from "../controllers/salaryStructureController.js";
import { requireAuth } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/requireRole.js";
import { uploadEmployeeDocument } from "../middlewares/uploadMiddleware.js";
import { validateBody, validateParams, validateQuery } from "../validators/validate.js";
import {
    employeeIdParamSchema,
    documentTypeParamSchema,
    employeeDocumentParamsSchema,
    documentReviewSchema,
    employmentDatesSchema,
    salaryStructureSchema,
    customDocumentUploadSchema,
    documentIdParamSchema,
    sendProfileBackSchema,
    documentDispositionQuerySchema,
} from "../validators/employeeValidator.js";

const router = express.Router();

router.use(requireAuth);

// Registered before every "/:id/..." route below: "documents" is a literal
// first segment, so leaving it later would be fine today, but the file's
// convention is static-before-dynamic and this is the one route whose first
// segment could ever be mistaken for an employee id.
//
// Serves any document row — a required one or a custom one, the caller's own
// or (for HR in scope) someone else's — since authorization comes from the
// row itself (employeeDocumentService.getDocumentFile), exactly like salary
// slips' "/:id" and leave requests' "/:id".
router.get(
    "/documents/:documentId/file",
    validateParams(documentIdParamSchema),
    validateQuery(documentDispositionQuerySchema),
    controller.getDocumentFile
);

// Registered before /me/documents/:documentType below — "custom" would
// otherwise be swallowed by that dynamic segment (Express matches routes in
// registration order; :documentType has no way to know "custom" isn't a
// real value until the zod enum check runs, which is too late to reach this
// handler instead).
router.post(
    "/me/documents/custom",
    uploadEmployeeDocument,
    validateBody(customDocumentUploadSchema),
    controller.uploadCustomDocument
);
router.get(
    "/me/documents/custom/:documentId/url",
    validateParams(documentIdParamSchema),
    controller.getMyCustomDocumentUrl
);
router.delete(
    "/me/documents/custom/:documentId",
    validateParams(documentIdParamSchema),
    controller.deleteCustomDocument
);

router.post(
    "/me/documents/:documentType",
    validateParams(documentTypeParamSchema),
    uploadEmployeeDocument,
    controller.uploadDocument
);
router.get("/me/documents", controller.listMyDocuments);
router.get("/me/documents/:documentType/url", validateParams(documentTypeParamSchema), controller.getMyDocumentUrl);
router.post("/me/profile/submit", controller.submitProfile);
router.get("/pending-verification", requireRole("HR_ADMIN", "SUPER_ADMIN"), controller.listPendingVerification);
router.get("/verified", requireRole("HR_ADMIN", "SUPER_ADMIN"), controller.listVerifiedEmployees);

// Registered after /pending-verification and /verified (literal paths
// Express would otherwise match against this pattern's :id first, since
// they're registered earlier) — the full profile for HR's verification
// detail page (and, unfiltered by profile_status, the new employee-details
// page for an already-verified employee).
router.get(
    "/:id",
    requireRole("HR_ADMIN", "SUPER_ADMIN"),
    validateParams(employeeIdParamSchema),
    controller.getEmployeeForVerification
);

router.get("/:id/documents", validateParams(employeeIdParamSchema), controller.listDocumentsForEmployee);
router.get(
    "/:id/documents/:documentType/url",
    validateParams(employeeDocumentParamsSchema),
    controller.getDocumentUrl
);
router.post(
    "/:id/documents/:documentType/review",
    requireRole("HR_ADMIN", "SUPER_ADMIN"),
    validateParams(employeeDocumentParamsSchema),
    validateBody(documentReviewSchema),
    controller.reviewDocument
);
router.post("/:id/verify", requireRole("HR_ADMIN", "SUPER_ADMIN"), validateParams(employeeIdParamSchema), controller.verifyProfile);
router.post(
    "/:id/send-back",
    requireRole("HR_ADMIN", "SUPER_ADMIN"),
    validateParams(employeeIdParamSchema),
    validateBody(sendProfileBackSchema),
    controller.sendProfileBack
);

// HR-only, and scoped to the actor's own HR scope inside the service. These
// two dates set the payable-day count on every payslip, which is why they left
// the self-editable profile fields entirely.
router.patch(
    "/:id/employment-dates",
    requireRole("HR_ADMIN", "SUPER_ADMIN"),
    validateParams(employeeIdParamSchema),
    validateBody(employmentDatesSchema),
    controller.updateEmploymentDates
);

// Self can view their own structure (payroll-readiness transparency), HR
// can view/assign within their own subtree — the row-level check lives in
// salaryStructureService, not a route-level role gate, same reasoning as
// leave requests' /:id.
router.get("/:id/salary-structure", validateParams(employeeIdParamSchema), salaryStructureController.getStructure);
router.patch(
    "/:id/salary-structure",
    requireRole("HR_ADMIN", "SUPER_ADMIN"),
    validateParams(employeeIdParamSchema),
    validateBody(salaryStructureSchema),
    salaryStructureController.assignStructure
);

export default router;
