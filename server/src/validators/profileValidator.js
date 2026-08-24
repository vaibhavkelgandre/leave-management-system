// Request-shape validation for the self-service employee profile (Module 5,
// FR-026) and the authenticated change-password endpoint.
import { z } from "zod";

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be in YYYY-MM-DD format");

// Every field is optional — a PATCH is always a partial update, and
// userRepository.updateProfileFields only ever writes the keys actually
// present. Never includes role/managerId/status/email/employeeCode/
// profileStatus: those stay HR/system managed via the existing invite/
// updateManager/updateStatus flows and the verification workflow, not this
// endpoint.
export const updateMyProfileSchema = z.object({
    designation: z.string().trim().min(1).max(100).optional(),
    department: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().min(1, "phone cannot be blank").max(20).optional(),
    dateOfBirth: dateStringSchema.optional(),
    highestEducation: z.string().trim().min(1).max(150).optional(),
    passportNumber: z.string().trim().toUpperCase().min(1).max(20).optional(),
    passportExpiryDate: dateStringSchema.optional(),
    bloodGroup: z.string().trim().toUpperCase().max(5).optional(),
    maritalStatus: z.enum(["SINGLE", "MARRIED", "OTHER"]).optional(),
    currentAddress: z.string().trim().min(1, "currentAddress cannot be blank").optional(),
    permanentAddress: z.string().trim().min(1, "permanentAddress cannot be blank").optional(),
    nearestAirport: z.string().trim().min(1).max(100).optional(),
    healthProblem: z.string().trim().max(2000).optional(),
    healthInsuranceStatus: z.string().trim().min(1).max(50).optional(),
    emergencyContact1Phone: z.string().trim().min(1, "emergencyContact1Phone cannot be blank").max(20).optional(),
    emergencyContact1Relationship: z.string().trim().min(1).max(50).optional(),
    emergencyContact2Phone: z.string().trim().max(20).optional(),
    emergencyContact2Relationship: z.string().trim().max(50).optional(),
    panNumber: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "panNumber must be a valid PAN (e.g. ABCDE1234F)")
        .optional(),
    aadharNumber: z.string().trim().regex(/^\d{12}$/, "aadharNumber must be 12 digits").optional(),
    bankAccountNumber: z.string().trim().min(1, "bankAccountNumber cannot be blank").max(34).optional(),
    bankIfscCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "bankIfscCode must be a valid IFSC code (e.g. HDFC0001234)")
        .optional(),
    bankName: z.string().trim().min(1, "bankName cannot be blank").max(100).optional(),
});

// Distinct from the forgot-password reset flow (authValidator.js's
// requestPasswordResetSchema/confirmPasswordResetSchema) — this one requires
// proving knowledge of the current password rather than a mailed token.
export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, "currentPassword is required"),
    newPassword: z.string().min(8, "newPassword must be at least 8 characters"),
});
