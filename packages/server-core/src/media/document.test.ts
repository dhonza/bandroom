import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir } from "../testing/tempDir";
import { isUtf8TextFile, sniffDocument } from "./document";

const tmp = makeTempDir();
afterAll(() => {
  tmp.cleanup();
});

describe("document kind detection by content (SPEC §5.2, §5.7)", () => {
  it.each([
    ["%PDF-1.7\n", "pdf"],
    ["\x89PNG\r\n\x1a\n", "image"],
    ["\xff\xd8\xff\xe0", "image"],
    ["GIF89a", "image"],
    ["RIFF\0\0\0\0WEBPVP8 ", "image"],
    ["\0\0\0\x18ftypheic", "image"],
    ["\0\0\0\x18ftypavif", "image"],
    ["\0\0\0\x18ftypM4A ", "other"],
    ["MThd\0\0\0\x06", "midi"],
    ["PK\x03\x04", "other"],
    ["\xd0\xcf\x11\xe0", "other"],
    ["RIFF\0\0\0\0WAVEfmt ", "other"],
    ["fLaC", "other"],
    ["ID3\x04", "other"],
  ])("%j → %s", (head, kind) => {
    expect(sniffDocument(Buffer.from(head, "latin1"))?.kind).toBe(kind);
  });

  it("leaves text to the UTF-8 check", () => {
    expect(sniffDocument(Buffer.from("# Title\n", "utf8"))).toBeNull();
    expect(sniffDocument(Buffer.alloc(0))).toBeNull();
  });

  it("validates UTF-8 text, streamed", async () => {
    const file = (name: string, data: Buffer) => {
      const p = path.join(tmp.dir, name);
      return fs.writeFile(p, data).then(() => p);
    };
    expect(await isUtf8TextFile(await file("a.txt", Buffer.from("Příliš žluťoučký kůň\n")))).toBe(
      true,
    );
    // Windows-1250 "Příliš" is not valid UTF-8.
    expect(await isUtf8TextFile(await file("b.txt", Buffer.from([0x50, 0xf8, 0xed])))).toBe(false);
    expect(await isUtf8TextFile(await file("c.txt", Buffer.from("a\0b")))).toBe(false);
    // A multi-byte character split across the 64 KiB read boundary is still valid.
    const big = Buffer.concat([Buffer.alloc(64 * 1024 - 1, 0x61), Buffer.from("ž", "utf8")]);
    expect(await isUtf8TextFile(await file("d.txt", big))).toBe(true);
  });
});
