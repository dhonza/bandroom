import { MantineProvider } from "@mantine/core";
import { render } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { cssColor, setupCanvas } from "./render";
import { Timeline } from "./Timeline";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await initI18n("en", i18n);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("canvas helpers", () => {
  it("caches resolved colors per color scheme", () => {
    const spy = vi.spyOn(window, "getComputedStyle");
    document.documentElement.style.setProperty("--test-a", "#123456");
    document.documentElement.setAttribute("data-mantine-color-scheme", "dark");
    expect(cssColor("--test-a")).toBe("#123456");
    expect(cssColor("--test-a")).toBe("#123456");
    expect(spy).toHaveBeenCalledTimes(1);
    document.documentElement.setAttribute("data-mantine-color-scheme", "light");
    expect(cssColor("--test-a")).toBe("#123456");
    expect(spy).toHaveBeenCalledTimes(2);
    // Unresolved variables are not cached (the stylesheet may not be there yet).
    expect(cssColor("--test-missing", "#f00")).toBe("#f00");
    expect(cssColor("--test-missing", "#f00")).toBe("#f00");
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("writes the canvas size styles only when they change", () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(null);
    let writes = 0;
    const style = canvas.style;
    let width = "";
    Object.defineProperty(style, "width", {
      get: () => width,
      set: (v: string) => {
        writes++;
        width = v;
      },
    });
    setupCanvas(canvas, 300, 100);
    setupCanvas(canvas, 300, 100);
    expect(writes).toBe(1);
    setupCanvas(canvas, 320, 100);
    expect(writes).toBe(2);
    expect(canvas.style.width).toBe("320px");
  });
});

describe("Timeline animation", () => {
  const timeline = (playing: boolean) => (
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <Timeline
          lanes={[]}
          durationSec={60}
          getPosition={() => 0}
          playing={playing}
          onSeek={() => undefined}
        />
      </MantineProvider>
    </I18nextProvider>
  );

  it("runs no animation frames while paused", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const view = render(timeline(false));
    expect(raf).not.toHaveBeenCalled();
    view.rerender(timeline(true));
    expect(raf).toHaveBeenCalled();
    view.unmount();
  });
});
