import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "brctl",
    environment: "node",
  },
});
