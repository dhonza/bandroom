import type { TrackListItem, TrackListVersion } from "@bandroom/server-core";
import {
  AudioQualitySchema,
  PaletteColorSchema,
  type DownloadFormat,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";

type VariantMeta = Record<string, unknown>;

function variantMap(v: TrackListVersion): Map<string, { hash: string; meta: VariantMeta }> {
  return new Map(
    v.variants.map((x) => [
      x.variant,
      { hash: x.blobHash, meta: JSON.parse(x.meta) as VariantMeta },
    ]),
  );
}

const num = (x: unknown, d = 0) => (typeof x === "number" ? x : d);

/** Bytes of a version's stored files, each file once (SPEC §28.6). */
function storedBytesOf(v: TrackListVersion): number {
  const seen = new Map(v.variants.map((x) => [x.blobHash, x.sizeBytes ?? 0]));
  return [...seen.values()].reduce((a, b) => a + b, 0);
}

/** `withSizes`: include `storedBytes` (members only, never on public links). */
export function toTrackVersion(
  v: TrackListVersion,
  allowDownload: boolean,
  withSizes = false,
): TrackVersion {
  const vars = variantMap(v);
  const opus = (name: string) => {
    const x = vars.get(name);
    return x
      ? {
          hash: x.hash,
          bitrate: num(x.meta.bitrate),
          channels: num(x.meta.channels, 2),
          preSkip: num(x.meta.preSkip),
          durationSamples48k: num(x.meta.durationSamples48k),
          quality: AudioQualitySchema.safeParse(x.meta.quality).data ?? null,
        }
      : null;
  };
  // The lossless FLAC is a download (SPEC §3.4): without download rights the client only gets
  // Opus, and the FLAC blobs answer 404 (routes/media.ts, DECISIONS 2026-10-01).
  const flac = allowDownload ? vars.get("flac") : undefined;
  const peaks = vars.get("peaks");
  const p = v.probe;
  const downloads: DownloadFormat[] = [];
  if (allowDownload && v.asset.status === "ready") {
    if (vars.has("original")) downloads.push("original");
    // A float source: WAV (rebuilt exactly) and its WavPack; the 24-bit FLAC is only near-lossless.
    if (vars.has("wavpack")) downloads.push("wav", "wavpack");
    else if (flac) downloads.push("flac", "wav");
    else if (vars.has("original") && p?.lossless) downloads.push("wav");
    if (vars.has("opus")) downloads.push("opus");
  }
  return {
    id: v.version.id,
    number: v.version.number,
    label: v.version.label,
    notes: v.version.notes,
    offsetSamples: v.version.offsetSamples,
    gainDb: v.version.gainDb,
    source: v.version.source,
    createdAt: v.version.createdAt,
    uploadedBy: v.version.uploadedBy,
    uploaderName: v.uploaderName,
    originalFilename: v.asset.originalFilename,
    sizeBytes: v.asset.sizeBytes,
    ...(withSizes && { storedBytes: storedBytesOf(v) }),
    status: v.asset.status,
    error: v.asset.error,
    progress: v.progress,
    media: p
      ? {
          durationSec: p.durationSec,
          sampleRate: p.sampleRate,
          channels: p.channels,
          bitDepth: p.bitDepth,
          codec: p.codec,
          // A render of a lossy source keeps the lossy badge (SPEC §24.2).
          lossless: p.lossless && p.derivedFromLossy !== true,
          dualMono: p.dualMono ?? false,
          integratedLufs: p.loudness?.integratedLufs ?? null,
          truePeakDbtp: p.loudness?.truePeakDbtp ?? null,
        }
      : null,
    variants: {
      opus: opus("opus"),
      opusLow: opus("opus_low"),
      flac: flac
        ? {
            hash: flac.hash,
            sampleRate: num(flac.meta.sampleRate),
            bitDepth: num(flac.meta.bitDepth),
            channels: num(flac.meta.channels, 2),
            durationSamples: num(flac.meta.durationSamples),
            nearLossless: flac.meta.nearLossless === true,
          }
        : null,
      peaks: peaks
        ? {
            hash: peaks.hash,
            overview: Array.isArray(peaks.meta.overview) ? (peaks.meta.overview as number[]) : [],
          }
        : null,
      seekIndex: {
        opus: vars.get("seekindex_opus")?.hash ?? null,
        opusLow: vars.get("seekindex_opus_low")?.hash ?? null,
        flac: allowDownload ? (vars.get("seekindex_flac")?.hash ?? null) : null,
      },
    },
    archived:
      v.version.archivedAt === null
        ? null
        : {
            at: v.version.archivedAt,
            by: v.version.archivedBy
              ? { id: v.version.archivedBy, displayName: v.archiverName ?? "" }
              : null,
            reason: v.version.archivedReason ?? "removed",
          },
    downloads,
  };
}

/** `bytes`: the track's stored bytes (members only, SPEC §28.6). */
export function toTrack(item: TrackListItem, allowDownload: boolean, bytes?: number): Track {
  const color = PaletteColorSchema.safeParse(item.track.color);
  return {
    id: item.track.id,
    songId: item.track.songId,
    name: item.track.name,
    color: color.success ? color.data : "blue",
    sortOrder: item.track.sortOrder,
    instrumentTag: item.track.instrumentTag,
    instrument: item.track.instrument,
    transpose: item.track.transpose,
    voiceRange: item.track.voiceRange,
    formantMode: item.track.formantMode,
    formantShift: item.track.formantShift,
    defaultGainDb: item.track.defaultGainDb,
    defaultPan: item.track.defaultPan,
    defaultMuted: item.track.defaultMuted,
    versionCount: item.versionCount,
    createdBy: item.track.createdBy,
    current: item.current ? toTrackVersion(item.current, allowDownload, bytes !== undefined) : null,
    ...(bytes !== undefined && { bytes }),
  };
}
