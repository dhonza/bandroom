import zlib from "node:zlib";
import { expect, test } from "@playwright/test";
import { loginAsNewUser, uniqueUsername } from "./helpers";

const CSRF = { "X-Requested-With": "bandroom" };

/** A PNG whose left half is red and right half blue (RGB, no filter). */
function twoColorPng(width: number, height: number): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    const red = x < width / 2;
    row.set(red ? [230, 20, 20] : [20, 20, 230], 1 + x * 3);
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("pick an image, crop a square and upload it (SPEC §25.4)", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  await loginAsNewUser(page, request, testInfo, "member");
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: `Cover ${uniqueUsername(testInfo)}` },
  });
  const { project } = (await res.json()) as { project: { id: string } };
  await page.goto(`projects/${project.id}?tab=settings`);

  const section = page.getByTestId("project-image");
  await section.locator('input[type="file"]').setInputFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: twoColorPng(400, 200),
  });
  const dialog = page.getByTestId("crop-dialog");
  const selection = dialog.getByTestId("crop-selection");
  await expect(selection).toBeVisible();

  // Default: the largest centred square (the middle half of the 2:1 image).
  const area = await dialog.getByTestId("crop-area").boundingBox();
  const start = await selection.boundingBox();
  if (!area || !start) throw new Error("no crop geometry");
  expect(area.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  expect(Math.abs(start.width - start.height)).toBeLessThan(2);

  // Keyboard: move it fully into the red half.
  await selection.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowLeft");
  const moved = await selection.boundingBox();
  if (!moved) throw new Error("no selection");
  expect(moved.x).toBeLessThan(start.x);

  // Pointer: drag the bottom-right corner inwards; the top-left corner stays.
  const handle = await dialog.getByTestId("crop-handle-se").boundingBox();
  if (!handle) throw new Error("no handle");
  const hx = handle.x + handle.width / 2;
  const hy = handle.y + handle.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx - 30, hy - 30, { steps: 5 });
  await page.mouse.up();
  const resized = await selection.boundingBox();
  if (!resized) throw new Error("no selection");
  expect(resized.width).toBeLessThan(moved.width - 10);
  expect(Math.abs(resized.x - moved.x)).toBeLessThan(2);
  expect(Math.abs(resized.width - resized.height)).toBeLessThan(2);

  await dialog.getByTestId("crop-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Image uploaded. It will appear in a moment.")).toBeVisible();

  // After processing, the project image is the red square.
  const img = section.locator("img");
  await expect(async () => {
    await page.reload();
    await expect(img).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 90_000 });
  const pixel = await img.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const c = document.createElement("canvas");
    c.width = el.naturalWidth;
    c.height = el.naturalHeight;
    const ctx = c.getContext("2d");
    ctx?.drawImage(el, 0, 0);
    const d = ctx?.getImageData(c.width / 2, c.height / 2, 1, 1).data;
    return { w: el.naturalWidth, h: el.naturalHeight, rgb: d ? [d[0], d[1], d[2]] : [] };
  });
  expect(pixel.w).toBe(pixel.h);
  const [r = 0, , b = 255] = pixel.rgb;
  expect(r).toBeGreaterThan(180);
  expect(b).toBeLessThan(80);
});

test("an image URL the server refuses shows a translated error", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!["chromium", "iphone"].includes(testInfo.project.name), "one desktop, one phone");
  await loginAsNewUser(page, request, testInfo, "member");
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: `Url ${uniqueUsername(testInfo)}` },
  });
  const { project } = (await res.json()) as { project: { id: string } };
  await page.goto(`projects/${project.id}?tab=settings`);
  await page.getByTestId("project-image-url").click();
  // The e2e server may not reach the internet; a private address is refused before any fetch.
  await page.getByTestId("image-url-input").fill("http://127.0.0.1/cover.png");
  await page.getByTestId("image-url-fetch").click();
  await expect(page.getByText("This address cannot be fetched")).toBeVisible();
});
