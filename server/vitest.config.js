import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        globals: true,
        setupFiles: ["./src/tests/integration/setup.js"],
        fileParallelism: false,
        // Chosen, not inherited. Vitest's defaults (5s per test, 10s per hook)
        // are calibrated for pure unit tests; this suite is integration-level
        // against a real Postgres, where a single test routinely does a bcrypt
        // hash plus several HTTP round trips, and the beforeEach in setup.js
        // truncates twelve tables with CASCADE. Files here legitimately take
        // 10-20s each. On a contended machine (or a shared CI runner, which is
        // more contended than a laptop) the defaults are thin enough to expire
        // on work that is progressing normally — which reads as a real failure
        // and sends whoever sees it looking for a bug that isn't there.
        testTimeout: 30000,
        hookTimeout: 30000,
    },
});
