// @vitest-environment node
import { strToU8, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import { expandZip, isZipFile, ZipError } from "./zip";
import { isAudioName } from "./media";

function zipFile(entries: Zippable, name = "Album.zip"): File {
  return new File([zipSync(entries)], name, { type: "application/zip" });
}

const audio = (text: string) => strToU8(text.repeat(200));

describe("isZipFile", () => {
  it("recognises zips by type or extension", () => {
    expect(isZipFile(new File([], "a.ZIP"))).toBe(true);
    expect(isZipFile(new File([], "a", { type: "application/x-zip-compressed" }))).toBe(true);
    expect(isZipFile(new File([], "a.wav", { type: "audio/wav" }))).toBe(false);
  });
});

describe("expandZip", () => {
  it("unpacks nested folders with their paths, deflated and stored", async () => {
    const zip = zipFile({
      "Album/": {},
      "Album/Song A/bass.wav": [audio("bass"), { level: 6 }],
      "Album/Song A/drums.flac": [audio("drums"), { level: 0 }],
      "Album/Song B/vox.mp3": audio("vox"),
    });
    const { files, skipped } = await expandZip(zip, isAudioName);
    expect(skipped).toBe(0);
    expect(files.map((f) => [f.path, f.name, f.size])).toEqual([
      ["Album/Song A/bass.wav", "bass.wav", 800],
      ["Album/Song A/drums.flac", "drums.flac", 1000],
      ["Album/Song B/vox.mp3", "vox.mp3", 600],
    ]);
    expect(await files[0]?.text()).toBe("bass".repeat(200));
    expect(await files[1]?.text()).toBe("drums".repeat(200));
  });

  it("keeps root files and skips __MACOSX, dot files and non-audio", async () => {
    const zip = zipFile({
      "gtr.wav": audio("g"),
      "notes.txt": strToU8("hi"),
      ".DS_Store": strToU8("x"),
      "__MACOSX/._gtr.wav": strToU8("x"),
      "sub/.hidden/keys.wav": audio("k"),
    });
    const { files, skipped } = await expandZip(zip, isAudioName);
    expect(files.map((f) => f.path)).toEqual(["gtr.wav"]);
    expect(skipped).toBe(1);
  });

  it("rejects something that is not a zip", async () => {
    await expect(
      expandZip(new File(["nope, not a zip at all"], "x.zip"), isAudioName),
    ).rejects.toBeInstanceOf(ZipError);
    await expect(expandZip(new File([], "x.zip"), isAudioName)).rejects.toMatchObject({
      reason: "invalid",
    });
  });

  it("rejects a corrupt deflated entry", async () => {
    const bytes = zipSync({ "a.wav": [audio("abc"), { level: 9 }] });
    // Damage the compressed data right after the 30-byte local header and the name.
    const at = 30 + "a.wav".length;
    bytes.set([0xff, 0xff, 0xff, 0xff], at + 2);
    await expect(expandZip(new File([bytes], "a.zip"), isAudioName)).rejects.toMatchObject({
      reason: "corrupt",
    });
  });

  it("refuses ZIP64 archives", async () => {
    const bytes = zipSync({ "a.wav": audio("abc") });
    // Mark the end-of-central-directory entry count as ZIP64 (0xFFFF).
    const eocd = bytes.length - 22;
    bytes[eocd + 10] = 0xff;
    bytes[eocd + 11] = 0xff;
    await expect(expandZip(new File([bytes], "a.zip"), isAudioName)).rejects.toMatchObject({
      reason: "zip64",
    });
  });
});
