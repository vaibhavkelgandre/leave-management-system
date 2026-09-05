// The one and only module in this codebase that knows a mail provider exists.
//
// It has now absorbed two provider swaps, and both times it changed alone:
// mailService.js, mailFeatures.js, mailLayout.js and every caller were
// untouched. First nodemailer/Gmail SMTP → SendGrid, then SendGrid → Brevo.
// That is the whole reason this exports a *function* rather than a configured
// client (the deviation from config/cloudinary.js's precedent): exposing a
// provider object would leak its shape into mailService.js and make the next
// swap a two-file change.
//
// Why SMTP is not an option, so nobody tries to go back: **Render blocks
// outbound SMTP.** Ports 587 and 465 both fail with a TCP connect timeout
// (5s, before any TLS or auth), and a silent drop rather than ECONNREFUSED is
// the signature of a firewall, not a slow host — a TCP handshake to Google is
// one round trip. Before that surfaced, the same setup failed differently and
// far more confusingly: nodemailer resolves A and AAAA records separately and
// picks one at *random*, so sends died on `connect ENETUNREACH 2404:6800:…`
// whenever the coin landed on IPv6, which Render has no route for. Pinning to
// IPv4 fixed that and revealed the port block underneath. No amount of SMTP
// configuration gets mail out of Render, and writing our own SMTP client would
// not change what the network allows — the block is below our code.
//
// HTTPS on 443 is not blocked, which is the whole reason this works.
//
// Why Brevo: SendGrid's free access is time-limited (two months, then sending
// stops), while Brevo's free tier is permanent. The constraint that actually
// decided it is that Brevo verifies a *single sender address* by email rather
// than requiring an authenticated domain, which this deployment has no DNS
// access to arrange. Resend was rejected for exactly that reason — without a
// verified domain it only delivers to the account owner's own address, which
// is useless for emailing invites to employees.
//
// A SendGrid branch lived here briefly as migration scaffolding so that the
// env-var and deploy order could not leave mail unconfigured. It is gone now
// that Brevo is verified in production, deliberately: a fallback pointing at a
// provider whose access expires is worse than none, because isMailConfigured()
// would still read true while nothing could be delivered.
//
// Deliberately no provider SDK: Brevo's transactional send is one POST with a
// JSON body and `fetch` is global in Node 18+. A package would buy nothing but
// risk — an uncommitted nodemailer entry in package.json is what crashed this
// project's Render deploy at boot earlier, because a top-level import of a
// module Render never installed kills the process. Zero new dependencies makes
// that failure mode unreachable.
//
// `{ to, subject, text, html }` is the exact intersection of Brevo's,
// SendGrid's, Resend's and nodemailer's send calls, so it stays swappable.
// Resist adding cc/bcc until something needs them: that is precisely where
// providers diverge.
//
// `attachments` is the one key that is *not* a free intersection, and exists
// for exactly one caller — the payslip PDF (mailService.sendSalarySlipEmail).
// Callers hand over `{ filename, content: Buffer, contentType }` and this
// module maps it to whatever the current provider wants. Brevo wants
// `attachment` (singular) with `name` plus base64 `content`, inferring the type
// from the extension; SendGrid demanded `filename`, base64 `content`, `type`
// and `disposition`; nodemailer took a raw Buffer. Keep that mapping explicit
// here rather than spreading the caller's object through, so the next swap
// stays one file.
import dotenv from "dotenv";

dotenv.config();

const SEND_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

// A hung provider must not hold a request open indefinitely. The old SMTP
// transport capped connect/greeting/socket separately; one HTTP request needs
// one budget. 10s is generous for a JSON POST and still well inside any
// reasonable proxy timeout — and the payslip flow sends sequentially *after*
// responding, so a slow provider delays that loop rather than a user's wait.
const REQUEST_TIMEOUT_MS = 10_000;

// Brevo wants the sender as `{ email, name }` (it calls the field `sender`),
// but MAIL_FROM is conventionally one RFC-5322 string. Parse the display-name
// form rather than making every deployment configure the same identity twice.
//
// The bare-address form is the common case and passes through untouched.
//
// Both quoting mistakes are absorbed rather than passed on, because an env var
// that literally contains quotes is a *known* deployment error here: dotenv
// strips surrounding quotes from a .env file and hosting dashboards do not, so
// the value that works locally arrives quoted in production. `"Name <addr>"`
// (the whole thing quoted) and `"Name" <addr>` (only the display name, the RFC
// form) therefore both parse to the same sender. The old nodemailer parser
// turned the first into the garbage address `"Name <addr"@example.com` and sent
// it anyway; failing loudly would be better than that, but not failing at all
// is better still.
function parseFrom(value) {
    let raw = (value || "").trim();
    // Only a pair wrapping the *entire* value — `"Name" <addr>` ends in `>`,
    // so the RFC form is untouched by this.
    const wrapped = raw.match(/^"(.*)"$/);
    if (wrapped) raw = wrapped[1].trim();
    if (!raw) return null;

    const angled = raw.match(/^(.*)<([^>]+)>\s*$/);
    if (!angled) return { email: raw };

    const name = angled[1].trim().replace(/^"(.*)"$/, "$1").trim();
    const email = angled[2].trim();
    return name ? { email, name } : { email };
}

// No fallback, unlike the SMTP version which could default to SMTP_USER
// because the authenticated mailbox *was* the sender. Brevo rejects a send
// whose sender isn't verified, so a missing MAIL_FROM has to read as
// "unconfigured" (log the message) instead of 4xx-ing on every send.
function fromAddress() {
    return parseFrom(process.env.MAIL_FROM);
}

// Pasted keys routinely carry a trailing newline or stray spaces, which
// produces a 401 indistinguishable from a wrong key. Same reasoning as the
// Gmail App Password whitespace strip this ultimately replaces.
//
// Note the key must be an **API key** (`xkeysib-…`), from Brevo's "API Keys"
// tab. The adjacent "SMTP" tab issues an `xsmtpsib-…` credential for the SMTP
// relay, which this HTTP endpoint rejects with `{"message":"Key not found"}` —
// a message that reads as a wrong key rather than the wrong *kind* of key, and
// is the first thing to check on a 401.
function apiKey() {
    return (process.env.BREVO_API_KEY || "").trim();
}

// Input: none. Output: true when there's enough config to attempt a send.
// Checks the sender as well as the key, because Brevo refuses an unverified
// sender and a half-filled environment is the common failure — which would
// otherwise surface as a 4xx on every send rather than the unconfigured
// fallback below.
export function isMailConfigured() {
    return Boolean(apiKey() && fromAddress());
}

// Input: one message, described in provider-neutral terms, where
// `attachments` (optional) is a list of `{ filename, content: Buffer,
// contentType }`. Output: `true` when the message actually reached the
// provider, `false` when a non-sending path below short-circuited it —
// callers that tell a human "we emailed them" (the invite flow's `emailSent`)
// need to tell those apart, and guessing from `isMailConfigured()` at the
// call site would duplicate this function's own rules. Failure mode: rejects
// if the provider rejects (bad key, unverified sender, network) — callers
// decide whether that's fatal, the same convention cloudinaryService.js
// follows.
//
// Two non-sending paths, both deliberate:
//   - Under NODE_ENV=test, never send. config/cloudinary.js's own
//     dotenv.config() already leaks server/.env into the test process
//     (setup.js loads .env.test with override, but a key absent there and
//     present in .env still lands), so real credentials WILL be visible to
//     the suite. Without this guard, any future test touching a mail path
//     without stubbing this module would send real email.
//   - Unconfigured: log the message instead. That's the local-dev fallback,
//     and living here rather than in the caller means every future sender
//     inherits it for free. Note it logs the full plain-text body, which for
//     invites and resets *contains a live link* — harmless on a laptop, a
//     credential leak into log aggregation in a deployed environment, which
//     is why isMailConfigured() must be true anywhere real.
export async function sendMail({ to, subject, text, html, attachments }) {
    if (process.env.NODE_ENV === "test") return false;

    if (!isMailConfigured()) {
        // Attachment *contents* are never logged — a payslip PDF in the dev
        // console would be both useless and a data leak into log
        // aggregation. Names only, so the fallback still shows what would
        // have gone out.
        const attachmentNames = (attachments ?? []).map((file) => file.filename).join(", ");
        const attachmentNote = attachmentNames ? `\n[attachments] ${attachmentNames}` : "";
        console.log(`[mail:not-configured] to=${to} subject=${subject}\n${text}${attachmentNote}`);
        return false;
    }

    const payload = {
        sender: fromAddress(),
        to: [{ email: to }],
        subject,
        // Brevo takes these as plain keys, so unlike SendGrid there is no MIME
        // ordering constraint to respect. Both are still always sent: a
        // message with no text part is scored as spam and renders blank in
        // text-only clients.
        textContent: text,
        ...(html ? { htmlContent: html } : {}),
        ...(attachments?.length
            ? {
                  attachment: attachments.map((file) => ({
                      name: file.filename,
                      content: file.content.toString("base64"),
                  })),
              }
            : {}),
    };

    // ⚠️ Brevo has **no per-send tracking switch**, and that is a real
    // reduction in what this file can guarantee. The SendGrid version disabled
    // click tracking in the payload, which mattered because every link this
    // app mails is a single-use credential — an invite or password-reset token
    // — and click tracking rewrites hrefs through the provider's redirector.
    // That would route a live secret through a third party and destroy the one
    // property letting a recipient tell a real invite from phishing: a visible
    // link to the domain the mail claims to come from (mismatched link and
    // sender domains are themselves a spam signal). On Brevo this is an
    // **account-level dashboard setting**, so it must be switched off there and
    // cannot be enforced from here. Recorded rather than glossed over.
    let response;
    try {
        response = await fetch(SEND_ENDPOINT, {
            method: "POST",
            headers: {
                // An `api-key` header, not `Authorization: Bearer`. A bearer
                // token fails as a 401, which reads as a bad key rather than
                // the wrong scheme.
                "api-key": apiKey(),
                accept: "application/json",
                "content-type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        // fetch rejects only on a network-level failure or the timeout above;
        // an HTTP error status resolves normally and is handled below. Both
        // become one thrown Error so callers see a single failure shape.
        throw new Error(`Mail provider unreachable: ${error.message}`);
    }

    // Any 2xx is success and the body is not read: Brevo answers 201 with a
    // messageId nothing here needs. Checking `response.ok` rather than a
    // specific code survives the provider adding, say, 200.
    //
    // A failure body carries Brevo's own error text, which is the only way to
    // tell a bad key from an unverified sender — surface it instead of a bare
    // status code, because that distinction is exactly what a deployment needs
    // from the log line.
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Mail provider rejected the message (${response.status}): ${detail.slice(0, 500)}`);
    }

    return true;
}
