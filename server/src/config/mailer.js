// The one and only module in this codebase that knows a mail provider exists.
//
// This is the second provider swap this file has absorbed, and both times it
// changed alone: mailService.js, mailFeatures.js, mailLayout.js and every
// caller were untouched. First nodemailer/Gmail SMTP → SendGrid, now SendGrid
// → Brevo. That is the whole reason this exports a *function* rather than a
// configured client (the deviation from config/cloudinary.js's precedent):
// exposing a provider object would leak its shape into mailService.js and make
// the next swap a two-file change.
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
// configuration gets mail out of Render, and writing our own SMTP client
// would not change what the network allows — the block is below our code.
//
// HTTPS on 443 is not blocked, which is the whole reason this works.
//
// Why Brevo specifically: SendGrid's free access is time-limited (two months),
// after which sending stops. Brevo's free tier is permanent, and — the
// constraint that actually decided it — it verifies a *single sender address*
// by email rather than requiring a whole authenticated domain, which this
// deployment has no DNS access to arrange. Resend was rejected for exactly
// that reason: without a verified domain it will only deliver to the account
// owner's own address, which is useless for emailing invites to employees.
//
// Deliberately no provider SDK, same as before: Brevo's transactional send is
// one POST with a JSON body and `fetch` is global in Node 18+. A package would
// buy nothing but risk here — an uncommitted nodemailer entry in package.json
// is what crashed this project's Render deploy at boot earlier, because a
// top-level import of a module Render never installed kills the process. Zero
// new dependencies means that failure mode cannot recur.
//
// `{ to, subject, text, html }` remains the exact intersection of Brevo's,
// SendGrid's, Resend's and nodemailer's send calls, so it stays swappable.
// Resist adding cc/bcc until something needs them: that's precisely where
// providers diverge.
//
// `attachments` is the one key that is *not* a free intersection, and exists
// for exactly one caller — the payslip PDF (mailService.sendSalarySlipEmail).
// Callers hand over `{ filename, content: Buffer, contentType }` and this
// function maps it to whatever the current provider wants. Brevo wants
// `attachment` (singular) with `name` + base64 `content` and infers the type
// from the extension; SendGrid demands `filename`, base64 `content`, `type`
// and `disposition`; nodemailer took a raw Buffer. Keep that mapping explicit
// here rather than spreading the caller's object through, so the next swap
// stays one file.
import dotenv from "dotenv";

dotenv.config();

const BREVO_SEND_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const SENDGRID_SEND_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

// A hung provider must not hold a request open indefinitely. The old SMTP
// transport capped connect/greeting/socket separately; one HTTP request needs
// one budget. 10s is generous for a JSON POST and still well inside any
// reasonable proxy timeout — and the payslip flow sends sequentially *after*
// responding, so a slow provider delays that loop rather than a user's wait.
const REQUEST_TIMEOUT_MS = 10_000;

// Providers want `from` as `{ email, name }` (Brevo calls it `sender`, with
// the identical shape), but MAIL_FROM is conventionally one RFC-5322 string.
// Parse the display-name form rather than making every deployment configure
// the same identity twice.
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
// because the authenticated mailbox *was* the sender. Every HTTP provider
// rejects a send whose sender isn't verified, so a missing MAIL_FROM has to
// read as "unconfigured" (log the message) instead of 4xx-ing on every send.
function fromAddress() {
    return parseFrom(process.env.MAIL_FROM);
}

// Pasted keys routinely carry a trailing newline or stray spaces, which
// produces a 401 indistinguishable from a wrong key. Same reasoning as the
// Gmail App Password whitespace strip this ultimately replaces.
function readKey(name) {
    return (process.env[name] || "").trim();
}

// Which provider this deployment is configured for.
//
// Input: none — reads process.env. Output: `"brevo"`, `"sendgrid"`, or `null`
// when neither key is present.
//
// Brevo wins when both keys are set, and that precedence is the whole point of
// keeping two branches: it makes the migration orderless. A deploy that lands
// before BREVO_API_KEY is set keeps sending through SendGrid instead of
// falling through to the unconfigured path — which would not merely stop mail,
// it would *log invite and reset links in plaintext* to Render's logs (see
// sendMail below). Getting the env-var and deploy order wrong is ordinary; a
// credential leak as the penalty for it is not acceptable.
//
// **Delete the SendGrid branch once Brevo is verified in production.** It is
// migration scaffolding, not a feature — two code paths where one is never
// exercised is how the unused one rots, and SendGrid's access expires anyway.
function activeProvider() {
    if (readKey("BREVO_API_KEY")) return "brevo";
    if (readKey("SENDGRID_API_KEY")) return "sendgrid";
    return null;
}

// Input: none. Output: true when there's enough config to attempt a send.
// Checks the sender as well as a key, because every provider refuses an
// unverified sender and a half-filled environment is the common failure —
// which would otherwise surface as a 4xx on every send rather than the
// unconfigured fallback below.
export function isMailConfigured() {
    return Boolean(activeProvider() && fromAddress());
}

// Builds the Brevo transactional-send request.
//
// Input: the provider-neutral message. Output: `{ endpoint, headers, body }`
// ready for fetch. Never throws.
//
// Two differences from SendGrid worth knowing:
//   - Auth is an `api-key` header, not `Authorization: Bearer`. A Bearer token
//     here fails as 401, which reads as a bad key rather than a wrong scheme.
//   - There is no per-send tracking-settings equivalent. SendGrid let us
//     disable click tracking in the payload, which mattered because every link
//     this app mails is a single-use credential — an invite or reset token —
//     and click tracking rewrites hrefs through the provider's redirector,
//     routing a live secret through a third party and destroying the one
//     property that lets a recipient tell a real invite from phishing (a
//     visible link to the sending domain; mismatched link and sender domains
//     are themselves a spam signal). On Brevo that is an **account-level
//     setting**, so it must be switched off in the dashboard and cannot be
//     enforced from here. That is a genuine regression in what this file can
//     guarantee, recorded rather than glossed over.
function buildBrevoRequest({ to, subject, text, html, attachments }) {
    const body = {
        sender: fromAddress(),
        to: [{ email: to }],
        subject,
        // Brevo names these textContent/htmlContent and takes them as plain
        // keys, so unlike SendGrid there is no MIME-ordering constraint to
        // respect. Both are still always sent: a message with no text part is
        // scored as spam and renders blank in text-only clients.
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

    return {
        endpoint: BREVO_SEND_ENDPOINT,
        headers: {
            "api-key": readKey("BREVO_API_KEY"),
            accept: "application/json",
            "content-type": "application/json",
        },
        body,
    };
}

// Builds the SendGrid v3 send request.
//
// Input: the provider-neutral message. Output: `{ endpoint, headers, body }`
// ready for fetch. Never throws.
//
// Migration scaffolding — see activeProvider(). Retained verbatim from the
// previous version of this file so the fallback path is the one that was
// actually in production, not a fresh reimplementation of it.
function buildSendGridRequest({ to, subject, text, html, attachments }) {
    // Order matters: SendGrid requires content parts in ascending MIME
    // preference, so text/plain must precede text/html or the API 400s.
    const content = [{ type: "text/plain", value: text }];
    if (html) content.push({ type: "text/html", value: html });

    // Every tracking feature off, explicitly, because SendGrid enables click
    // tracking by default and that default is actively wrong for this app —
    // see buildBrevoRequest's comment for the full reasoning. Set per-send
    // rather than left to the dashboard so a console toggle can't silently
    // reintroduce any of it.
    const tracking_settings = {
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: false },
        subscription_tracking: { enable: false },
    };

    const body = {
        personalizations: [{ to: [{ email: to }] }],
        from: fromAddress(),
        subject,
        content,
        tracking_settings,
        ...(attachments?.length
            ? {
                  attachments: attachments.map((file) => ({
                      filename: file.filename,
                      content: file.content.toString("base64"),
                      type: file.contentType,
                      disposition: "attachment",
                  })),
              }
            : {}),
    };

    return {
        endpoint: SENDGRID_SEND_ENDPOINT,
        headers: {
            Authorization: `Bearer ${readKey("SENDGRID_API_KEY")}`,
            "Content-Type": "application/json",
        },
        body,
    };
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
//     is why isMailConfigured() must be true anywhere real, and why
//     activeProvider() prefers a working provider over this path.
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

    const provider = activeProvider();
    const build = provider === "brevo" ? buildBrevoRequest : buildSendGridRequest;
    const { endpoint, headers, body } = build({ to, subject, text, html, attachments });

    let response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        // fetch rejects only on a network-level failure or the timeout above;
        // an HTTP error status resolves normally and is handled below. Both
        // become one thrown Error so callers see a single failure shape.
        throw new Error(`Mail provider (${provider}) unreachable: ${error.message}`);
    }

    // Any 2xx is success and the body is not read: SendGrid answers 202 with
    // an empty body, Brevo answers 201 with a messageId nothing here needs.
    // Checking `response.ok` rather than a specific code keeps both correct
    // and survives a provider adding, say, 200.
    //
    // A failure body carries the provider's own error text, which is the only
    // way to tell a bad key from an unverified sender — surface it instead of
    // a bare status code, because that distinction is exactly what a
    // deployment needs from the log line. The provider is named because with
    // two branches "rejected the message" alone no longer says which API
    // answered.
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
            `Mail provider (${provider}) rejected the message (${response.status}): ${detail.slice(0, 500)}`
        );
    }

    return true;
}
