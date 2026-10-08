import type { MouseEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLICK_PAINT_ID,
  applyPaint,
  PaintStroke,
  paintProps,
  paintTargetOf,
  type PaintKind,
  type PaintPointerDown,
} from "./paintToggle";
import { useRehearse } from "./controller";

describe("PaintStroke", () => {
  it("sets each button of its kind once", () => {
    const s = new PaintStroke("solo", true);
    expect(s.visit({ kind: "solo", id: "a" })).toBe(true);
    expect(s.visit({ kind: "solo", id: "b" })).toBe(true);
    // Moving back over a button does not set it again.
    expect(s.visit({ kind: "solo", id: "a" })).toBe(false);
    expect(s.visit(null)).toBe(false);
  });

  it("ignores the other kind", () => {
    const s = new PaintStroke("mute", false);
    expect(s.visit({ kind: "solo", id: "a" })).toBe(false);
    expect(s.visit({ kind: "mute", id: "a" })).toBe(true);
  });
});

describe("paintTargetOf", () => {
  it("finds the button from an inner element", () => {
    document.body.innerHTML =
      '<button data-paint-kind="solo" data-paint-id="t1"><span id="in">S</span></button>' +
      '<div id="out"></div><button data-paint-kind="bogus" data-paint-id="x" id="bad"></button>';
    expect(paintTargetOf(document.getElementById("in"))).toEqual({ kind: "solo", id: "t1" });
    expect(paintTargetOf(document.getElementById("out"))).toBeNull();
    expect(paintTargetOf(document.getElementById("bad"))).toBeNull();
    expect(paintTargetOf(null)).toBeNull();
  });
});

/** Three buttons per kind in the DOM; `elementFromPoint` returns the one named by x. */
function setup() {
  const ids = ["a", "b", "c"];
  document.body.innerHTML = (["mute", "solo"] as const)
    .flatMap((k) =>
      ids.map((id) => `<button data-paint-kind="${k}" data-paint-id="${id}"></button>`),
    )
    .join("");
  const button = (kind: PaintKind, id: string) =>
    document.querySelector(`[data-paint-kind="${kind}"][data-paint-id="${id}"]`) as HTMLElement;
  // x encodes which button is under the pointer: 0–2 mute a–c, 10–12 solo a–c.
  document.elementFromPoint = (x: number) => {
    const kind = x >= 10 ? "solo" : "mute";
    return button(kind, ids[x % 10] ?? "");
  };
  const apply = vi.fn<(kind: PaintKind, id: string, value: boolean) => void>();
  const down = (
    kind: PaintKind,
    id: string,
    pressed: boolean,
    over: Partial<PaintPointerDown> = {},
  ) => {
    const p = paintProps(kind, id, pressed, apply);
    p.onPointerDown({
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      isPrimary: true,
      currentTarget: button(kind, id),
      ...over,
    });
    return p;
  };
  const move = (x: number, pointerId = 1) => {
    document.dispatchEvent(
      Object.assign(new Event("pointermove"), { clientX: x, clientY: 0, pointerId }),
    );
  };
  const up = (type = "pointerup") => {
    document.dispatchEvent(Object.assign(new Event(type), { pointerId: 1 }));
  };
  return { apply, down, move, up };
}

describe("paintProps drag", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("toggles the pressed button and sets (not toggles) the others to that value", () => {
    const { apply, down, move, up } = setup();
    down("solo", "a", false);
    expect(apply).toHaveBeenLastCalledWith("solo", "a", true);
    move(11);
    move(11);
    move(12);
    move(10);
    up();
    expect(apply.mock.calls).toEqual([
      ["solo", "a", true],
      ["solo", "b", true],
      ["solo", "c", true],
    ]);
  });

  it("paints one value per drag: starting on a pressed button clears", () => {
    const { apply, down, move, up } = setup();
    down("mute", "b", true);
    move(0);
    move(2);
    up();
    expect(apply.mock.calls.map((c) => c[2])).toEqual([false, false, false]);
  });

  it("keeps to its kind and stops at pointerup or pointercancel", () => {
    const { apply, down, move, up } = setup();
    down("mute", "a", false);
    move(11); // a solo button: not painted
    move(1);
    up("pointercancel");
    move(2);
    expect(apply.mock.calls).toEqual([
      ["mute", "a", true],
      ["mute", "b", true],
    ]);
  });

  it("ignores other pointers, secondary pointers and non-left mouse buttons", () => {
    const { apply, down, move, up } = setup();
    down("solo", "a", false, { isPrimary: false });
    down("solo", "a", false, { pointerType: "mouse", button: 2 });
    expect(apply).not.toHaveBeenCalled();
    down("solo", "a", false);
    move(11, 2);
    expect(apply).toHaveBeenCalledTimes(1);
    up();
  });

  it("releases an implicit touch capture so moves reach the other buttons", () => {
    const { down, up } = setup();
    const release = vi.fn();
    down("solo", "a", false, {
      currentTarget: {
        hasPointerCapture: () => true,
        releasePointerCapture: release,
      } as unknown as HTMLElement,
    });
    expect(release).toHaveBeenCalledWith(1);
    up();
  });

  it("the click after a press does nothing; keyboard activation toggles", () => {
    const apply = vi.fn();
    const p = paintProps("mute", "a", false, apply);
    p.onClick({ detail: 1 } as MouseEvent<HTMLElement>);
    expect(apply).not.toHaveBeenCalled();
    p.onClick({ detail: 0 } as MouseEvent<HTMLElement>);
    expect(apply).toHaveBeenCalledWith("mute", "a", true);
  });

  it("marks only the buttons for touch drags", () => {
    const p = paintProps("solo", "t1", false);
    expect(p["data-paint-kind"]).toBe("solo");
    expect(p["data-paint-id"]).toBe("t1");
    expect(p.style.touchAction).toBe("none");
  });
});

describe("applyPaint", () => {
  it("sets a track's mute/solo and the click's (M is the click off)", () => {
    useRehearse.setState({
      songId: "s1",
      previewSongId: null,
      mix: {
        tracks: { t1: { gainDb: 0, pan: 0, mute: false, solo: false } },
        click: { enabled: true, solo: false, gainDb: 0 },
      },
    } as never);
    applyPaint("mute", "t1", true);
    applyPaint("solo", "t1", true);
    expect(useRehearse.getState().mix.tracks.t1).toMatchObject({ mute: true, solo: true });
    applyPaint("mute", CLICK_PAINT_ID, true);
    applyPaint("solo", CLICK_PAINT_ID, true);
    expect(useRehearse.getState().mix.click).toMatchObject({ enabled: false, solo: true });
  });
});
