import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { setOptimistic } from "./optimistic";

describe("setOptimistic", () => {
  it("keeps the optimistic value when a stale refetch was in flight", async () => {
    const qc = new QueryClient();
    const key = ["songs", "p1"];
    qc.setQueryData(key, { order: ["a", "b"] });
    let respond: (v: { order: string[] }) => void = () => undefined;
    // A refetch that started before the change and would answer with the old order.
    const fetching = qc
      .query({
        queryKey: key,
        queryFn: () => new Promise<{ order: string[] }>((r) => (respond = r)),
        staleTime: 0,
      })
      .catch(() => undefined);
    setOptimistic<{ order: string[] }>(qc, key, { order: ["b", "a"] });
    respond({ order: ["a", "b"] });
    await fetching;
    expect(qc.getQueryData(key)).toEqual({ order: ["b", "a"] });
    expect(qc.getQueryState(key)?.fetchStatus).toBe("idle");
  });

  it("applies an updater function to the current data", () => {
    const qc = new QueryClient();
    qc.setQueryData(["n"], 1);
    setOptimistic<number>(qc, ["n"], (old) => (old ?? 0) + 1);
    expect(qc.getQueryData(["n"])).toBe(2);
  });
});
