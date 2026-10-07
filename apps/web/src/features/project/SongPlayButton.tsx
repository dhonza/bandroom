import { ActionIcon } from "@mantine/core";
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { togglePlay, useRehearse } from "../../rehearse/controller";

/**
 * A song row's play button (SPEC §6.10, §11.2): starts the engine queue from this song. On the
 * song that is loaded now it pauses and resumes it instead. Disabled while the song has nothing
 * to play yet (not `ready` in the queue).
 */
export function SongPlayButton({
  songId,
  title,
  ready,
  onPlay,
}: {
  songId: string;
  title: string;
  ready: boolean;
  /** Starts the queue at this song; synchronous, inside the tap (iOS audio unlock). */
  onPlay: (songId: string) => void;
}) {
  const { t } = useTranslation();
  // This song's engine status while it is the loaded song, else null.
  const status = useRehearse((s) => (s.open && s.songId === songId ? s.status : null));
  const current = status !== null;
  const playing = status === "playing" || status === "buffering";
  return (
    <ActionIcon
      size={44}
      variant={current ? "light" : "subtle"}
      color={current ? undefined : "gray"}
      disabled={!ready && !current}
      loading={status === "loading"}
      onClick={() => {
        if (current) togglePlay();
        else onPlay(songId);
      }}
      aria-label={playing ? t("songs.pauseSong", { title }) : t("songs.playSong", { title })}
      data-testid="song-row-play"
      data-playing={playing || undefined}
      style={{ flex: "none" }}
    >
      {playing ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
    </ActionIcon>
  );
}
