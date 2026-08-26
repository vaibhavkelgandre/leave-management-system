import { Link } from "react-router-dom";
import { LoginForm } from "../components/auth/LoginForm.jsx";
import { Card } from "../components/ui/Card.jsx";
import { useBootstrapStatus } from "../hooks/useBootstrapStatus.js";

export function LoginPage() {
    const { needsBootstrap } = useBootstrapStatus();

    return (
        <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-indigo-50/40 px-4">
            <Card className="w-full max-w-sm p-8">
                <h1 className="mb-1 text-xl font-semibold text-slate-900">Sign in</h1>
                <p className="mb-6 text-sm text-slate-500">Leave Management System</p>

                {/* A fresh deployment has no account at all, so the form below
                    it cannot be satisfied by any credential — without this
                    panel the first visitor's only recourse is reading the
                    README and POSTing to the API by hand.

                    Shown alongside the form rather than redirecting to
                    /register: someone who mistyped a URL, or who is checking
                    whether their own account exists yet, should still land
                    somewhere recognisable. The hook answers `false` until it
                    knows, so nothing flashes on a normal deployment. */}
                {needsBootstrap && (
                    <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-3">
                        <p className="text-sm font-medium text-amber-900">No administrator account yet</p>
                        <p className="mt-1 text-sm text-amber-800">
                            Nobody can sign in until this deployment has its first administrator. Set one up, then
                            invite everyone else from inside the app.
                        </p>
                        <Link
                            to="/register"
                            className="mt-2 inline-block text-sm font-semibold text-amber-900 underline hover:no-underline"
                        >
                            Register as super admin
                        </Link>
                    </div>
                )}

                <LoginForm />
            </Card>
        </div>
    );
}
