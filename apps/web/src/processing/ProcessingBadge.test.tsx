import type { ClientConfig, Processing } from "@bandroom/shared";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { Providers } from "../app/Providers";
import { initI18n } from "../i18n/i18n";
import { ProcessingBadge } from "./ProcessingBadge";
import { isActive } from "./queries";

const config: ClientConfig = {
  appName: "B",
  version: "1",
  basePath: "",
  defaultLocale: "en",
  logoHash: null,
};

const none: Processing = { queued: 0, processing: 0, failed: 0, progress: null, mix: null };

async function badge(p: Processing | undefined) {
  const i18n = i18next.createInstance();
  await initI18n("en", i18n);
  const view = render(
    <Providers config={config} i18n={i18n}>
      <ProcessingBadge processing={p} />
    </Providers>,
  );
  const el = screen.queryByTestId("processing-badge");
  const out = el ? { state: el.getAttribute("data-state"), text: el.textContent } : null;
  view.unmount();
  return out;
}

describe("ProcessingBadge (SPEC §25.3)", () => {
  it("shows nothing when all is done", async () => {
    expect(await badge(undefined)).toBeNull();
    expect(await badge(none)).toBeNull();
  });

  it("failed wins, then processing with percent, waiting, the mix", async () => {
    expect(await badge({ ...none, failed: 1, processing: 2 })).toEqual({
      state: "failed",
      text: "1 failed",
    });
    expect(await badge({ ...none, processing: 2, queued: 3, progress: 0.42 })).toEqual({
      state: "processing",
      text: "Processing 42%",
    });
    expect(await badge({ ...none, queued: 3 })).toEqual({ state: "queued", text: "3 waiting" });
    expect(await badge({ ...none, mix: "queued" })).toEqual({
      state: "mix",
      text: "Preparing mix",
    });
  });

  it("only queued and running work counts as active", () => {
    expect(isActive(undefined)).toBe(false);
    expect(isActive({ ...none, failed: 2 })).toBe(false);
    expect(isActive({ ...none, queued: 1 })).toBe(true);
    expect(isActive({ ...none, mix: "processing" })).toBe(true);
  });
});
