import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { renderErrorText } from "./renderError";

const en = i18next.createInstance();
const cs = i18next.createInstance();

beforeAll(async () => {
  await initI18n("en", en);
  await initI18n("cs", cs);
});

describe("renderErrorText (SPEC §24.14)", () => {
  it("translates the server's stable errors and keeps the others", () => {
    expect(renderErrorText("EDIT_STALLED: no worker job moved it on for 10 minutes", en.t)).toBe(
      "Processing stopped making progress. Retry or cancel.",
    );
    expect(renderErrorText("lease expired", cs.t)).toBe(cs.t("edit.progress.error.workerStopped"));
    expect(cs.t("edit.progress.error.workerStopped")).not.toMatch(/^edit\./);
    expect(renderErrorText("QUOTA_EXCEEDED: no space", en.t)).toBe("QUOTA_EXCEEDED: no space");
    expect(renderErrorText(null, en.t)).toBeNull();
  });
});
