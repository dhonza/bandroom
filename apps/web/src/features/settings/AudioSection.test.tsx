import type { ClientConfig } from "@bandroom/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/Providers";
import { CurrentUserContext } from "../../auth/session";
import { initI18n } from "../../i18n/i18n";
import { makeUser, mockApi } from "../../test/mockApi";
import { AudioSection } from "./AudioSection";

const config: ClientConfig = {
  appName: "B",
  version: "1",
  basePath: "",
  defaultLocale: "en",
  logoHash: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AudioSection: my instrument (SPEC §30.3)", () => {
  it("shows the instrument guessed from my tag and saves a chosen one", async () => {
    const user = makeUser({ instrumentTag: "Basa" });
    let sent: unknown = null;
    mockApi({
      "PATCH /me": (init) => {
        sent = JSON.parse(init?.body as string);
        return { body: { user: { ...user, instrument: "guitar" } } };
      },
    });
    const i18n = i18next.createInstance();
    await initI18n("en", i18n);
    render(
      <Providers config={config} i18n={i18n}>
        <CurrentUserContext.Provider value={user}>
          <AudioSection />
        </CurrentUserContext.Provider>
      </Providers>,
    );
    const select = await screen.findByDisplayValue("Automatic (Bass)");
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: "Guitar", hidden: true }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent).toEqual({ instrument: "guitar", instrumentTag: "Basa" });
    });
  });
});
