// Message templates, and nothing else. Everything provider-specific lives in
// config/mailer.js behind `sendMail`, every "is this flow switched on" decision
// lives in config/mailFeatures.js, and the HTML shell lives in
// utils/mailLayout.js — this file only ever describes *what* to say, so
// swapping the provider, flipping a flag or restyling the shell doesn't touch
// it.
//
// Adding a new email is three steps and no new plumbing:
//   1. Add an entry to FEATURE_DEFINITIONS in config/mailFeatures.js.
//   2. Add a `sendXEmail` function here that builds `{ subject, text, html }`
//      out of the utils/mailLayout.js builders.
//   3. Call it from the service that owns the event.
// Every sender then inherits the feature flag, the global kill switch, the
// unconfigured-dev fallback and the never-send-under-test guard for free.
//
// Errors are not caught here: a template has no useful recovery, and the
// caller has the context to decide (fire-and-forget for password reset,
// reported-but-not-fatal for invites, per-employee logging for payslips).
// Same convention as cloudinaryService.js.
import { sendMail } from "../config/mailer.js";
import { MAIL_FEATURES, isMailFeatureEnabled } from "../config/mailFeatures.js";
import {
    renderEmailLayout,
    renderPlainText,
    paragraph,
    button,
    linkFallback,
    detailRows,
    callout,
    footnote,
} from "../utils/mailLayout.js";

// Every template goes through here rather than calling `sendMail` directly,
// so the feature flag can't be forgotten on a new sender — the flag check
// being one line away from the send is exactly how it ends up missing from
// the fourth email someone adds.
//
// Output: `true` only when the message actually reached the transport;
// `false` when a flag, a missing SMTP config or the test guard stopped it.
// Callers that tell a human "we emailed them" (the invite flow) need that
// distinction; callers that don't care can ignore it.
async function dispatch({ feature, to, subject, text, html, attachments }) {
    if (!isMailFeatureEnabled(feature)) {
        // Logged, not silent: "the email never arrived" is otherwise
        // indistinguishable from a delivery failure, and this is the answer
        // in most of those cases.
        console.log(`[mail:disabled] feature=${feature} to=${to} subject=${subject}`);
        return false;
    }

    return sendMail({ to, subject, text, html, attachments });
}

// "1 hour" / "12 hours" — shared by the two link emails so their copy can't
// drift apart on the pluralization.
function formatHours(hours) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
}

// "45200.00" -> "₹45,200.00". Unlike payslipPdfService.js — which has to
// write "Rs." because pdfkit's built-in Helvetica has no rupee glyph — HTML
// and UTF-8 mail have no such limitation, so the real symbol is used here.
function formatMoney(value) {
    const amount = Number(value).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return `₹${amount}`;
}

// Roles are stored as the enum name; nobody outside the codebase should read
// "HR_ADMIN" in an email. Presentation-only, so it lives with the templates
// rather than being threaded through the invite service.
const ROLE_LABELS = {
    EMPLOYEE: "Employee",
    MANAGER: "Manager",
    HR_ADMIN: "HR Admin",
    SUPER_ADMIN: "Super Admin",
};

// Input: the recipient's address, the fully-built reset URL, and how long
// that URL stays valid (passed in rather than imported, so this file never
// reaches back into passwordResetService.js and creates a cycle — and so the
// copy can't drift when RESET_TOKEN_TTL_HOURS changes). Output: whether it
// was sent. Failure mode: rejects on a transport failure.
//
// No salutation, deliberately: findAuthByEmail doesn't return a name, and a
// no-greeting security email is the norm (GitHub/Stripe/Google all send
// these unaddressed) — "Hi there," would be worse than nothing.
export async function sendPasswordResetEmail({ to, resetLink, expiresInHours }) {
    const validity = formatHours(expiresInHours);

    const text = renderPlainText([
        "You asked to reset your Leave Management System password.",
        "",
        "Open this link to choose a new one:",
        resetLink,
        "",
        `This link expires in ${validity} and can only be used once.`,
        "",
        "If you didn't ask for this, you can safely ignore this email — your password will not change.",
    ]);

    const html = renderEmailLayout({
        heading: "Reset your password",
        preheader: `Choose a new password — this link expires in ${validity}.`,
        blocks: [
            paragraph("You asked to reset your Leave Management System password."),
            button({ label: "Choose a new password", href: resetLink }),
            linkFallback(resetLink),
            footnote(`This link expires in ${validity} and can only be used once.`),
            footnote(
                "If you didn't ask for this, you can safely ignore this email — your password will not change."
            ),
        ],
    });

    return dispatch({
        feature: MAIL_FEATURES.PASSWORD_RESET,
        to,
        subject: "Reset your password — Leave Management System",
        text,
        html,
    });
}

// Input: the invitee's address and first name, their assigned role, the
// fully-built invite URL, how long that URL stays valid, and (optionally)
// the name of the HR admin who created the account. Output: whether it was
// sent. Failure mode: rejects on a transport failure — the caller reports
// that as `emailSent: false` rather than failing the invite, since the
// account already exists by then and HR still has the link.
//
// Unlike the reset email this one *is* addressed by name: the recipient has
// no account yet and no reason to expect the message, so an unaddressed
// "set your password" link reads exactly like phishing. `invitedByName` is
// included for the same reason — "Priya added you" is the detail that makes
// it credible.
export async function sendEmployeeInviteEmail({ to, firstName, role, inviteLink, expiresInHours, invitedByName }) {
    const validity = formatHours(expiresInHours);
    const roleLabel = ROLE_LABELS[role] ?? role;
    const invitedByLine = invitedByName
        ? `${invitedByName} set up a Leave Management System account for you as ${roleLabel}.`
        : `A Leave Management System account has been set up for you as ${roleLabel}.`;

    const text = renderPlainText([
        `Hi ${firstName},`,
        "",
        invitedByLine,
        "",
        "Open this link to set your password and activate it:",
        inviteLink,
        "",
        `This link expires in ${validity} and can only be used once.`,
        "If it expires before you use it, ask your HR team to invite you again.",
        "",
        "Anyone with this link can set the password for your account — don't forward this email.",
    ]);

    const html = renderEmailLayout({
        heading: "Set up your account",
        preheader: `Set your password to activate your account — the link expires in ${validity}.`,
        blocks: [
            paragraph(`Hi ${firstName},`),
            paragraph(invitedByLine),
            paragraph("Set your own password to activate it — nobody else has one for you."),
            button({ label: "Set my password", href: inviteLink }),
            linkFallback(inviteLink),
            callout(
                `This link expires in ${validity} and can only be used once. If it expires before you use it, ask your HR team to invite you again.`,
                { tone: "neutral" }
            ),
            footnote(
                "Anyone with this link can set the password for your account — don't forward this email to anyone."
            ),
            footnote("If you weren't expecting this, tell your HR team before using the link."),
        ],
    });

    return dispatch({
        feature: MAIL_FEATURES.EMPLOYEE_INVITE,
        to,
        subject: "You've been invited to Leave Management System",
        text,
        html,
    });
}

// Input: the employee's address and first name, the pay period's display
// label ("August 2026"), the raw figures off the slip row (`netPay` is
// formatted here, not by the caller — currency presentation belongs with the
// templates), and the rendered PDF as `{ filename, content }`. Output:
// whether it was sent. Failure mode:
// rejects on a transport failure — the caller logs per employee and carries
// on, since a payroll run must not be undone by one bounced mailbox.
//
// The PDF is attached rather than linked: an attachment previews inline in
// Gmail (and every other modern client) with a download button already
// attached to it, which is exactly what was asked for. A link would instead
// bounce the reader through a login, and the download endpoint's authorization
// is per-request — nothing about a payslip needs a URL that outlives the
// email.
//
// The body repeats a few figures rather than saying only "see attached", so
// the message is useful on a locked phone or in a client that won't render
// the PDF. Net pay is deliberately kept out of the `preheader` — that line
// shows in the inbox list and on notification popups, where a salary figure
// has no business being.
// Tells an employee that a payslip they already have has been withdrawn.
//
// Input: `{ to, firstName, payPeriodLabel, reason }`. Output: the same
// true/false `dispatch` returns — true only when the message actually reached
// the transport.
//
// This exists because the alternative was worse in both directions. Silently
// voiding a payslip leaves someone holding a document that is no longer valid
// and no way to know; quietly *replacing* its figures (which is what this
// system did first) means they discover a pay cut by re-reading a payslip they
// already read. So the void is announced, in plain terms, with the reason HR
// gave — and deliberately **without** a corrected figure, because at the moment
// of voiding there isn't one yet: payroll has to be re-run, and inventing a
// number here would be guessing at what someone will be paid.
//
// No attachment, unlike sendSalarySlipEmail: there is nothing to attach. The
// point of the message is that the previous attachment no longer counts.
export async function sendSalarySlipVoidedEmail({ to, firstName, payPeriodLabel, reason }) {
    const text = renderPlainText([
        `Hi ${firstName},`,
        "",
        `Your payslip for ${payPeriodLabel} has been voided by your HR team.`,
        "",
        `Reason: ${reason}`,
        "",
        "This means the payslip you were sent for that period no longer applies.",
        "A corrected payslip will follow once payroll has been re-run.",
        "",
        "If you weren't expecting this, contact your HR team — they can explain what changed.",
    ]);

    const html = renderEmailLayout({
        heading: `Your payslip for ${payPeriodLabel} has been voided`,
        // Never the reason: a preheader shows on a lock screen, and "employment
        // ended" is not something to put there.
        preheader: `Your ${payPeriodLabel} payslip no longer applies. A corrected one will follow.`,
        blocks: [
            paragraph(`Hi ${firstName},`),
            paragraph(`Your payslip for ${payPeriodLabel} has been voided by your HR team.`),
            detailRows([
                { label: "Pay period", value: payPeriodLabel },
                { label: "Reason", value: reason },
            ]),
            callout("The payslip you were sent for that period no longer applies. A corrected one will follow once payroll has been re-run."),
            footnote("If you weren't expecting this, contact your HR team — they can explain what changed."),
        ],
    });

    return dispatch({
        feature: MAIL_FEATURES.SALARY_SLIP_VOIDED,
        to,
        subject: `Your payslip for ${payPeriodLabel} has been voided — Leave Management System`,
        text,
        html,
    });
}

export async function sendSalarySlipEmail({
    to,
    firstName,
    payPeriodLabel,
    netPay,
    payableDays,
    lopDays,
    pdf,
}) {
    const attachmentNote = `Your payslip is attached as ${pdf.filename} — preview it right here, or download it to keep.`;
    const netPayLabel = formatMoney(netPay);

    const text = renderPlainText([
        `Hi ${firstName},`,
        "",
        `Your payslip for ${payPeriodLabel} has been generated.`,
        "",
        `Net pay: ${netPayLabel}`,
        `Payable days: ${payableDays}`,
        Number(lopDays) > 0 ? `Loss-of-pay days: ${lopDays}` : null,
        "",
        attachmentNote,
        "",
        "The attached PDF is the full payslip — these lines are only a summary.",
        "If anything looks wrong, contact your HR team.",
    ]);

    const html = renderEmailLayout({
        heading: `Your payslip for ${payPeriodLabel}`,
        preheader: `Your payslip PDF for ${payPeriodLabel} is attached.`,
        blocks: [
            paragraph(`Hi ${firstName},`),
            paragraph(`Your payslip for ${payPeriodLabel} has been generated.`),
            detailRows([
                { label: "Pay period", value: payPeriodLabel },
                { label: "Payable days", value: String(payableDays) },
                ...(Number(lopDays) > 0 ? [{ label: "Loss-of-pay days", value: String(lopDays) }] : []),
                { label: "Net pay", value: netPayLabel, emphasis: true },
            ]),
            callout(attachmentNote),
            footnote("The attached PDF is the full payslip — the figures above are only a summary."),
            footnote("If anything looks wrong, contact your HR team."),
        ],
    });

    return dispatch({
        feature: MAIL_FEATURES.SALARY_SLIP,
        to,
        subject: `Your payslip for ${payPeriodLabel} — Leave Management System`,
        text,
        html,
        attachments: [{ filename: pdf.filename, content: pdf.content, contentType: "application/pdf" }],
    });
}
