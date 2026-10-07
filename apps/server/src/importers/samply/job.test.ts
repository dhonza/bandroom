import { describe, expect, it } from "vitest";
import { REPORT_MAX_FAILED_ITEMS, REPORT_MAX_ITEMS, Reporter } from "./job";

describe("import Reporter", () => {
  it("bounds the stored items while keeping exact counts", () => {
    const r = new Reporter(false);
    const total = REPORT_MAX_ITEMS + 10;
    for (let i = 0; i < total; i++)
      r.item({ kind: "version", name: `ok ${i}`, outcome: "imported", reason: null });
    const failures = REPORT_MAX_FAILED_ITEMS + 100;
    for (let i = 0; i < failures; i++) {
      r.item({ kind: "version", name: `bad ${i}`, outcome: "failed", reason: "x" });
    }
    expect(r.report.counts["version.imported"]).toBe(total);
    expect(r.report.counts["version.failed"]).toBe(failures);
    const kept = r.report.items;
    expect(kept.filter((i) => i.outcome === "imported")).toHaveLength(REPORT_MAX_ITEMS);
    expect(kept.filter((i) => i.outcome === "failed")).toHaveLength(REPORT_MAX_FAILED_ITEMS);
  });
});
