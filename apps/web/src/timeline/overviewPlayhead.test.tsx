import { MantineProvider } from "@mantine/core";
import type * as MantineHooks from "@mantine/hooks";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { Timeline } from "./Timeline";

// jsdom has no layout: give the timeline a width.
vi.mock("@mantine/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof MantineHooks>()),
  useElementSize: () => ({ ref: () => undefined, width: 600, height: 0 }),
}));

const i18n = i18next.createInstance();
beforeAll(async () => {
  await initI18n("en", i18n);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** jsdom has no canvas: a 2D context stand-in that records each canvas's `moveTo` calls. */
function fakeContexts(): Map<HTMLCanvasElement, [number, number][]> {
  const moves = new Map<HTMLCanvasElement, [number, number][]>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    const calls: [number, number][] = moves.get(this) ?? [];
    moves.set(this, calls);
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === "measureText") return () => ({ width: 10 });
          if (prop === "clearRect") return () => calls.splice(0);
          if (prop === "moveTo") return (x: number, y: number) => calls.push([x, y]);
          return () => undefined;
        },
        set: () => true,
      },
    );
    return ctx as unknown as RenderingContext;
  });
  return moves;
}

describe("Timeline overview playhead", () => {
  it("draws the playhead on the overview at the playing position", () => {
    const moves = fakeContexts();
    const view = render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <Timeline
            lanes={[]}
            durationSec={60}
            getPosition={() => 30}
            playing={false}
            onSeek={() => undefined}
            hideLanes
          />
        </MantineProvider>
      </I18nextProvider>,
    );
    const head = screen.getByTestId<HTMLCanvasElement>("timeline-overview-playhead");
    // 30 s of 60 s on a 600 px overview: the middle (on the pixel centre).
    expect(moves.get(head)).toEqual([[300.5, 0]]);
    view.unmount();
  });
});
