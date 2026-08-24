// The one place that decides *whether* a given outbound email is sent at all.
// `config/mailer.js` owns "how do we talk to a provider"; this owns "is this
// particular message switched on right now" — kept separate so turning a flow
// off is an environment change, never a code change.
//
// Why a registry rather than a bare `process.env.SOMETHING === "false"` check
// scattered at each call site:
//   - Every flow is listed in one readable place, with its env var and its
//     default, so "what does this app email people?" has a single answer.
//   - Adding a flow is one entry here plus one template in mailService.js —
//     no new plumbing, no new env parsing, and it inherits the global kill
//     switch and the same true/false vocabulary for free.
//   - Turning a flow off is `MAIL_FEATURE_SALARY_SLIP=false` in the
//     environment, with no deploy of changed code.
//
// Flags are read from `process.env` on **every** send, not captured at import
// time: the flag is an operational switch (flip it, restart, done) and tests
// need to toggle it per case. This is cheap — one env lookup per email.
//
// This file deliberately knows nothing about templates, recipients or the
// transport. It answers one question, for one key.

// Every outbound email in the app. `enabledByDefault` is what applies when
// the env var is unset or unparseable, so a fresh deployment behaves sanely
// without any mail-specific configuration at all.
const FEATURE_DEFINITIONS = {
    // The only flow with no non-email delivery path — returning a reset link
    // in an API response would let anyone reset anyone's password. Switching
    // this off disables password recovery entirely, which is why it's called
    // out here rather than left to whoever reads the flag name.
    PASSWORD_RESET: {
        envVar: "MAIL_FEATURE_PASSWORD_RESET",
        enabledByDefault: true,
        description: "Forgot-password link (POST /auth/password-reset/request)",
    },
    // Safe to switch off: HR still gets the invite link in the API response
    // and can share it another way, so onboarding degrades rather than breaks.
    EMPLOYEE_INVITE: {
        envVar: "MAIL_FEATURE_EMPLOYEE_INVITE",
        enabledByDefault: true,
        description: "Invite link with password setup (POST /users/invite)",
    },
    // Safe to switch off: the in-app SALARY_SLIP_GENERATED notification and
    // the download endpoint both still work, so employees keep their payslips
    // — they just don't arrive in their inbox. Also the flow most likely to
    // be switched off deliberately: it's the only one that attaches a file
    // and the only one that fans out to every employee in a payroll run.
    // Safe to switch off, but think before doing it: this is the only email
    // that tells an employee a payslip they already have has been *withdrawn*.
    // The in-app SALARY_SLIP_VOIDED notification still fires either way, so
    // switching this off degrades to "they find out next time they open the
    // app" rather than "they never find out".
    SALARY_SLIP_VOIDED: {
        envVar: "MAIL_FEATURE_SALARY_SLIP_VOIDED",
        enabledByDefault: true,
        description: "Notice that a payslip has been voided (payroll void, or an employment-date change)",
    },
    SALARY_SLIP: {
        envVar: "MAIL_FEATURE_SALARY_SLIP",
        enabledByDefault: true,
        description: "Payslip PDF after a payroll run (POST /salary-slips/confirm)",
    },
};

// Callers reference features as `MAIL_FEATURES.SALARY_SLIP` rather than the
// bare string "SALARY_SLIP", so a typo is a `undefined` at the call site
// instead of a silently-never-sent email.
export const MAIL_FEATURES = Object.freeze(
    Object.fromEntries(Object.keys(FEATURE_DEFINITIONS).map((key) => [key, key]))
);

// Accepts the spellings people actually put in a .env file. Anything else
// (including an empty string, which is what an unset-but-declared var looks
// like) falls through to the feature's default rather than being guessed at:
// `MAIL_FEATURE_SALARY_SLIP=` should not silently mean "off".
const TRUTHY = new Set(["true", "1", "yes", "on", "enabled"]);
const FALSY = new Set(["false", "0", "no", "off", "disabled"]);

function parseFlag(rawValue, fallback) {
    if (rawValue === undefined || rawValue === null) return fallback;
    const normalized = String(rawValue).trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
    return fallback;
}

// Input: a `MAIL_FEATURES` key. Output: whether that email may be sent right
// now. Failure mode: throws on an unknown key — that's a programming error
// (a mistyped feature name would otherwise mean "this email silently stopped
// existing"), and it surfaces on the first send rather than never.
//
// `MAIL_ENABLED=false` is a global kill switch that overrides every
// per-feature flag: one variable to stop all outbound mail during an
// incident, a load test, or a data migration, without having to know which
// flows exist.
export function isMailFeatureEnabled(feature) {
    const definition = FEATURE_DEFINITIONS[feature];
    if (!definition) {
        throw new Error(`Unknown mail feature "${feature}" — add it to config/mailFeatures.js`);
    }

    if (!parseFlag(process.env.MAIL_ENABLED, true)) {
        return false;
    }

    return parseFlag(process.env[definition.envVar], definition.enabledByDefault);
}

// Input: none. Output: one row per flow — its key, env var, description and
// current effective state. Exists for the startup log in server.js, so a
// deployment's actual mail posture is visible in the logs instead of having
// to be inferred from a set of env vars.
export function describeMailFeatures() {
    return Object.entries(FEATURE_DEFINITIONS).map(([feature, definition]) => ({
        feature,
        envVar: definition.envVar,
        description: definition.description,
        enabled: isMailFeatureEnabled(feature),
    }));
}
