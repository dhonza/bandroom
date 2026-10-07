import { describe, expect, it } from "vitest";
import { setupUploadFixtures, songId, t } from "../testing/uploadFixtures";

setupUploadFixtures();

describe("internal events", () => {
  it("requires the shared secret", async () => {
    const payload = { events: [{ type: "job.progress", songId, data: { progress: 0.5 } }] };
    expect(
      (await t.app.inject({ method: "POST", url: "/internal/events", payload })).statusCode,
    ).toBe(404);
    for (const secret of ["wrong", "dev-only-internal-events-secret-012345678"]) {
      const res = await t.app.inject({
        method: "POST",
        url: "/internal/events",
        headers: { "x-internal-secret": secret },
        payload,
      });
      expect(res.statusCode).toBe(404);
    }
    const ok = await t.app.inject({
      method: "POST",
      url: "/internal/events",
      headers: { "x-internal-secret": "dev-only-internal-events-secret-0123456789" },
      payload,
    });
    expect(ok.statusCode).toBe(204);
  });
});
