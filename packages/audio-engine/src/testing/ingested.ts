import fs from "node:fs/promises";
import { createTestDb, getBlob, getVariant, insertUser, makeTempDir } from "@bandroom/server-core";
import {
  addOriginal,
  createHarness,
  runOneJob,
  variantPath,
  type Harness,
} from "@bandroom/server-core/testing/ingest";
import type { SeekIndex } from "../decode/seek";
import type { FetchLike } from "../worker/bytes";
import type { EngineVariant } from "../types";

/** Ingests fixtures through the real pipeline and exposes their variants to engine tests. */
export class IngestedFixtures {
  private t = createTestDb();
  private tmp = makeTempDir();
  readonly h: Harness = createHarness(this.t.db, this.tmp.dir);
  private uploader = insertUser(this.t.db, {
    username: "up",
    displayName: "Up",
    passwordHash: "x",
    globalRole: "member",
  }).id;
  /** URL → bytes, served by `fetch`. */
  private files = new Map<string, Uint8Array>();
  requests: { url: string; range: string | null }[] = [];

  async ingest(file: string): Promise<string> {
    const asset = await addOriginal(this.h, file, this.uploader);
    const { status } = await runOneJob(this.h, "audio.ingest", {
      assetId: asset.id,
      role: "track",
    });
    if (status !== "done") throw new Error(`ingest failed: ${file}`);
    return asset.id;
  }

  meta(assetId: string, variant: string): Record<string, number> {
    return JSON.parse(getVariant(this.t.db, assetId, variant)?.meta ?? "null") as Record<
      string,
      number
    >;
  }

  async bytes(assetId: string, variant: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(await variantPath(this.h, assetId, variant)));
  }

  async seekIndex(assetId: string, variant: string): Promise<SeekIndex> {
    const v = getVariant(this.t.db, assetId, `seekindex_${variant}`);
    const blob = v && getBlob(this.t.db, v.blobHash);
    if (!blob) throw new Error("no seek index");
    const text = await fs.readFile(await this.h.storage.localPath(blob.storageKey), "utf8");
    return JSON.parse(text) as SeekIndex;
  }

  /** An engine variant served from memory at `mem://<asset>/<variant>`. */
  async variant(assetId: string, variant: "opus" | "opus_low" | "flac"): Promise<EngineVariant> {
    const m = this.meta(assetId, variant);
    const url = `mem://${assetId}/${variant}`;
    this.files.set(url, await this.bytes(assetId, variant));
    const idxUrl = `${url}/index`;
    this.files.set(
      idxUrl,
      new TextEncoder().encode(JSON.stringify(await this.seekIndex(assetId, variant))),
    );
    const hash = getVariant(this.t.db, assetId, variant)?.blobHash ?? url;
    return variant === "flac"
      ? {
          kind: "flac",
          hash,
          url,
          seekIndexUrl: idxUrl,
          channels: m.channels ?? 1,
          preSkip: 0,
          totalFrames: m.durationSamples ?? 0,
          sampleRate: m.sampleRate ?? 48_000,
        }
      : {
          kind: "opus",
          hash,
          url,
          seekIndexUrl: idxUrl,
          channels: m.channels ?? 1,
          preSkip: m.preSkip ?? 0,
          totalFrames: m.durationSamples48k ?? 0,
          sampleRate: 48_000,
        };
  }

  /** In-memory HTTP with Range support, delivering 16 kB pieces asynchronously. */
  readonly fetch: FetchLike = (url, init) => {
    const data = this.files.get(url);
    const range = init.headers?.Range ?? null;
    this.requests.push({ url, range });
    if (!data) return Promise.resolve({ status: 404, headers: { get: () => null }, body: null });
    let start = 0;
    let end = data.length - 1;
    const m = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), end) : end;
    }
    const slice = data.subarray(start, end + 1);
    let pos = 0;
    const signal = init.signal;
    const body = new ReadableStream<Uint8Array>({
      pull: async (ctrl) => {
        await new Promise((r) => setTimeout(r, 0));
        if (signal?.aborted) {
          ctrl.error(new Error("aborted"));
          return;
        }
        if (pos >= slice.length) {
          ctrl.close();
          return;
        }
        ctrl.enqueue(slice.slice(pos, pos + 16_384));
        pos += 16_384;
      },
    });
    const headers = new Map<string, string>([["content-length", String(slice.length)]]);
    if (m) headers.set("content-range", `bytes ${start}-${end}/${data.length}`);
    return Promise.resolve({
      status: m ? 206 : 200,
      headers: { get: (k: string) => headers.get(k) ?? null },
      body,
    });
  };

  close(): void {
    this.t.close();
    this.tmp.cleanup();
  }
}
