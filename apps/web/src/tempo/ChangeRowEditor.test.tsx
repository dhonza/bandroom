import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { ChangeRowEditor } from "./ChangeRowEditor";
import type { ChangeRow } from "./model";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await initI18n("en", i18n);
});

const row: ChangeRow = { id: "r", bar: 5, beat: 1, bpm: null, meter: null, cutBar: 3 };

function show(r: ChangeRow, cut?: { beats: number; of: number } | null) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <ChangeRowEditor
          row={r}
          coarse={false}
          invalid={false}
          cut={cut}
          onChange={() => undefined}
          onRemove={() => undefined}
        />
      </MantineProvider>
    </I18nextProvider>,
  );
}

describe("change row after a cut-short bar (SPEC §24.4)", () => {
  it("shows the cut and keeps bar and beat", () => {
    show({ ...row, bpm: 100 }, { beats: 3, of: 4 });
    expect(screen.getByTestId("tempo-change-cut").getAttribute("aria-label")).toBe(
      "Bar cut short by an edit: 3 of 4 beats",
    );
    expect(screen.getByLabelText("Bar")).toHaveProperty("readOnly", true);
    expect(screen.getByLabelText("Beat")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("BPM")).toHaveProperty("disabled", false);
  });

  it("falls back to a plain label and shows nothing on other rows", () => {
    const { unmount } = show(row, null);
    expect(screen.getByTestId("tempo-change-cut").getAttribute("aria-label")).toBe(
      "Bar cut short by an edit",
    );
    unmount();
    show({ ...row, cutBar: undefined, bpm: 100 });
    expect(screen.queryByTestId("tempo-change-cut")).toBeNull();
    expect(screen.getByLabelText("Bar")).toHaveProperty("readOnly", false);
  });
});
