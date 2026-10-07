import type { CurrentUser } from "@bandroom/shared";
import { vi } from "vitest";

export function makeUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: "u1",
    username: "jana",
    email: null,
    displayName: "Jana Nováková",
    globalRole: "admin",
    locale: null,
    theme: "dark",
    instrumentTag: "",
    docFontSize: 18,
    createdAt: 0,
    ...overrides,
  };
}

type Handler = (init: RequestInit | undefined) => { status?: number; body: unknown };

/** Routes `fetch` calls by "METHOD /path" (path without the /api/v1 prefix). */
export function mockApi(routes: Record<string, Handler>): ReturnType<typeof vi.fn> {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(raw, "http://localhost");
    const key = `${init?.method ?? "GET"} ${url.pathname.replace(/^.*\/api\/v1/, "")}`;
    const handler = routes[key];
    const { status = 200, body } = handler
      ? handler(init)
      : { status: 404, body: { code: "NOT_FOUND", message: key } };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
