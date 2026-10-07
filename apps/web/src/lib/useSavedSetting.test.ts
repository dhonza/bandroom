import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSavedSetting } from "./useSavedSetting";

/** A save whose completion the test controls; `saved` is what the server ends up with. */
function fakeServer(initial: number) {
  const pending: { value: number; resolve: () => void; reject: () => void }[] = [];
  const server = { saved: initial, requests: [] as number[] };
  const save = (value: number) =>
    new Promise<void>((resolve, reject) => {
      server.requests.push(value);
      pending.push({
        value,
        resolve: () => {
          server.saved = value;
          resolve();
        },
        reject,
      });
    });
  return { server, save, pending };
}

function setup(initial: number) {
  const fake = fakeServer(initial);
  const hook = renderHook(({ saved }) => useSavedSetting(saved, fake.save), {
    initialProps: { saved: initial },
  });
  const value = () => hook.result.current[0];
  /** Like a keyboard step on a slider: change and commit from the shown value. */
  const step = (delta: number) => {
    act(() => {
      const next = value() + delta;
      hook.result.current[1](next);
      hook.result.current[2](next);
    });
  };
  /** The save completes; the saved value reaches the component a render later (query cache). */
  const finish = async (i: number) => {
    await act(async () => {
      fake.pending[i]?.resolve();
      await Promise.resolve();
    });
    hook.rerender({ saved: fake.server.saved });
  };
  return { ...fake, hook, value, step, finish };
}

describe("useSavedSetting", () => {
  it("keeps a quick second step instead of reverting to the stale saved value", async () => {
    const s = setup(18);
    s.step(1);
    expect(s.value()).toBe(19);
    // The first save completes before the saved value has caught up: still 19, not 18.
    await act(async () => {
      s.pending[0]?.resolve();
      await Promise.resolve();
    });
    expect(s.value()).toBe(19);
    s.step(1);
    expect(s.value()).toBe(20);
    s.hook.rerender({ saved: s.server.saved });
    await s.finish(1);
    expect(s.server.requests).toEqual([19, 20]);
    expect(s.server.saved).toBe(20);
    expect(s.value()).toBe(20);
  });

  it("runs saves one at a time with the latest value last", async () => {
    const s = setup(18);
    s.step(1);
    s.step(1);
    s.step(1);
    expect(s.value()).toBe(21);
    expect(s.server.requests).toEqual([19]);
    await s.finish(0);
    // The older saved value does not show while the newer one is pending.
    expect(s.value()).toBe(21);
    expect(s.server.requests).toEqual([19, 21]);
    await s.finish(1);
    expect(s.server.saved).toBe(21);
    expect(s.value()).toBe(21);
  });

  it("goes back to the saved value after a failed save, and skips saving an unchanged value", async () => {
    const s = setup(18);
    s.step(1);
    await act(async () => {
      s.pending[0]?.reject();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(s.value()).toBe(18);
    act(() => {
      s.hook.result.current[1](18);
      s.hook.result.current[2](18);
    });
    expect(s.server.requests).toEqual([19]);
    expect(s.value()).toBe(18);
  });
});
