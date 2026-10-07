import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { initI18n } from "../../../i18n/i18n";
import type { Square } from "./crop";
import { fetchImageUrl } from "./fetchImageUrl";
import { nameFromUrl, withScheme } from "./ProjectImageDialogs";
import { SquareCropper } from "./SquareCropper";

const i18n = i18next.createInstance();

describe("image URL helpers", () => {
  it("adds https:// when the scheme is missing", () => {
    expect(withScheme(" example.com/a.png ")).toBe("https://example.com/a.png");
    expect(withScheme("http://x.test/a.png")).toBe("http://x.test/a.png");
    expect(withScheme("ftp://x.test/a.png")).toBe("ftp://x.test/a.png");
  });

  it("names the file after the URL path", () => {
    expect(nameFromUrl("https://x.test/art/My%20Cover.jpg?w=10")).toBe("My Cover.jpg");
    expect(nameFromUrl("https://x.test/")).toBe("image");
    expect(nameFromUrl("not a url")).toBe("image");
  });
});

describe("fetchImageUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the URL with the CSRF header and returns the image", async () => {
    const fetch = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetch);
    const blob = await fetchImageUrl("p1", "https://x.test/a.png");
    expect(blob.size).toBe(3);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toContain("/api/v1/projects/p1/image/fetch");
    expect(init).toMatchObject({ method: "POST", body: '{"url":"https://x.test/a.png"}' });
    expect(init?.headers).toMatchObject({ "X-Requested-With": "bandroom" });
  });

  it("turns refusals and network failures into API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ code: "IMAGE_URL_BLOCKED", message: "no" }, { status: 400 }),
        ),
      ),
    );
    const refused = await fetchImageUrl("p1", "http://10.0.0.1/").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe("IMAGE_URL_BLOCKED");

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("offline"))),
    );
    const offline = await fetchImageUrl("p1", "https://x.test/").catch((e: unknown) => e);
    expect((offline as ApiError).code).toBe("NETWORK");
  });
});

function Harness({ onSquare }: { onSquare: (s: Square) => void }) {
  const [value, setValue] = useState<Square>({ x: 50, y: 0, size: 100 });
  return (
    <SquareCropper
      src="data:,"
      bounds={{ width: 200, height: 100 }}
      value={value}
      onChange={(s) => {
        setValue(s);
        onSquare(s);
      }}
      maxHeight={400}
    />
  );
}

describe("SquareCropper", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });

  it("moves and resizes with the keyboard and has 44 px corner handles", () => {
    const onSquare = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <Harness onSquare={onSquare} />
        </MantineProvider>
      </I18nextProvider>,
    );
    const selection = screen.getByTestId("crop-selection");
    expect(selection).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(selection, { key: "ArrowRight" });
    expect(onSquare).toHaveBeenLastCalledWith({ x: 51, y: 0, size: 100 });
    fireEvent.keyDown(selection, { key: "ArrowLeft", shiftKey: true });
    expect(onSquare).toHaveBeenLastCalledWith({ x: 41, y: 0, size: 100 });
    fireEvent.keyDown(selection, { key: "-", shiftKey: true });
    expect(onSquare).toHaveBeenLastCalledWith({ x: 51, y: 10, size: 80 });
    fireEvent.keyDown(selection, { key: "Tab" });
    expect(onSquare).toHaveBeenCalledTimes(3);
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const handle = screen.getByTestId(`crop-handle-${corner}`);
      expect(handle.style.width).toBe("44px");
      expect(handle.style.height).toBe("44px");
    }
  });
});
