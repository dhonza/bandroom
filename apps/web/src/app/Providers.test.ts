import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { SESSION_QUERY_KEY } from "../auth/session";
import { useOnlineState } from "../offline/online";
import { createQueryClient, shouldRetry } from "./Providers";

const USER = { id: "u1", username: "alice" };

function unauthenticated(): ApiError {
  return new ApiError(401, { code: "UNAUTHENTICATED", message: "Login required" });
}

function failingQuery(client: ReturnType<typeof createQueryClient>, err: Error) {
  return client
    .query({ queryKey: ["projects"], queryFn: () => Promise.reject(err), retry: false })
    .catch(() => undefined);
}

describe("createQueryClient: expired sessions (SPEC §3)", () => {
  afterEach(() => {
    useOnlineState.setState({ online: true });
  });

  it("drops the session when a query fails with UNAUTHENTICATED", async () => {
    const client = createQueryClient();
    client.setQueryData(SESSION_QUERY_KEY, { user: USER });
    client.setQueryData(["songs", "s1"], { title: "Private" });
    await failingQuery(client, unauthenticated());
    expect(client.getQueryData(SESSION_QUERY_KEY)).toEqual({ user: null });
    expect(client.getQueryData(["songs", "s1"])).toBeUndefined();
  });

  it("drops the session when a mutation fails with UNAUTHENTICATED", async () => {
    const client = createQueryClient();
    client.setQueryData(SESSION_QUERY_KEY, { user: USER });
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(unauthenticated()) })
      .execute(undefined)
      .catch(() => undefined);
    expect(client.getQueryData(SESSION_QUERY_KEY)).toEqual({ user: null });
  });

  it("keeps the session for other errors", async () => {
    const client = createQueryClient();
    client.setQueryData(SESSION_QUERY_KEY, { user: USER });
    await failingQuery(client, new ApiError(403, { code: "WRONG_PASSWORD", message: "x" }));
    await failingQuery(client, new Error("boom"));
    expect(client.getQueryData(SESSION_QUERY_KEY)).toEqual({ user: USER });
  });

  it("keeps the session while offline", async () => {
    const client = createQueryClient();
    client.setQueryData(SESSION_QUERY_KEY, { user: USER });
    useOnlineState.setState({ online: false });
    await failingQuery(client, unauthenticated());
    expect(client.getQueryData(SESSION_QUERY_KEY)).toEqual({ user: USER });
  });
});

describe("shouldRetry", () => {
  afterEach(() => {
    useOnlineState.setState({ online: true });
  });
  const network = new ApiError(0, { code: "NETWORK", message: "offline" });
  const server = new ApiError(503, { code: "UNKNOWN", message: "bad gateway" });

  it("retries a network error once while online", () => {
    expect(shouldRetry(0, network)).toBe(true);
    expect(shouldRetry(1, network)).toBe(false);
    useOnlineState.setState({ online: false });
    expect(shouldRetry(0, network)).toBe(false);
  });

  it("retries a server error once", () => {
    expect(shouldRetry(0, server)).toBe(true);
    expect(shouldRetry(1, server)).toBe(false);
  });

  it("does not retry client errors or other failures", () => {
    expect(shouldRetry(0, new ApiError(404, { code: "NOT_FOUND", message: "x" }))).toBe(false);
    expect(shouldRetry(0, new ApiError(403, { code: "FORBIDDEN", message: "x" }))).toBe(false);
    expect(shouldRetry(0, unauthenticated())).toBe(false);
    expect(shouldRetry(0, new Error("parse"))).toBe(false);
  });
});
