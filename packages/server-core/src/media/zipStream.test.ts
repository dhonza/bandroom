import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../testing/tempDir";
import { planZip, uniquePath, writeZip, zipPathSegment, type ZipEntry } from "./zipStream";

const HAS_UNZIP = spawnSync("unzip", ["-v"]).status === 0;

function entry(name: string, data: Buffer, chunk = 7): ZipEntry {
  return {
    name,
    size: data.length,
    // eslint-disable-next-line @typescript-eslint/require-await -- an async source
    open: async function* () {
      for (let i = 0; i < data.length; i += chunk) yield data.subarray(i, i + chunk);
    },
  };
}

async function collect(entries: ZipEntry[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of writeZip(entries, undefined, Date.UTC(2026, 9, 7, 12))) parts.push(b);
  return Buffer.concat(parts);
}

/** Reads the central directory (non-ZIP64) and checks every entry against its local data. */
function parse(zip: Buffer): { name: string; data: Buffer; crc: number; flags: number }[] {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(p + 8);
    const crc = zip.readUInt32LE(p + 16);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const localName = zip.readUInt16LE(offset + 26);
    const localExtra = zip.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const data = zip.subarray(start, start + size);
    expect(zip.readUInt32LE(start + size)).toBe(0x08074b50);
    expect(zip.readUInt32LE(start + size + 4)).toBe(crc);
    out.push({ name, data, crc, flags });
    p += 46 + nameLen + extraLen;
  }
  return out;
}

describe("zip stream (SPEC §28.7)", () => {
  it("writes stored entries with CRCs, UTF-8 names and the planned size", async () => {
    const files = [
      entry("Album/Song/Bass.flac", Buffer.from("bass ".repeat(100))),
      entry("Album/Píseň — 1.wav", Buffer.from("žluťoučký kůň")),
      entry("Album/Documents/empty.txt", Buffer.alloc(0)),
    ];
    const zip = await collect(files);
    const plan = planZip(files);
    expect(plan).toEqual({ totalSize: zip.length, zip64: false });
    const parsed = parse(zip);
    expect(parsed.map((e) => e.name)).toEqual(files.map((f) => f.name));
    expect(parsed[1]?.data.toString()).toBe("žluťoučký kůň");
    for (const e of parsed) {
      expect(e.crc).toBe(crc32(e.data) >>> 0);
      expect(e.flags & 0x0808).toBe(0x0808);
    }
  });

  it.skipIf(!HAS_UNZIP)("is accepted by unzip -t", async () => {
    const tmp = makeTempDir();
    try {
      const file = path.join(tmp.dir, "a.zip");
      fs.writeFileSync(
        file,
        await collect([
          entry("A/one.txt", Buffer.from("1")),
          entry("A/two.bin", Buffer.alloc(5000, 7)),
        ]),
      );
      const r = spawnSync("unzip", ["-t", file]);
      expect(r.stdout.toString()).toContain("No errors detected");
    } finally {
      tmp.cleanup();
    }
  });

  it("fails when an entry is shorter or longer than announced", async () => {
    await expect(collect([{ ...entry("x", Buffer.from("abc")), size: 4 }])).rejects.toThrow(
      /expected 4 bytes, got 3/,
    );
    await expect(collect([{ ...entry("x", Buffer.from("abcdef"), 6), size: 2 }])).rejects.toThrow(
      /expected 2 bytes/,
    );
  });

  it("stops when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const it = writeZip([entry("x", Buffer.from("abc"))], ac.signal);
    await expect(it.next()).rejects.toThrow();
  });

  it("switches to ZIP64 for large archives and counts its records exactly", () => {
    const small = planZip([{ name: "a", size: 10 }]);
    expect(small).toEqual({ totalSize: 30 + 1 + 10 + 16 + 46 + 1 + 22, zip64: false });
    const big = planZip([
      { name: "a", size: 3 * 1024 ** 3 },
      { name: "b", size: 2 * 1024 ** 3 },
    ]);
    expect(big.zip64).toBe(true);
    const perEntry = (n: number, size: number) => 30 + n + 20 + size + 24 + 46 + n + 28;
    expect(big.totalSize).toBe(
      perEntry(1, 3 * 1024 ** 3) + perEntry(1, 2 * 1024 ** 3) + 56 + 20 + 22,
    );
    expect(planZip([{ name: "huge", size: 5 * 1024 ** 3 }]).zip64).toBe(true);
    expect(planZip(Array.from({ length: 70_000 }, () => ({ name: "f", size: 1 }))).zip64).toBe(
      true,
    );
  });

  it("writes ZIP64 records that point at the central directory", async () => {
    // Force ZIP64 with many tiny entries; check the end records.
    const files = Array.from({ length: 65_535 }, (_, i) =>
      entry(`f${String(i)}`, Buffer.from("x")),
    );
    const zip = await collect(files);
    expect(zip.length).toBe(planZip(files).totalSize);
    const eocd = zip.length - 22;
    expect(zip.readUInt16LE(eocd + 10)).toBe(0xffff);
    const locator = eocd - 20;
    expect(zip.readUInt32LE(locator)).toBe(0x07064b50);
    const z64 = Number(zip.readBigUInt64LE(locator + 8));
    expect(zip.readUInt32LE(z64)).toBe(0x06064b50);
    expect(Number(zip.readBigUInt64LE(z64 + 32))).toBe(65_535);
    const cdOffset = Number(zip.readBigUInt64LE(z64 + 48));
    expect(zip.readUInt32LE(cdOffset)).toBe(0x02014b50);
    if (HAS_UNZIP) {
      const tmp = makeTempDir();
      try {
        const file = path.join(tmp.dir, "z64.zip");
        fs.writeFileSync(file, zip);
        expect(spawnSync("unzip", ["-tq", file]).stdout.toString()).toContain("No errors");
      } finally {
        tmp.cleanup();
      }
    }
  }, 120_000);

  it("makes safe, unique names", () => {
    expect(zipPathSegment('a/b\\c:d*e?"f<g>h|')).toBe("a_b_c_d_e__f_g_h_");
    expect(zipPathSegment("  Song.  ")).toBe("Song");
    expect(zipPathSegment("...")).toBe("_");
    expect(zipPathSegment("con")).toBe("_con");
    expect(zipPathSegment("x".repeat(300))).toHaveLength(120);
    const taken = new Set<string>();
    expect(uniquePath(taken, "P/Bass.flac")).toBe("P/Bass.flac");
    expect(uniquePath(taken, "P/bass.flac")).toBe("P/bass (2).flac");
    expect(uniquePath(taken, "P/Bass.flac")).toBe("P/Bass (3).flac");
    expect(uniquePath(taken, "P/Song")).toBe("P/Song");
    expect(uniquePath(taken, "P/Song")).toBe("P/Song (2)");
  });
});
