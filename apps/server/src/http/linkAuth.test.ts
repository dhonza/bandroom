import { setLinkVisitorName } from "@bandroom/shared";
import Fastify, { type RouteOptions as FastifyRouteOptions } from "fastify";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../context";
import { registerLinkContract } from "./linkAuth";

describe("registerLinkContract", () => {
  it("passes the body limit and rate limit to the route", () => {
    const app = Fastify();
    const routes: FastifyRouteOptions[] = [];
    app.addHook("onRoute", (r) => {
      routes.push(r);
    });
    const limit = { max: 3, timeWindow: "1 minute" };
    registerLinkContract(app, {} as AppContext, setLinkVisitorName, () => ({ ok: true as const }), {
      bodyLimit: 1234,
      rateLimit: limit,
    });
    const route = routes.find((r) => r.url.endsWith(setLinkVisitorName.path));
    expect(route?.bodyLimit).toBe(1234);
    expect((route?.config as { rateLimit?: unknown } | undefined)?.rateLimit).toEqual(limit);
  });
});
