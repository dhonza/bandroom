import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { Timeline } from "./Timeline";
import type * as MantineHooks from "@mantine/hooks";

// jsdom has no layout: give the timeline a width so it has a view to seek in.
vi.mock("@mantine/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof MantineHooks>()),
  useElementSize: () => ({ ref: () => undefined, width: 600, height: 0 }),
}));

const i18n = i18next.createInstance();
beforeAll(async () => {
  await initI18n("en", i18n);
  Element.prototype.setPointerCapture = () => undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function renderTimeline(onSeek: (sec: number) => void, playing = false) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <Timeline
          lanes={[]}
          durationSec={60}
          getPosition={() => 0}
          playing={playing}
          onSeek={onSeek}
        />
      </MantineProvider>
    </I18nextProvider>,
  );
}

const pointer = { pointerId: 1, pointerType: "touch", button: 0, clientX: 300, clientY: 40 };

describe("Timeline detail gestures", () => {
  it("seeks on a tap", () => {
    const onSeek = vi.fn();
    const view = renderTimeline(onSeek);
    const detail = screen.getByTestId("timeline-detail");
    fireEvent.pointerDown(detail, pointer);
    fireEvent.pointerUp(detail, pointer);
    expect(onSeek).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("ignores a release of a pointer that never went down on the view", () => {
    const onSeek = vi.fn();
    const view = renderTimeline(onSeek);
    const detail = screen.getByTestId("timeline-detail");
    fireEvent.pointerUp(detail, pointer);
    expect(onSeek).not.toHaveBeenCalled();
    // A right click goes down without starting a gesture; its release is no tap either.
    fireEvent.pointerDown(detail, { ...pointer, pointerType: "mouse", button: 2 });
    fireEvent.pointerUp(detail, { ...pointer, pointerType: "mouse", button: 2 });
    expect(onSeek).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not seek when Recenter is pressed", () => {
    const onSeek = vi.fn();
    const view = renderTimeline(onSeek, true);
    const detail = screen.getByTestId("timeline-detail");
    // Zooming turns following off, which shows the Recenter button while playing.
    fireEvent.wheel(detail, { ctrlKey: true, deltaY: -100, clientX: 300 });
    const recenter = screen.getByRole("button", { name: "Follow playhead" });
    fireEvent.pointerDown(recenter, pointer);
    fireEvent.pointerUp(recenter, pointer);
    fireEvent.click(recenter);
    expect(onSeek).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Follow playhead" })).toBeNull();
    view.unmount();
  });
});
