import type { SongLossy } from "@bandroom/shared";
import { Badge, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconDiamondOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { PHONE_QUERY } from "../shell/mediaQueries";

/**
 * The song list's lossy badge (SPEC §26.4): "Lossy" when every track's current version is
 * compressed only, "Partly lossy" when some are. Nothing for full-quality songs. On phones only
 * an icon, so the song title keeps its room.
 */
export function SongLossyBadge({ lossy }: { lossy: SongLossy | undefined }) {
  const { t } = useTranslation();
  const isPhone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  if (lossy === undefined || lossy === "none") return null;
  const all = lossy === "all";
  const label = all ? t("lossless.songAll") : t("lossless.songPartial");
  const hint = all ? t("lossless.songAllHint") : t("lossless.songPartialHint");
  return (
    <Tooltip label={`${label}: ${hint}`} multiline maw={260}>
      {isPhone ? (
        <IconDiamondOff
          size={18}
          color="var(--mantine-color-yellow-6)"
          opacity={all ? 1 : 0.6}
          aria-label={label}
          role="img"
          data-testid="song-lossy-badge"
          data-lossy={lossy}
          style={{ flex: "none" }}
        />
      ) : (
        <Badge
          size="sm"
          variant="outline"
          color="yellow"
          data-testid="song-lossy-badge"
          data-lossy={lossy}
          style={{ flex: "none", textTransform: "none" }}
        >
          {label}
        </Badge>
      )}
    </Tooltip>
  );
}
