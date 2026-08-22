import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
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
