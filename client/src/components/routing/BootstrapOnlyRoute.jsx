import { Navigate, Outlet } from "react-router-dom";
import { useBootstrapStatus } from "../../hooks/useBootstrapStatus.js";
import { FullPageLoader } from "../common/FullPageLoader.jsx";

// Guards /register: the one-time setup page is reachable only while this
// deployment has no SUPER_ADMIN. Once one exists the route redirects to
// /login, so the page can't be bookmarked, linked to, or sat on — and a
// visitor who finds the URL never sees a form the server would refuse anyway
// (registerHrRoot answers 409 for a second attempt).
//
// Composed INSIDE PublicOnlyRoute in App.jsx, which matters: that outer guard
// owns post-authentication navigation for the whole app, so it is what sends
// the freshly-created admin to the dashboard rather than this guard bouncing
// them to /login on a now-stale answer.
//
// Waits for a definite answer before deciding. Rendering the form while the
// status is unknown would flash a registration page at every visitor on an
// already-set-up deployment.
export function BootstrapOnlyRoute({ children }) {
    const { needsBootstrap, loaded } = useBootstrapStatus();

    if (!loaded) {
        return <FullPageLoader />;
    }

    if (!needsBootstrap) {
        return <Navigate to="/login" replace />;
    }

    return children ?? <Outlet />;
}
