import { describe, expect, it } from "vitest";
import { defaultExpiry, endOfDay, linkSummaryKeys, statParts, toDateInput } from "./model";

describe("link model", () => {
  it("round-trips dates through the date input at the end of the local day", () => {
    const ms = endOfDay("2026-10-13");
    expect(ms).not.toBeNull();
    const d = new Date(ms ?? 0);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([
      2026, 9, 13, 23, 59,
    ]);
    expect(toDateInput(ms ?? 0)).toBe("2026-10-13");
    expect(endOfDay("")).toBeNull();
    expect(endOfDay("13.10.2026")).toBeNull();
  });

  it("defaults to two weeks ahead", () => {
    const now = new Date(2026, 8, 29, 12).getTime();
    expect(defaultExpiry(now)).toBe("2026-10-13");
  });

  it("summarizes scope, content and versions", () => {
    expect(linkSummaryKeys({ scopeType: "song", content: "mix-only", versions: "all" })).toEqual([
      "links.scope.song",
      "links.content.mix-only",
      "links.versions.all",
    ]);
    expect(
      linkSummaryKeys({ scopeType: "versions", content: "all-tracks", versions: "all" }),
    ).toEqual(["links.scope.versions"]);
  });

  it("lists opens and the non-zero stats", () => {
    expect(
      statParts({
        opens: 0,
        visitors: 0,
        plays: 3,
        downloads: 0,
        comments: 1,
        passwordFailures: 0,
        lastAccessAt: null,
      }),
    ).toEqual([
      { key: "opens", count: 0 },
      { key: "plays", count: 3 },
      { key: "comments", count: 1 },
    ]);
  });
});
