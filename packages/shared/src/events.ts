/**
 * Activity log actions (SPEC §14.1). Every state-changing action writes one of these. The table is
 * append-only; add new actions here when adding features.
 */
export const EVENT_ACTIONS = [
  // auth
  "auth.login",
  "auth.logout",
  "auth.login_failed",
  "auth.password_changed",
  "auth.password_reset",
  "auth.reset_requested",
  "auth.reset_link_created",
  "auth.sessions_revoked",
  /** An admin dismissed a user's "forgot password" request without sending a link. */
  "auth.reset_request_dismissed",
  // users & invites
  "user.invited",
  "user.created",
  "user.updated",
  "user.role_changed",
  "user.quota_changed",
  "user.disabled",
  "user.enabled",
  "invite.accepted",
  "invite.revoked",
  // projects & songs
  "project.created",
  "project.updated",
  "project.archived",
  "project.unarchived",
  "project.deleted",
  /** Restored from Admin → Trash, or deleted permanently (SPEC §26.3). */
  "project.restored",
  "project.purged",
  "project.ownership_transferred",
  "grant.changed",
  "song.created",
  "song.updated",
  "song.deleted",
  /** An editor locked or unlocked the song (SPEC §25.12). */
  "song.locked",
  "song.unlocked",
  /**
   * A user bounced a song's mix into a new song (SPEC §5.5; target: the new song; details:
   * sourceSongId, versions, mix). The worker writes `version.rendered` when the render is attached.
   */
  "song.bounced",
  "songs.reordered",
  /** Restored from the Trash, or deleted permanently (SPEC §26.3; batch actions carry a batchId). */
  "song.restored",
  "song.purged",
  "track.restored",
  "track.purged",
  "version.restored",
  "version.purged",
  /**
   * Make multitrack song, copy and move (SPEC §26.5, §26.6; details: batchId, from…): a song
   * copied or moved to a project, a track moved or copied into a new song.
   */
  "song.copied",
  "song.moved",
  "track.moved",
  "track.copied",
  "track.deleted",
  "track.updated",
  "tracks.reordered",
  /** A track's version stack was reordered (version numbers stay). */
  "versions.reordered",
  "version.set_current",
  "version.updated",
  /** A version's gain changed (details: before, after in dB; SPEC §25.6). */
  "version.gain_changed",
  "version.deleted",
  "version.uploaded",
  "version.retried",
  /** The worker attached a rendered file to its version (a bounce, SPEC §5.5). */
  "version.rendered",
  /** Full-quality files removed (SPEC §26.4; details: batchId, files, bytes, copy). */
  "version.lossless_removed",
  "asset.downloaded",
  // documents (SPEC §10, §14.1)
  "document.created",
  "document.updated",
  "document.deleted",
  "document.restored",
  /** Deleted permanently from the Trash (SPEC §26.3). */
  "document.purged",
  "document.version_added",
  "document.version_deleted",
  "document.version_restored",
  "document.set_current",
  "document.retried",
  "document.viewed",
  "document.downloaded",
  // markers and sections (SPEC §7.4)
  "marker.created",
  "marker.updated",
  "marker.deleted",
  "marker.restored",
  "section.created",
  "section.updated",
  "section.deleted",
  "section.restored",
  /** Markers created from a MIDI import (details: count). */
  "markers.imported",
  // tempo maps (SPEC §7.1–§7.3; details: action set|import|restore|delete)
  "tempo.changed",
  // comments (SPEC §8)
  "comment.created",
  "comment.edited",
  "comment.deleted",
  "comment.restored",
  "comment.resolved",
  "comment.unresolved",
  "comment.reaction_added",
  "comment.reaction_removed",
  // follows (SPEC §16; automatic follows are not logged)
  "follow.added",
  "follow.removed",
  // personal mixer (SPEC §11.3; the autosaved state itself is not logged)
  "mixer.snapshot_saved",
  "mixer.snapshot_deleted",
  // offline (SPEC §13, §14.1): a song or project made available offline / removed, per device
  "offline.added",
  "offline.removed",
  // public links (SPEC §3.5, §14.1); visitor events carry linkId + linkSessionId
  "link.created",
  "link.updated",
  "link.revoked",
  /** A new link session (first open in a browser, or again after the 12 h session ended). */
  "link.opened",
  "link.password_failed",
  /** Playback started in the link view (details: mode); play sessions come with M13. */
  "link.played",
  /** A visitor set the display name used for anonymous comments. */
  "link.visitor_named",
  // imports (SPEC §17)
  "import.connected",
  /** A scan of the selected Samply projects was requested (details: projects). */
  "import.scanned",
  /** The admin edited the reviewed import mapping. */
  "import.mapping_changed",
  "import.started",
  "import.finished",
  "import.cancelled",
  "import.insight",
  /** A user saved or replaced a personal secret (details: kind; never the secret, SPEC §25.11). */
  "secret.saved",
  "secret.deleted",
  // instance
  "settings.changed",
] as const;

export type EventAction = (typeof EVENT_ACTIONS)[number];

export const ACTOR_TYPES = ["user", "link", "system", "worker"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
