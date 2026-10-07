import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "i18n-check",
    environment: "node",
  },
});
