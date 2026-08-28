import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    // Pinned, and `strictPort` is the load-bearing half. By default Vite walks
    // to the next free port when 5173 is taken (a second `npm run dev`, or a
    // previous one that hadn't exited yet) and says so only in a line of
    // startup output that scrolls away — but the port is baked into two places
    // that don't move with it: the API's CLIENT_ORIGIN allowlist, and the
    // Authorized JavaScript origins of the Google OAuth client. So the app
    // loads normally on the drifted port and then fails at the only thing that
    // matters: every API call is refused by CORS (the response arrives without
    // an Access-Control-Allow-Origin header, so the browser discards it and the
    // session cookie is never stored), and Google refuses to issue an ID token
    // for an unregistered origin. That reads as "login is broken", which is a
    // long way from "the dev server is on a different port".
    //
    // With strictPort, a busy 5173 is a startup failure with the port in the
    // message instead. Change this only alongside CLIENT_ORIGIN and the Google
    // client's origins.
    server: {
        port: 5173,
        strictPort: true,
    },
    test: {
        globals: true,
        environment: "jsdom",
        setupFiles: "./src/tests/setup.js",
        // Worker threads, not vitest's default child-process forks. Forking one
        // node process per test file — 63 of them, each loading Vite's module
        // graph and booting jsdom — is the heaviest possible shape, and on this
        // machine it fails: running the client suite immediately after the
        // server suite produced six "Failed to start forks worker" errors, so
        // six files never ran at all while the run still reported green-ish.
        // A suite that silently skips files is worse than a slow one. Threads
        // share the process, so startup is cheap enough to survive a machine
        // that's still busy.
        pool: "threads",
        // Chosen, not inherited — same reasoning as server/vitest.config.js.
        // The expensive thing here is userEvent.type, which dispatches a full
        // key event cycle per character and re-renders between each, so typing
        // one realistic sentence into a form is dozens of sequential React
        // renders in jsdom. Well under the 5s default when the machine is
        // idle, and over it when it isn't.
        testTimeout: 15000,
    },
});
