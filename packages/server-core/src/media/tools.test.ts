import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_TIME_LIMIT_MS,
  mediaTimeLimitMs,
  runTool,
  ToolTimeoutError,
  withTimeLimit,
} from "./tools";

describe("media tool time limits (review M4)", () => {
  it("budgets 10× real time plus 5 minutes, capped", () => {
    expect(mediaTimeLimitMs(0)).toBe(5 * 60_000);
    expect(mediaTimeLimitMs(180)).toBe(180 * 10_000 + 5 * 60_000);
    expect(mediaTimeLimitMs(Number.NaN)).toBe(5 * 60_000);
    expect(mediaTimeLimitMs(24 * 3600)).toBe(MAX_MEDIA_TIME_LIMIT_MS);
  });

  it("kills a tool that runs past its limit and reports a timeout", async () => {
    const started = Date.now();
    const run = runTool("sleep", ["10"], {
      signal: withTimeLimit(new AbortController().signal, 100),
      nice: false,
    });
    await expect(run).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports an ordinary abort as such, not as a timeout", async () => {
    const ac = new AbortController();
    const run = runTool("sleep", ["10"], { signal: withTimeLimit(ac.signal, 60_000), nice: false });
    ac.abort();
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ToolTimeoutError);
  });
});
