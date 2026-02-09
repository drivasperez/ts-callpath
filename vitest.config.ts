import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/__tests__/**/*.test.ts", "visualiser/src/__tests__/**/*.unit.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "browser",
          include: ["visualiser/src/__tests__/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
