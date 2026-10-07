import type { TrackListItem, TrackListVersion } from "@bandroom/server-core";
import {
  PaletteColorSchema,
  type DownloadFormat,
  type ListenSource,
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

export function toTrackVersion(v: TrackListVersion, allowDownload: boolean): TrackVersion {
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
    if (flac) downloads.push("flac", "wav");
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
          lossless: p.lossless,
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
          },
    downloads,
  };
}

export function toTrack(item: TrackListItem, allowDownload: boolean): Track {
  const color = PaletteColorSchema.safeParse(item.track.color);
  return {
    id: item.track.id,
    songId: item.track.songId,
    name: item.track.name,
    role: item.track.role,
    color: color.success ? color.data : "blue",
    sortOrder: item.track.sortOrder,
    instrumentTag: item.track.instrumentTag,
    defaultGainDb: item.track.defaultGainDb,
    defaultPan: item.track.defaultPan,
    defaultMuted: item.track.defaultMuted,
    versionCount: item.versionCount,
    createdBy: item.track.createdBy,
    current: item.current ? toTrackVersion(item.current, allowDownload) : null,
  };
}

export function toListenSource(v: TrackListVersion, isAutoMix: boolean): ListenSource {
  const vars = variantMap(v);
  const ref = (name: string) => {
    const x = vars.get(name);
    return x ? { hash: x.hash, bitrate: num(x.meta.bitrate) } : null;
  };
  const peaks = vars.get("peaks");
  return {
    trackVersionId: v.version.id,
    isAutoMix,
    status: v.asset.status,
    durationSec: v.probe?.durationSec ?? null,
    opus: ref("opus"),
    opusLow: ref("opus_low"),
    peaks: peaks
      ? {
          hash: peaks.hash,
          overview: Array.isArray(peaks.meta.overview) ? (peaks.meta.overview as number[]) : [],
        }
      : null,
  };
}
