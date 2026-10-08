import {
  bounceTracks,
  clickSettingsOf,
  effectiveInstrument,
  effectiveTranspose,
  isNeutralPractice,
  practiceKeyShift,
  practiceOf,
  profileFor,
  scaleTempoMap,
  transposeKeyName,
  uuidv7,
  voiceBaseHz,
  type BounceRequest,
  type Practice,
} from "@bandroom/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/connection";
import { jobs, tracks } from "../db/schema";
import { recordEvent } from "../events/record";
import { enqueueJob } from "../jobs/queue";
import { assetProbe, createAsset, getAsset, type AssetRow } from "../media/assets";
import type { BounceInput, BouncePayload } from "../media/bounce";
import type { BounceClick } from "../media/clickTrack";
import { durationSamples48k } from "../media/ingest";
import { mixChannels } from "../media/mixGraph";
import { needsStretch, stretchedFrames, stretchTempBytes } from "../media/stretchInput";
import type { SongRow } from "./access";
import { createSongRow } from "./songs";
import { songTempo } from "./tempo";
import { copyTimelineToBounce } from "./transfer";
import {
  createTrackWithVersion,
  getTrackVersionRow,
  type TrackRow,
  type TrackVersionRow,
} from "./tracks";

/** Bytes per second of the rendered file: 48 kHz, stereo, 24-bit PCM (SPEC §5.5). */
export const BOUNCE_WAV_BYTES_PER_SEC = 48_000 * 2 * 3;

export type BouncePlan =
  | {
      ok: true;
      inputs: BounceInput[];
      click: BounceClick | null;
      /** The practice setting the bounce applies (never neutral), or null. */
      practice: Practice | null;
      /** Length of the rendered file (stretched with the practice setting). */
      lengthSec: number;
      estimateBytes: number;
      /** Temporary disk the worker needs on top (the stretched inputs, SPEC §30.7). */
      tempBytes: number;
    }
  | { ok: false; reason: "invalid" | "silent" };

/**
 * Checks a bounce request against the song (SPEC §5.5) and picks what to render: every named
 * track must be a live track of the song, its version a live version of that track with a ready
 * file. Mute, solo and faders follow the engine ({@link bounceTracks}); a track missing from the
 * personal mix plays its default mix. The size estimate is the length as a 24-bit stereo WAV,
 * the original the render becomes (its FLAC and Opus are covered by the quota overhead).
 *
 * `includeClick` (needs the song's tempo map, else `invalid`) adds the click with the personal
 * click settings, as long as the song in the Player; its mute and "solo excludes click" do not
 * apply (the option asks for it), its solo silences the unsoloed tracks like in the engine. A
 * bounce of the click alone is allowed.
 *
 * `applyPractice` with a practice setting that is not neutral (SPEC §30.7) stretches the bounce:
 * every input carries how its track follows it (profile, transpose flag, voice range, resolved
 * from the track record; a song with one track counts as a mix), the click is built on the scaled
 * tempo map, and the length is ⌈L / rate⌉. The stretched inputs need temporary float WAVs
 * (`tempBytes`), which count toward the free disk but not the quota.
 */
export function planBounce(
  db: Db,
  songId: string,
  req: Pick<BounceRequest, "mix" | "versions"> & {
    includeClick?: boolean;
    applyPractice?: boolean;
  },
): BouncePlan {
  const songTracks = new Map(
    db
      .select()
      .from(tracks)
      .where(and(eq(tracks.songId, songId), isNull(tracks.deletedAt)))
      .all()
      .map((t) => [t.id, t]),
  );
  const chosen = new Map<string, { version: TrackVersionRow; asset: AssetRow }>();
  for (const [trackId, versionId] of Object.entries(req.versions)) {
    const version = getTrackVersionRow(db, versionId);
    const asset = version && getAsset(db, version.assetId);
    if (!songTracks.has(trackId) || version?.trackId !== trackId || asset?.status !== "ready")
      return { ok: false, reason: "invalid" };
    chosen.set(trackId, { version, asset });
  }
  const requested = practiceOf(req.mix);
  const practice = req.applyPractice && !isNeutralPractice(requested) ? requested : null;
  const rate = practice?.rate ?? 1;
  const singleTrack = songTracks.size === 1;
  const settings = clickSettingsOf(req.mix);
  const tempo = req.includeClick ? songTempo(db, songId) : null;
  if (req.includeClick && !tempo) return { ok: false, reason: "invalid" };
  const audible = bounceTracks(
    req.versions,
    req.mix,
    (id) => {
      const t = songTracks.get(id);
      return t && { gainDb: t.defaultGainDb, pan: t.defaultPan, mute: t.defaultMuted, solo: false };
    },
    tempo !== null && settings.solo,
  );
  let click: BounceClick | null = null;
  if (tempo) {
    // The song's length in the Player: every loaded version, audible or not.
    let lengthFrames = 0;
    for (const c of chosen.values()) {
      const p = assetProbe(c.asset);
      const frames = p ? durationSamples48k(p.durationSamples, p.sampleRate) : 0;
      lengthFrames = Math.max(lengthFrames, c.version.offsetSamples + frames);
    }
    // With practice: the click on the scaled map, as long as the stretched song (never stretched).
    const scaled = scaleTempoMap(tempo, rate);
    click = {
      gainDb: settings.gainDb,
      sound: settings.sound,
      subdivision: settings.subdivision,
      accent: settings.accent,
      compoundEighths: settings.compoundEighths,
      tempo: { map: scaled.map, bar1OffsetSec: scaled.bar1OffsetSec },
      lengthFrames: stretchedFrames(lengthFrames, rate),
    };
  }
  if (audible.length === 0 && !click) return { ok: false, reason: "silent" };
  let lengthSec = click ? click.lengthFrames / 48_000 : 0;
  let tempBytes = 0;
  const inputs = audible.map((b): BounceInput => {
    const c = chosen.get(b.trackId);
    const track = songTracks.get(b.trackId);
    if (!c || !track) throw new Error("unreachable: audible track without a version");
    const probe = assetProbe(c.asset);
    const outSec = (c.version.offsetSamples / 48_000 + (probe?.durationSec ?? 0)) / rate;
    lengthSec = Math.max(lengthSec, outSec);
    const input: BounceInput = {
      trackId: b.trackId,
      versionId: c.version.id,
      assetId: c.asset.id,
      faderDb: b.gainDb,
      versionGainDb: c.version.gainDb,
      pan: b.pan,
      offsetSamples: c.version.offsetSamples,
    };
    if (!practice) return input;
    const instrument = effectiveInstrument(track, { singleTrack });
    input.stretch = {
      profile: profileFor(instrument),
      transpose: effectiveTranspose(track, { singleTrack }),
      voiceBaseHz: instrument === "vocals" ? voiceBaseHz(track.voiceRange) : 0,
    };
    // At most the stored channels (a dual-mono flac has one, its kept original two).
    if (needsStretch(practice, input.stretch))
      tempBytes += stretchTempBytes(outSec, mixChannels(probe, "original"));
    return input;
  });
  return {
    ok: true,
    inputs,
    click,
    practice,
    lengthSec,
    estimateBytes: Math.ceil(lengthSec * BOUNCE_WAV_BYTES_PER_SEC),
    tempBytes,
  };
}

export interface CreatedBounce {
  song: SongRow;
  track: TrackRow;
  version: TrackVersionRow;
  assetId: string;
}

/**
 * Creates the bounce (SPEC §5.5) in one transaction: a song titled `title` right after the
 * source, one track named after it whose only version (`source: render`) points to a queued
 * asset uploaded by the user (it counts toward their quota), the `audio.bounce` job and the
 * `song.bounced` event. The source's subtitle and key are copied; with the options also its tempo
 * map and markers and sections (by the user, `tempo.changed` and `marker.*`/`section.*` created
 * events with the bounce's `batchId`). The worker renders the file, then the normal ingest runs.
 * With a `practice` setting (from {@link planBounce}) the copied tempo map and markers are scaled
 * to the stretched audio and the key is transposed when it parses as a key name (SPEC §30.7).
 */
export function createBounce(
  db: Db,
  input: {
    source: SongRow;
    title: string;
    userId: string;
    inputs: BounceInput[];
    click?: BounceClick | null;
    /** The practice setting the bounce applies ({@link BouncePlan}). */
    practice?: Practice | null;
    request: Pick<BounceRequest, "mix" | "versions"> &
      Partial<Pick<BounceRequest, "copyTempo" | "copyMarkers" | "includeClick" | "options">>;
    event?: { sessionId?: string | null; ip?: string | null; userAgent?: string | null };
  },
  now: number = Date.now(),
): CreatedBounce {
  const practice = input.practice ?? null;
  const shift = practice ? practiceKeyShift(practice) : 0;
  const key =
    shift !== 0 && input.source.key
      ? (transposeKeyName(input.source.key, shift) ?? input.source.key)
      : input.source.key;
  return db.transaction(() => {
    const song = createSongRow(
      db,
      {
        projectId: input.source.projectId,
        title: input.title,
        subtitle: input.source.subtitle,
        key,
        createdBy: input.userId,
        after: input.source,
      },
      now,
    );
    const batchId = uuidv7(now);
    const copyTempo = input.request.copyTempo ?? true;
    const copyMarkers = input.request.copyMarkers ?? true;
    const copied = copyTimelineToBounce(
      db,
      input.source.id,
      song.id,
      input.userId,
      { tempo: copyTempo, markers: copyMarkers, ...(practice && { rate: practice.rate }) },
      now,
    );
    const asset = createAsset(
      db,
      {
        kind: "audio",
        originalFilename: `${input.title.slice(0, 200)}.wav`,
        mimeType: "audio/wav",
        sizeBytes: 0, // set when rendered
        originalHash: "",
        uploadedBy: input.userId,
        // The ingest after the render follows them (SPEC §28.2).
        ingestOptions: input.request.options ?? null,
      },
      now,
    );
    const { track, version } = createTrackWithVersion(
      db,
      {
        songId: song.id,
        name: input.title,
        assetId: asset.id,
        uploadedBy: input.userId,
        source: "render",
        instrument: "mix",
      },
      now,
    );
    const payload: BouncePayload = {
      assetId: asset.id,
      projectId: song.projectId,
      songId: song.id,
      trackVersionId: version.id,
      sourceSongId: input.source.id,
      userId: input.userId,
      inputs: input.inputs,
      ...(input.click && { click: input.click }),
      ...(practice && { practice }),
    };
    enqueueBounceJob(db, payload, input.userId, now);
    const actor = {
      ts: now,
      actorUserId: input.userId,
      sessionId: input.event?.sessionId ?? null,
      ip: input.event?.ip ?? null,
      userAgent: input.event?.userAgent ?? null,
      projectId: song.projectId,
      songId: song.id,
    };
    recordEvent(db, {
      ...actor,
      action: "song.bounced",
      targetType: "song",
      targetId: song.id,
      details: {
        sourceSongId: input.source.id,
        title: song.title,
        versions: input.request.versions,
        mix: input.request.mix.tracks,
        batchId,
        copyTempo,
        copyMarkers,
        includeClick: input.click != null,
        ...(input.click && { click: input.request.mix.click ?? {} }),
        ...(input.request.options && { options: input.request.options }),
        ...(practice && {
          practice,
          transposed: Object.fromEntries(
            input.inputs.map((i) => [i.trackId, i.stretch?.transpose ?? true]),
          ),
        }),
      },
    });
    if (copied.tempoRevisionId !== null) {
      recordEvent(db, {
        ...actor,
        action: "tempo.changed",
        targetType: "song",
        targetId: song.id,
        details: {
          action: "copy",
          sourceSongId: input.source.id,
          revisionId: copied.tempoRevisionId,
          batchId,
        },
      });
    }
    for (const m of copied.markers) {
      recordEvent(db, {
        ...actor,
        action: `${m.type}.created`,
        targetType: m.type,
        targetId: m.id,
        details: { name: m.name, sourceSongId: input.source.id, batchId },
      });
    }
    return { song, track, version, assetId: asset.id };
  });
}

function enqueueBounceJob(db: Db, payload: BouncePayload, createdBy: string, now?: number): void {
  enqueueJob(
    db,
    {
      type: "audio.bounce",
      capability: "audio.bounce",
      payload,
      dedupeKey: `bounce:${payload.assetId}`,
      priority: 0,
      createdBy,
    },
    now,
  );
}

/**
 * Retrying a bounce whose render failed (no `original` yet): queues `audio.bounce` again with
 * the request of its last job. False when the asset never had a bounce job.
 */
export function retryBounce(db: Db, assetId: string, createdBy: string): boolean {
  const last = db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.type, "audio.bounce"), eq(jobs.dedupeKey, `bounce:${assetId}`)))
    .orderBy(jobs.createdAt)
    .all()
    .at(-1);
  if (!last) return false;
  enqueueBounceJob(db, JSON.parse(last.payload) as BouncePayload, createdBy);
  return true;
}
