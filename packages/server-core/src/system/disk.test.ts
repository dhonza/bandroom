import os from "node:os";
import { describe, expect, it } from "vitest";
import { diskUsage } from "./disk";

describe("diskUsage", () => {
  it("reports positive sizes", async () => {
    const u = await diskUsage(os.tmpdir());
    expect(u.totalBytes).toBeGreaterThan(0);
    expect(u.freeBytes).toBeGreaterThan(0);
    expect(u.freeBytes).toBeLessThanOrEqual(u.totalBytes);
  });
});
