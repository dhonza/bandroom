import type { ClientConfig } from "@bandroom/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { afterEach, describe, expect, it } from "vitest";
import { Providers } from "../../app/Providers";
import { initI18n } from "../../i18n/i18n";
import { resetListenEngineForTests } from "../../player/listenEngine";
import { useListen } from "../../player/listenStore";
import { ListenOptions } from "./ListenOptions";

const config: ClientConfig = {
  appName: "B",
  version: "1",
  basePath: "",
  defaultLocale: "en",
  logoHash: null,
};

async function renderOptions() {
  const i18n = i18next.createInstance();
  await initI18n("en", i18n);
  render(
    <Providers config={config} i18n={i18n}>
      <ListenOptions />
    </Providers>,
  );
}

describe("ListenOptions", () => {
  afterEach(() => {
    useListen.setState({ repeat: "off", quality: "high" });
    resetListenEngineForTests();
  });

  it("cycles repeat off → all → one → off", async () => {
    await renderOptions();
    const button = screen.getByTestId("listen-repeat");
    expect(button).toHaveAccessibleName("Repeat off");
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(useListen.getState().repeat).toBe("all");
    expect(button).toHaveAccessibleName("Repeat all songs");
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(useListen.getState().repeat).toBe("one");
    fireEvent.click(button);
    expect(useListen.getState().repeat).toBe("off");
  });

  it("switches quality from the menu and remembers it", async () => {
    await renderOptions();
    fireEvent.click(screen.getByTestId("listen-quality"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Low (saves mobile data)" }));
    expect(useListen.getState().quality).toBe("low");
    expect(localStorage.getItem("bandroom.listenQuality")).toBe("low");
    expect(screen.getByTestId("listen-quality")).toHaveAccessibleName("Quality: Low");
  });
});
