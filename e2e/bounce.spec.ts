import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { FIXTURES_DIR, generateFixtures } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, openMixer, tracksReady, uniqueUsername } from "./helpers";

/**
 * Bounce (SPEC §5.5, §27.5): the mix the user hears (here with one track muted) becomes a new
 * one-track song right after the source; the notification opens it, it shows its processing
 * state, and once rendered and ingested it plays in the Player. By default it gets the source's
 * tempo map and markers (dialog options, owner decisions 2026-10-07).
 */

test.beforeAll(async () => {
  await generateFixtures();
});

interface DebugState {
  songId: string | null;
  status: string;
  tracks: { id: string; version: string }[];
}

const debug = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => DebugState } }
      ).__bandroomRehearse?.state() ?? null,
  );

test("bounce a mix with a muted track into a new song that plays", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(600_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, request, testInfo, "member");

  await page.goto("library");
  await page.getByTestId("new-project").click();
  const projectName = `Bounce ${uniqueUsername(testInfo)}`;
  await page.getByLabel("Name").fill(projectName);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Two takes");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Two takes" }).getByRole("link").click();
  await expect(page).toHaveURL(/songs\//);
  const sourceUrl = page.url();
  const sourceId = /songs\/([^/?#]+)/.exec(sourceUrl)?.[1] ?? "";
  // A tempo map and a marker, which the bounce copies by default (SPEC §5.5).
  const api = { headers: { "X-Requested-With": "bandroom" } };
  const tempo = {
    map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 } }] },
    bar1OffsetSec: 0.5,
  };
  expect(
    (await page.request.put(`api/v1/songs/${sourceId}/tempo`, { ...api, data: tempo })).status(),
  ).toBe(200);
  const marker = { type: "marker", name: "Break", color: "red", startSec: 2.5 };
  expect(
    (
      await page.request.post(`api/v1/songs/${sourceId}/markers`, { ...api, data: marker })
    ).status(),
  ).toBe(200);
  await page.reload();

  await page
    .getByTestId("track-dropzone")
    .locator('input[type="file"]')
    .setInputFiles(
      ["imp_48000_s16_stereo", "imp_48000_s16_mono"].map((f) =>
        path.join(FIXTURES_DIR, `${f}.wav`),
      ),
    );
  const rows = page.getByTestId("track-row");
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  // One worker serves all parallel tests on this server.
  await expect(rows.filter({ hasText: "kHz" })).toHaveCount(2, { timeout: 420_000 });

  // Mute the first track in the Mixer.
  await openMixer(page);
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");
  const strips = page.getByTestId("track-headers").getByTestId("track-strip");
  await expect(strips).toHaveCount(2);
  await strips.nth(0).getByTestId("track-mute").click();
  const loaded = (await debug(page))?.tracks ?? [];
  expect(loaded).toHaveLength(2);

  // Phones use the transport's ⋯ menu, other screens the mixer tools.
  if (phone) {
    await page.getByRole("button", { name: "Playback options" }).click();
    await page.getByTestId("transport-bounce").click();
  } else {
    await page.getByTestId("mixer-bounce").click();
  }
  const title = page.getByTestId("bounce-title");
  await expect(title).toHaveValue("Two takes (bounce)");
  if (phone) {
    // The dialog fits the phone screen (no horizontal scrolling).
    // Polled: the closing ⋯ menu may stick out for a moment.
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
  }
  // Options: tempo map and markers on, the click off (it can be on: the song has a tempo map).
  await expect(page.getByTestId("bounce-copyTempo")).toBeChecked();
  await expect(page.getByTestId("bounce-copyMarkers")).toBeChecked();
  await expect(page.getByTestId("bounce-includeClick")).not.toBeChecked();
  await expect(page.getByTestId("bounce-includeClick")).toBeEnabled();
  const sent = page.waitForRequest(
    (req) => req.method() === "POST" && /\/songs\/[^/]+\/bounce$/.test(new URL(req.url()).pathname),
  );
  await page.getByTestId("bounce-submit").click();
  const body = (await sent).postDataJSON() as {
    mix: { tracks: Record<string, { mute: boolean }> };
    versions: Record<string, string>;
    copyTempo: boolean;
    copyMarkers: boolean;
    includeClick: boolean;
  };
  expect(body).toMatchObject({ copyTempo: true, copyMarkers: true, includeClick: false });
  expect(Object.entries(body.versions)).toEqual(loaded.map((t) => [t.id, t.version]));
  expect(body.mix.tracks[loaded[0]?.id ?? ""]?.mute).toBe(true);
  expect(body.mix.tracks[loaded[1]?.id ?? ""]?.mute).toBe(false);

  // The notification opens the new song: one track, processing until rendered and ingested.
  await page.getByTestId("bounce-open").click();
  await expect(page).not.toHaveURL(sourceUrl);
  await expect(page.getByTestId("song-title")).toHaveText("Two takes (bounce)");
  const newRows = page.getByTestId("track-row");
  await expect(newRows).toHaveCount(1, { timeout: 30_000 });
  await expect(newRows.filter({ hasText: "kHz" })).toHaveCount(1, { timeout: 420_000 });
  await expect(newRows).toContainText("Two takes (bounce)");
  // The new song has the source's tempo map and marker at the same positions.
  const newId = /songs\/([^/?#]+)/.exec(page.url())?.[1] ?? "";
  const newTempo = (await (await page.request.get(`api/v1/songs/${newId}/tempo`, api)).json()) as {
    tempo: { bar1OffsetSec: number; map: { segments: { bpm: number }[] } } | null;
  };
  expect(newTempo.tempo?.bar1OffsetSec).toBe(0.5);
  expect(newTempo.tempo?.map.segments.map((x) => x.bpm)).toEqual([120]);
  const newMarkers = (await (
    await page.request.get(`api/v1/songs/${newId}/markers`, api)
  ).json()) as {
    markers: { name: string; startSec: number }[];
  };
  expect(newMarkers.markers.map((m) => [m.name, m.startSec])).toEqual([["Break", 2.5]]);

  // It plays in the Player.
  await tracksReady(page, 60_000);
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  expect((await debug(page))?.tracks).toHaveLength(1);
  await page.getByTestId("rehearse-play").click();

  // In the project it sits right after the source song.
  if (phone) await page.getByTestId("song-back").click();
  else await page.getByRole("link", { name: `← ${projectName}` }).click();
  await page.getByRole("tab", { name: "Songs" }).click();
  await expect(page.getByTestId("song-row")).toHaveText([/Two takes/, /Two takes \(bounce\)/]);
});
