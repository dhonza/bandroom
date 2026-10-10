import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { layoutFor } from "./model";
import { TopLaneLabels } from "./TimelineMarkers";
import type { Marker } from "@bandroom/shared";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await initI18n("en", i18n);
});

const marker = { type: "marker", lane: 0 } as Marker;
const section = { type: "section", lane: 0 } as Marker;

function labels(
  markers: Marker[],
  commentsHeight: number,
  opts: Parameters<typeof layoutFor>[2] = {},
) {
  const view = render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <TopLaneLabels layout={layoutFor(markers, false, opts)} commentsHeight={commentsHeight} />
      </MantineProvider>
    </I18nextProvider>,
  );
  const shown = ["signature", "sections", "markers", "comments"].filter(
    (k) => screen.queryByTestId(`lane-label-${k}`) !== null,
  );
  view.unmount();
  return shown;
}

describe("top lane labels (SPEC §11.3, §31.4)", () => {
  it("labels only the lanes with items; markers have no lane (they are on the ruler)", () => {
    expect(labels([marker], 28)).toEqual(["comments"]);
    expect(labels([section], 0)).toEqual(["sections"]);
    expect(labels([section, marker], 28)).toEqual(["sections", "comments"]);
    expect(labels([], 0)).toEqual([]);
  });

  it("has no label for a hidden lane", () => {
    expect(labels([section, marker], 28, { hidden: { sections: true } })).toEqual(["comments"]);
  });
});
