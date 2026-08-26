// The one-time setup page for a fresh deployment, at /register.
//
// This is the only account-creation form in the app that isn't invite-driven:
// somebody has to exist before anybody can be invited, and until they do there
// is no credential that can satisfy the sign-in form. Reached from LoginPage's
// own "no administrator account" panel rather than advertised anywhere, and
// BootstrapOnlyRoute sends visitors away the moment an account exists.
//
// The registration code is what keeps this from being open signup: it lives in
// the server's environment, so only whoever deployed the app can complete it.
import { useState } from "react";
import { Link } from "react-router-dom";
import * as authService from "../services/authService.js";
import { useAuth } from "../hooks/useAuth.js";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { PasswordInput } from "../components/ui/PasswordInput.jsx";

const inputClasses =
    "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
const labelClasses = "mb-1 block text-sm font-medium text-slate-700";

const EMPTY_FORM = {
    registrationCode: "",
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    confirmPassword: "",
};

export function RegisterSuperAdminPage() {
    const { refreshUser } = useAuth();
    const [form, setForm] = useState(EMPTY_FORM);
    const [error, setError] = useState(null);
    const [submitting, setSubmitting] = useState(false);

    function update(field) {
        return (event) => setForm((previous) => ({ ...previous, [field]: event.target.value }));
    }

    async function handleSubmit(event) {
        event.preventDefault();

        // Mirrors the server's own rules (authValidator.js) so the common
        // mistakes cost no round trip. The server still validates everything —
        // this is convenience, never the enforcement.
        if (form.password.length < 8) {
            setError("Password must be at least 8 characters");
            return;
        }
        if (form.password !== form.confirmPassword) {
            setError("Passwords do not match");
            return;
        }

        setError(null);
        setSubmitting(true);
        try {
            await authService.registerSuperAdmin(form);
            // The server set the auth cookie on that same response, so the
            // account that was just created is already signed in. Refreshing
            // the auth context is what lets PublicOnlyRoute notice and send
            // them to the dashboard — this page deliberately doesn't navigate
            // itself, matching LoginForm, so two components never race to
            // decide where a newly-authenticated user lands.
            await refreshUser();
        } catch (err) {
            setError(err.message);
            setSubmitting(false);
        }
    }

    return (
        <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-indigo-50/40 px-4 py-8">
            <Card className="w-full max-w-md p-8">
                <h1 className="text-xl font-semibold text-slate-900">Set up your organisation</h1>
                <p className="mt-1 text-sm text-slate-500">
                    This creates the single administrator account that owns this deployment. Everyone else joins by
                    invitation from here.
                </p>

                <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
                    {error && (
                        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                            {error}
                        </p>
                    )}

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                            <label htmlFor="register-first-name" className={labelClasses}>
                                First name
                            </label>
                            <input
                                id="register-first-name"
                                type="text"
                                autoComplete="given-name"
                                required
                                value={form.firstName}
                                onChange={update("firstName")}
                                className={inputClasses}
                            />
                        </div>
                        <div>
                            <label htmlFor="register-last-name" className={labelClasses}>
                                Last name
                            </label>
                            <input
                                id="register-last-name"
                                type="text"
                                autoComplete="family-name"
                                required
                                value={form.lastName}
                                onChange={update("lastName")}
                                className={inputClasses}
                            />
                        </div>
                    </div>

                    <div>
                        <label htmlFor="register-email" className={labelClasses}>
                            Work email
                        </label>
                        <input
                            id="register-email"
                            type="email"
                            autoComplete="email"
                            required
                            value={form.email}
                            onChange={update("email")}
                            className={inputClasses}
                        />
                    </div>

                    <div>
                        <label htmlFor="register-password" className={labelClasses}>
                            Password
                        </label>
                        <PasswordInput
                            id="register-password"
                            autoComplete="new-password"
                            required
                            value={form.password}
                            onChange={update("password")}
                            className={inputClasses}
                        />
                        <p className="mt-1 text-xs text-slate-500">At least 8 characters.</p>
                    </div>

                    <div>
                        <label htmlFor="register-confirm-password" className={labelClasses}>
                            Confirm password
                        </label>
                        <PasswordInput
                            id="register-confirm-password"
                            autoComplete="new-password"
                            required
                            value={form.confirmPassword}
                            onChange={update("confirmPassword")}
                            className={inputClasses}
                        />
                    </div>

                    <div>
                        <label htmlFor="register-code" className={labelClasses}>
                            Registration code
                        </label>
                        <PasswordInput
                            id="register-code"
                            autoComplete="off"
                            required
                            value={form.registrationCode}
                            onChange={update("registrationCode")}
                            className={inputClasses}
                        />
                        {/* Said explicitly because there is nowhere else to find
                            it: the value is HR_REGISTRATION_CODE from the
                            server's own environment, so someone who deployed
                            this app already has it and someone who didn't
                            cannot proceed. */}
                        <p className="mt-1 text-xs text-slate-500">
                            The <code className="font-mono">HR_REGISTRATION_CODE</code> set in the server&apos;s
                            environment.
                        </p>
                    </div>

                    <Button type="submit" loading={submitting} className="w-full">
                        Create administrator account
                    </Button>
                </form>

                <p className="mt-6 text-center text-sm text-slate-500">
                    Already set up?{" "}
                    <Link to="/login" className="font-medium text-indigo-600 hover:text-indigo-700">
                        Sign in
                    </Link>
                </p>
            </Card>
        </div>
    );
}
