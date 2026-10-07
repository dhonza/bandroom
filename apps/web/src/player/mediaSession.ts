import { blobUrl } from "../lib/media";

/**
 * Media Session (SPEC §6.10), best effort: title, project and artwork plus play/pause and
 * previous/next song for the system media controls while the page is visible. Locked-screen
 * playback is not supported (§6.8), so nothing here keeps audio alive.
 */
export interface MediaInfo {
  title: string;
  subtitle: string;
  projectName: string;
  imageHash: string | null;
}

export interface MediaActions {
  play: () => void;
  pause: () => void;
  previous: () => void;
  next: () => void;
}

function session(): MediaSession | null {
  return typeof navigator !== "undefined" && "mediaSession" in navigator
    ? navigator.mediaSession
    : null;
}

export function installMediaActions(a: MediaActions): void {
  const ms = session();
  if (!ms) return;
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", a.play],
    ["pause", a.pause],
    ["previoustrack", a.previous],
    ["nexttrack", a.next],
  ];
  for (const [action, handler] of handlers) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // action not supported on this browser
    }
  }
}

export function setMediaInfo(info: MediaInfo | null): void {
  const ms = session();
  if (!ms) return;
  try {
    if (!info || typeof MediaMetadata === "undefined") {
      ms.metadata = null;
      return;
    }
    ms.metadata = new MediaMetadata({
      title: info.title,
      artist: info.projectName,
      album: info.subtitle || info.projectName,
      artwork: info.imageHash
        ? [
            {
              src: new URL(blobUrl(info.imageHash), document.baseURI).href,
              sizes: "512x512",
              type: "image/webp",
            },
          ]
        : [],
    });
  } catch {
    // best effort
  }
}

export function setMediaPlaying(playing: boolean | null): void {
  const ms = session();
  if (!ms) return;
  try {
    ms.playbackState = playing === null ? "none" : playing ? "playing" : "paused";
  } catch {
    // best effort
  }
}
