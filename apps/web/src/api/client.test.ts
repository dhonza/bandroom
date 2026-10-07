import { getMeta } from "@bandroom/shared";
import { describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const meta = {
  instanceName: "B",
  version: "1",
  locales: ["en", "cs"],
  defaultLocale: "en",
  logoHash: null,
};

describe("api client", () => {
  it("prefixes the base path and sends the CSRF header", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, meta));
    const res = await api(getMeta, undefined, { fetchImpl, basePath: "/bandroom" });
    expect(res.instanceName).toBe("B");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/bandroom/api/v1/meta");
    expect((init?.headers as Record<string, string>)["X-Requested-With"]).toBe("bandroom");
  });

  it("throws ApiError with the server code", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(403, { code: "FORBIDDEN", message: "no" }));
    await expect(api(getMeta, undefined, { fetchImpl, basePath: "" })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
  });

  it("maps network failures to NETWORK", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await api(getMeta, undefined, { fetchImpl, basePath: "" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("NETWORK");
  });

  it("maps non-JSON errors to UNKNOWN", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("oops", { status: 502 }));
    await expect(api(getMeta, undefined, { fetchImpl, basePath: "" })).rejects.toMatchObject({
      status: 502,
      code: "UNKNOWN",
    });
  });
});
