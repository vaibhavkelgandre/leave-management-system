import { useEffect, useState } from "react";
import { needsBootstrap as fetchNeedsBootstrap } from "../services/authService.js";

// Whether this deployment still has no SUPER_ADMIN, so nobody can sign in yet.
//
// Shared by LoginPage (which offers the setup route instead of a form no
// credential can satisfy) and BootstrapOnlyRoute (which sends anyone away from
// /register once an account exists) precisely so the two cannot disagree — a
// login page saying "set one up" next to a /register that redirects back to it
// is an infinite bounce, and reading one source is what prevents it.
//
// Output: `{ needsBootstrap, loaded }`. `needsBootstrap` stays `false` until
// the answer actually arrives, so nothing renders the setup path speculatively;
// callers wait on `loaded` before deciding anything.
export function useBootstrapStatus() {
    const [needsBootstrap, setNeedsBootstrap] = useState(false);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let cancelled = false;

        // The service never rejects — it answers `false` for an unreachable API
        // or an unmigrated database, so a network blip shows the ordinary login
        // form rather than a registration form to a stranger.
        fetchNeedsBootstrap().then((result) => {
            if (cancelled) return;
            setNeedsBootstrap(result);
            setLoaded(true);
        });

        return () => {
            cancelled = true;
        };
    }, []);

    return { needsBootstrap, loaded };
}
