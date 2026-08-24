// Thin HTTP glue for the employee-onboarding admin actions added in Module 5
// v2: document upload/review, profile verification, and (see
// salaryStructureController.js) salary structures. All business logic lives
// in userService.js / employeeDocumentService.js.
import * as userService from "../services/userService.js";
import * as employeeDocumentService from "../services/employeeDocumentService.js";
import { sendSuccess } from "../utils/apiResponse.js";

export async function uploadDocument(req, res, next) {
    try {
        const document = await employeeDocumentService.uploadDocument(req.user.id, req.params.documentType, req.file);
        sendSuccess(res, 200, "Document uploaded", document);
    } catch (error) {
        next(error);
    }
}

export async function listMyDocuments(req, res, next) {
    try {
        const documents = await employeeDocumentService.listDocuments(req.user, req.user.id);
        sendSuccess(res, 200, "Documents retrieved", documents);
    } catch (error) {
        next(error);
    }
}

export async function listDocumentsForEmployee(req, res, next) {
    try {
        const documents = await employeeDocumentService.listDocuments(req.user, req.params.id);
        sendSuccess(res, 200, "Documents retrieved", documents);
    } catch (error) {
        next(error);
    }
}

export async function getDocumentUrl(req, res, next) {
    try {
        const document = await employeeDocumentService.getDocumentUrl(req.user, req.params.id, req.params.documentType);
        sendSuccess(res, 200, "Document retrieved", document);
    } catch (error) {
        next(error);
    }
}

// Same lookup as getDocumentUrl, always scoped to the caller's own id — lets
// ProfileDocumentUpload.jsx offer a "View" action without needing to know
// its own employee id (it doesn't receive one as a prop today).
export async function getMyDocumentUrl(req, res, next) {
    try {
        const document = await employeeDocumentService.getDocumentUrl(req.user, req.user.id, req.params.documentType);
        sendSuccess(res, 200, "Document retrieved", document);
    } catch (error) {
        next(error);
    }
}

// Streams a document's bytes through this app rather than handing the
// browser a Cloudinary URL. `disposition=inline` (the default here, unlike
// the salary-slip endpoint's `attachment` default) is what makes an <iframe>
// actually render a PDF instead of downloading it — Cloudinary serves raw
// assets as attachments, so previewing one is only possible from a response
// we control. `attachment` stays available for a real save-to-disk.
//
// The filename is stripped of quotes/newlines before interpolation (same
// guard as leaveRequestController.downloadDocument) — it's user-supplied via
// the original upload, and a stray quote would break the header.
export async function getDocumentFile(req, res, next) {
    try {
        const { stream, filename, mimeType } = await employeeDocumentService.getDocumentFile(
            req.user,
            req.params.documentId
        );
        const disposition = req.query.disposition === "attachment" ? "attachment" : "inline";
        const safeFilename = filename.replace(/["\r\n]/g, "");
        res.setHeader("Content-Type", mimeType);
        res.setHeader(
            "Content-Disposition",
            `${disposition}; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
        );
        stream.on("error", next);
        stream.pipe(res);
    } catch (error) {
        next(error);
    }
}

export async function uploadCustomDocument(req, res, next) {
    try {
        const document = await employeeDocumentService.uploadCustomDocument(req.user.id, req.body.name, req.file);
        sendSuccess(res, 200, "Document uploaded", document);
    } catch (error) {
        next(error);
    }
}

export async function getMyCustomDocumentUrl(req, res, next) {
    try {
        const document = await employeeDocumentService.getDocumentUrlById(req.user, req.user.id, req.params.documentId);
        sendSuccess(res, 200, "Document retrieved", document);
    } catch (error) {
        next(error);
    }
}

export async function deleteCustomDocument(req, res, next) {
    try {
        await employeeDocumentService.deleteCustomDocument(req.user.id, req.params.documentId);
        sendSuccess(res, 200, "Document removed", null);
    } catch (error) {
        next(error);
    }
}

export async function reviewDocument(req, res, next) {
    try {
        const document = await employeeDocumentService.reviewDocument(
            req.user,
            req.params.id,
            req.params.documentType,
            req.body
        );
        sendSuccess(res, 200, "Document reviewed", document);
    } catch (error) {
        next(error);
    }
}

export async function submitProfile(req, res, next) {
    try {
        const user = await userService.submitProfileForVerification(req.user.id);
        sendSuccess(res, 200, "Profile submitted for verification", user);
    } catch (error) {
        next(error);
    }
}

// HR records that an employee has left. One action rather than a date edit
// followed by manual payslip housekeeping: it sets the leaving date and
// corrects any payslip that date invalidates, reporting both back.
export async function processExit(req, res, next) {
    try {
        const result = await userService.processEmployeeExit(req.user, req.params.id, req.body);
        const corrected = result.voided.length
            ? ` ${result.voided.length} payslip(s) voided (${result.voided.join(", ")}) — re-run payroll for those periods.`
            : "";
        sendSuccess(res, 200, `Exit recorded.${corrected}`.trim(), result);
    } catch (error) {
        next(error);
    }
}

// HR records the employment dates payroll depends on — the joining date from
// the signed offer letter at verification time, and the last working day when
// someone leaves. Not self-service: see userService.updateEmploymentDates.
export async function updateEmploymentDates(req, res, next) {
    try {
        const result = await userService.updateEmploymentDates(req.user, req.params.id, req.body);
        // Name the voided periods in the message, not just the payload: a date
        // correction that silently withdrew two payslips would be the kind of
        // side effect HR only discovers from the employee.
        const voidedNote = result.voided.length
            ? ` ${result.voided.length} payslip(s) voided (${result.voided.join(", ")}) — re-run payroll for those periods.`
            : "";
        sendSuccess(res, 200, `Employment dates updated.${voidedNote}`.trim(), result);
    } catch (error) {
        next(error);
    }
}

export async function verifyProfile(req, res, next) {
    try {
        const user = await userService.verifyProfile(req.user, req.params.id);
        sendSuccess(res, 200, "Profile verified", user);
    } catch (error) {
        next(error);
    }
}

export async function sendProfileBack(req, res, next) {
    try {
        const user = await userService.sendProfileBack(req.user, req.params.id, req.body.reason);
        sendSuccess(res, 200, "Profile sent back", user);
    } catch (error) {
        next(error);
    }
}

export async function listPendingVerification(req, res, next) {
    try {
        const users = await userService.listPendingVerification(req.user);
        sendSuccess(res, 200, "Pending profiles retrieved", users);
    } catch (error) {
        next(error);
    }
}

export async function getEmployeeForVerification(req, res, next) {
    try {
        const employee = await userService.getEmployeeForVerification(req.user, req.params.id);
        sendSuccess(res, 200, "Employee retrieved", employee);
    } catch (error) {
        next(error);
    }
}

export async function listVerifiedEmployees(req, res, next) {
    try {
        const users = await userService.listVerifiedEmployees(req.user);
        sendSuccess(res, 200, "Verified employees retrieved", users);
    } catch (error) {
        next(error);
    }
}
