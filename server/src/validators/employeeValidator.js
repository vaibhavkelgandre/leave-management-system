// Request-shape validation for the employee-onboarding admin actions
// (Module 5 v2): document upload/review and profile verification.
import { z } from "zod";
import { REQUIRED_DOCUMENT_TYPES } from "../services/employeeDocumentService.js";

export const employeeIdParamSchema = z.object({
    id: z.string().uuid("id must be a valid id"),
});

export const documentTypeParamSchema = z.object({
    documentType: z.enum(REQUIRED_DOCUMENT_TYPES),
});

export const employeeDocumentParamsSchema = z.object({
    id: z.string().uuid("id must be a valid id"),
    documentType: z.enum(REQUIRED_DOCUMENT_TYPES),
});

export const documentReviewSchema = z.object({
    status: z.enum(["VERIFIED", "REJECTED"]),
    comment: z.string().trim().optional(),
});

// Unlike a document rejection's optional comment above, sending back a
// whole profile always requires an explanation — the employee can't fix
// "misleading info" without knowing which info, or why it didn't match
// their documents.
export const sendProfileBackSchema = z.object({
    reason: z.string().trim().min(1, "reason is required").max(1000),
});

// A custom (OTHER) document — user-supplied label, arriving as a multipart
// text field alongside the file.
export const customDocumentUploadSchema = z.object({
    name: z.string().trim().min(1, "name is required").max(100),
});

export const documentIdParamSchema = z.object({
    documentId: z.string().uuid("documentId must be a valid id"),
});

// Which Content-Disposition the document stream should carry. Constrained to
// the two real values rather than interpolated from the query string, so the
// header can never be shaped by the caller. Optional: the endpoint defaults
// to `inline`, since previewing is what it exists for.
export const documentDispositionQuerySchema = z.object({
    disposition: z.enum(["inline", "attachment"]).optional(),
});

// HR-entered salary structure — all figures required (default to 0 rather
// than omitting, since a structure is meant to be the complete picture used
// for payroll, not a partial update like the self-service profile fields).
// Local, matching the convention in delegationValidator.js/profileValidator.js
// — each validator defines its own rather than importing a shared one.
const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be in YYYY-MM-DD format");

// The exit action. lastWorkingDay is required (that is the whole point), and a
// reason is required too — it is recorded on the void of any payslip this
// corrects, and "why was this payslip voided" with no answer is worse than no
// void record at all. Same reasoning as the required comment on an HR override.
export const employeeExitSchema = z.object({
    lastWorkingDay: dateStringSchema,
    reason: z.string().trim().min(1, "A reason is required to record an exit"),
});

// HR sets these two dates, never the employee — both determine pay (see
// userRepository's PROFILE_FIELD_COLUMNS note). `.nullable()` on each so a date
// can be cleared as well as set: clearing last_working_day is how a rejoining
// employee returns to the payroll list. At least one key must be present, so an
// empty body is a 422 rather than a silent no-op.
export const employmentDatesSchema = z
    .object({
        joiningDate: dateStringSchema.nullable().optional(),
        lastWorkingDay: dateStringSchema.nullable().optional(),
    })
    .refine((data) => data.joiningDate !== undefined || data.lastWorkingDay !== undefined, {
        message: "Provide joiningDate, lastWorkingDay, or both",
    });

export const salaryStructureSchema = z.object({
    basicSalary: z.coerce.number().min(0),
    hra: z.coerce.number().min(0).optional().default(0),
    pfEmployeeContribution: z.coerce.number().min(0).optional().default(0),
    pfEmployerContribution: z.coerce.number().min(0).optional().default(0),
    esic: z.coerce.number().min(0).optional().default(0),
    specialAllowance: z.coerce.number().min(0).optional().default(0),
    incomeTax: z.coerce.number().min(0).optional().default(0),
});
