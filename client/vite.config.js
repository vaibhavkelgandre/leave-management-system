import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    test: {
        globals: true,
        environment: "jsdom",
        setupFiles: "./src/tests/setup.js",
        // Chosen, not inherited — same reasoning as server/vitest.config.js.
        // The expensive thing here is userEvent.type, which dispatches a full
        // key event cycle per character and re-renders between each, so typing
        // one realistic sentence into a form is dozens of sequential React
        // renders in jsdom. Well under the 5s default when the machine is
        // idle, and over it when it isn't.
        testTimeout: 15000,
    },
});
