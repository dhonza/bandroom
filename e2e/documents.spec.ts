import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, makePdf, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, openMixer, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };

/** A small PNG (64×32, green), so the image viewer has something to show. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAYElEQVRYhe2SQQkAQRDDqiTCqmlFn4h7hIFCBKSh4fU00Q3YgOoV2YV6l+gGbED1iuxCvUt0AzagekV2od4lugEbUL0iu1DvEt2ADahekV2od4luwAZUr8gu1LtEN/jJB/ZrIHncVclcAAAAAElFTkSuQmCC",
  "base64",
);

async function noHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.innerWidth === document.documentElement.clientWidth))
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

/** Uploads files through a FileButton (hidden input opened by the button). */
async function chooseFiles(
  page: Page,
  button: ReturnType<Page["getByTestId"]>,
  files: { name: string; mimeType: string; buffer: Buffer }[],
) {
  const chooser = page.waitForEvent("filechooser");
  await button.click();
  await (await chooser).setFiles(files);
}

// The machine running e2e is loaded (six projects in parallel, each ingesting audio).
expect.configure({ timeout: 20_000 });

test("Documents: write, edit, PDF pages with pedal keys, images, split view, project documents", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, page.request, testInfo, "member");

  // A song with one processed track (the player gives the split view something to sit beside).
  await page.goto("library");
  await page.getByTestId("new-project").click();
  const projectName = `Docs ${uniqueUsername(testInfo)}`;
  await page.getByLabel("Name").fill(projectName);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  const projectUrl = page.url().replace(/\?.*$/, "");
  const projectId = projectUrl.split("/").pop() ?? "";
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Paper trail");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Paper trail" }).getByRole("link").click();
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());

  // --- A Markdown document written in the app from the Docs panel next to the player. Documents
  // belong to the project (SPEC §28.4): the song page has no documents section of its own. ---
  await expect(page.getByTestId("song-documents")).toHaveCount(0);
  await page.getByTestId("open-docs").click();
  const panel = page.getByTestId("docs-panel");
  await expect(panel.getByTestId("doc-empty")).toBeVisible();
  await panel.getByTestId("doc-new").click();
  await page.getByTestId("doc-new-title").fill("Lyrics");
  await page
    .getByTestId("doc-new-text")
    .fill("# Verse\n\nFirst **line**\n\n| Chord | Bars |\n| --- | --- |\n| Am | 2 |\n");
  await page.getByTestId("doc-new-save").click();
  const lyricsRow = panel.getByTestId("doc-row").filter({ hasText: "Lyrics" });
  await expect(lyricsRow).toBeVisible();
  await lyricsRow.getByTestId("doc-open").click();
  await expect(panel).toHaveAttribute("data-layout", phone ? "sheet" : "side");
  const md = panel.getByTestId("doc-markdown");
  await expect(md.locator("h1")).toHaveText("Verse");
  await expect(md.locator("strong")).toHaveText("line");
  await expect(md.locator("table td").first()).toHaveText("Am");
  if (phone) await noHorizontalOverflow(page);

  // Font size: saved on the account.
  const slider = panel.getByTestId("doc-font-size").getByRole("slider");
  await slider.focus();
  // Two quick steps: each is saved, in order, and the second is not lost or reverted.
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/me") &&
      r.request().method() === "PATCH" &&
      r.request().postData() === JSON.stringify({ docFontSize: 20 }),
  );
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(md).toHaveCSS("font-size", "20px");
  await saved;
  await expect(md).toHaveCSS("font-size", "20px");

  // Edit the text: a new version.
  await panel.getByTestId("doc-menu").click();
  await page.getByTestId("doc-edit").click();
  const editor = page.getByTestId("doc-editor");
  await expect(editor).toHaveValue(/# Verse/);
  await editor.fill("# Chorus\n\nSecond take\n");
  if (!phone)
    await expect(page.getByTestId("doc-editor-preview").locator("h1")).toHaveText("Chorus");
  await page.getByTestId("doc-editor-save").click();
  await expect(md.locator("h1")).toHaveText("Chorus");
  await panel.getByTestId("doc-menu").click();
  await expect(page.getByTestId("doc-versions")).toHaveText("Versions (2)");
  await page.keyboard.press("Escape");

  // --- A PDF: uploaded, thumbnail, one page at a time, page keys and a mapped pedal key. ---
  await panel.getByTestId("doc-back").click();
  await chooseFiles(page, panel.getByTestId("doc-upload"), [
    { name: "Chart.pdf", mimeType: "application/pdf", buffer: makePdf(["One", "Two", "Three"]) },
  ]);
  const pdfRow = panel.getByTestId("doc-row").filter({ hasText: "Chart" });
  await expect(pdfRow).toContainText("3 pages", { timeout: 60_000 });
  await expect(pdfRow.locator("img")).toBeVisible();
  await pdfRow.getByTestId("doc-open").click();
  const pageLabel = panel.getByTestId("pdf-page");
  await expect(pageLabel).toHaveText("1 / 3", { timeout: 30_000 });
  const canvas = panel.getByTestId("pdf-canvas");
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(100);
  // The first page's box is red: the canvas really shows the PDF.
  await expect
    .poll(() =>
      canvas.evaluate((c: HTMLCanvasElement) => {
        const ctx = c.getContext("2d");
        if (!ctx) return 0;
        const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        return (d[0] ?? 0) - (d[2] ?? 0);
      }),
    )
    .toBeGreaterThan(100);
  const viewer = panel.getByTestId("doc-viewer");
  await viewer.focus();
  await page.keyboard.press("PageDown");
  await expect(pageLabel).toHaveText("2 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(pageLabel).toHaveText("3 / 3");
  await page.keyboard.press("ArrowLeft");
  await expect(pageLabel).toHaveText("2 / 3");
  if (!phone) {
    // A pedal key mapped to "next page" works from anywhere on the song page (SPEC §11.4).
    await page.evaluate(() => {
      localStorage.setItem("bandroom.keymap", JSON.stringify({ KeyB: "pagePrev" }));
    });
    await page.getByRole("heading", { level: 2, name: "Paper trail" }).click();
    await page.keyboard.press("b");
    await expect(pageLabel).toHaveText("1 / 3");
  } else {
    await panel.getByTestId("pdf-next").click();
    await expect(pageLabel).toHaveText("3 / 3");
  }

  // --- Split view: the player stays usable beside the panel / above the sheet. ---
  await expect(page.getByTestId("track-row").filter({ hasText: "kHz" })).toHaveCount(1, {
    timeout: 180_000,
  });
  // Phones: the sheet covers the Player's transport, so it carries play/pause itself.
  if (phone) await expect(panel.getByTestId("docs-sheet-play")).toBeVisible();
  // On phones the sheet covers the page: close it, open the Mixer, reopen from "Docs (N)".
  if (phone) await page.getByTestId("docs-close").click();
  await openMixer(page);
  if (phone) {
    await page.getByTestId("open-docs").click();
    await expect(panel).toBeVisible();
  }
  const panelBox = await panel.boundingBox();
  if (!panelBox) throw new Error("no panel");
  if (phone) {
    await expect(panel.getByTestId("docs-sheet-play")).toBeInViewport();
    await noHorizontalOverflow(page);
  } else {
    await expect(page.getByTestId("timeline-detail")).toBeVisible({ timeout: 30_000 });
    const timeline = await page.getByTestId("timeline-detail").boundingBox();
    if (!timeline) throw new Error("no timeline");
    expect(timeline.x + timeline.width).toBeLessThanOrEqual(panelBox.x + 1);
    // Opening the comments panel closes the documents panel (they share the side).
    await page.getByTestId("open-comments").click();
    await expect(panel).toBeHidden();
    await page.getByTestId("comments-close").click();
    await page.getByTestId("open-docs").click();
    await expect(panel).toBeVisible();
  }

  // --- Live update: a document added elsewhere appears without reloading (SSE). ---
  if (await panel.getByTestId("doc-back").isVisible()) await panel.getByTestId("doc-back").click();
  const res = await page.request.post(`api/v1/projects/${projectId}/documents`, {
    headers: CSRF,
    data: { title: "Arrangement", kind: "text", text: "Intro  x4\nVerse  x8\n" },
  });
  expect(res.ok(), await res.text()).toBe(true);
  await expect(panel.getByTestId("doc-row").filter({ hasText: "Arrangement" })).toBeVisible({
    timeout: 20_000,
  });
  await panel
    .getByTestId("doc-row")
    .filter({ hasText: "Arrangement" })
    .getByTestId("doc-open")
    .click();
  await expect(panel.getByTestId("doc-text")).toHaveText("Intro  x4\nVerse  x8\n");

  // --- An image, then delete with undo. ---
  await panel.getByTestId("doc-back").click();
  await chooseFiles(page, panel.getByTestId("doc-upload"), [
    { name: "Stage plot.png", mimeType: "image/png", buffer: PNG },
  ]);
  const imgRow = panel.getByTestId("doc-row").filter({ hasText: "Stage plot" });
  await expect(imgRow).toContainText("Image", { timeout: 60_000 });
  await expect(imgRow.getByTestId("doc-status")).toHaveCount(0, { timeout: 60_000 });
  await imgRow.getByTestId("doc-open").click();
  await expect(panel.getByTestId("doc-image")).toBeVisible();
  await panel.getByTestId("doc-menu").click();
  await page.getByTestId("doc-delete").click();
  await expect(panel.getByTestId("doc-row").filter({ hasText: "Stage plot" })).toHaveCount(0);
  await page.getByTestId("document-undo").click();
  await expect(panel.getByTestId("doc-row").filter({ hasText: "Stage plot" })).toHaveCount(1);
  await page.getByTestId("docs-close").click();
  await expect(panel).toBeHidden();

  // --- Project documents: own page, download follows the policy. ---
  await page.goto(`${projectUrl}?tab=documents`);
  const tab = page.getByTestId("project-documents");
  // The documents made on the song page are the project's.
  await expect(tab.getByTestId("doc-row").filter({ hasText: "Lyrics" })).toBeVisible();
  await expect(tab.getByTestId("project-song-documents")).toHaveCount(0);
  await tab.getByTestId("doc-new").first().click();
  await page.getByTestId("doc-new-title").fill("Setlist");
  await page.getByTestId("doc-new-text").fill("1. Paper trail\n2. Encore\n");
  await page.getByTestId("doc-new-save").click();
  await tab.getByTestId("doc-row").filter({ hasText: "Setlist" }).getByTestId("doc-open").click();
  await expect(page.getByTestId("document-page")).toBeVisible();
  await expect(page.getByTestId("doc-markdown").locator("li")).toHaveCount(2);
  await page.getByTestId("doc-menu").click();
  const href = await page.getByTestId("doc-download-menu").getAttribute("href");
  const dl = await page.request.get(href ?? "");
  expect(dl.status()).toBe(200);
  expect(dl.headers()["content-disposition"]).toContain("attachment");
  expect(await dl.text()).toContain("Encore");
  if (phone) await noHorizontalOverflow(page);
  // The document page leads back to the project's Documents tab.
  await page.getByTestId("document-page").getByRole("link", { name: projectName }).click();
  await expect(page.getByTestId("project-documents")).toBeVisible();
});
