import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { uploadOptions, useUploadPrefs } from "./prefs";
import { UploadSettings } from "./UploadSettings";

const i18n = i18next.createInstance();

const wrap = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <UploadSettings testId="a" />
        <UploadSettings testId="b" />
      </MantineProvider>
    </I18nextProvider>,
  );

describe("upload settings (SPEC §28.2)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    useUploadPrefs.getState().set({ lossyOnly: false, quality: "standard" });
    localStorage.clear();
  });

  it("defaults to keeping full quality and sends no options then", () => {
    wrap();
    expect(screen.getByTestId("a")).toHaveTextContent("Keep full quality");
    expect(uploadOptions()).toBeUndefined();
  });

  it("turns on lossy upload at a preset, for every control, remembered on this device", async () => {
    wrap();
    await userEvent.click(screen.getByTestId("a"));
    await userEvent.click(await screen.findByTestId("upload-lossy-only"));
    await userEvent.click(screen.getByTestId("upload-quality"));
    await userEvent.click(
      await screen.findByRole("option", {
        name: "High · 128 kbps stereo / 80 kbps mono",
        hidden: true,
      }),
    );
    expect(screen.getByTestId("b")).toHaveTextContent(
      "Lossy on upload · 128 kbps stereo / 80 kbps mono",
    );
    expect(screen.getByTestId("b").getAttribute("data-lossy")).toBe("true");
    expect(uploadOptions()).toEqual({ lossyOnly: true, quality: "high" });
    expect(JSON.parse(localStorage.getItem("bandroom.uploadOptions") ?? "null")).toEqual({
      lossyOnly: true,
      quality: "high",
    });
  });
});
