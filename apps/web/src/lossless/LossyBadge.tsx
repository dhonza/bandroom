import { isLossyVersion, type TrackVersion } from "@bandroom/shared";
import { Badge, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../i18n/format";

/** Why a version is lossy, in words: removed (when, by whom) or a lossy source. */
export function useLossyReason(): (v: Pick<TrackVersion, "media" | "archived">) => string {
  const { t } = useTranslation();
  const fmt = useFormatters();
  return (v) =>
    v.archived
      ? v.archived.by
        ? t("lossless.removedOnBy", {
            date: fmt.date(v.archived.at),
            name: v.archived.by.displayName,
          })
        : t("lossless.removedOn", { date: fmt.date(v.archived.at) })
      : t("lossless.lossySource");
}

/**
 * The one "Lossy" badge of a version (SPEC §26.4): its tooltip says whether the source was lossy
 * or the full-quality files were removed (when, by whom). Nothing for full-quality versions.
 */
export function LossyBadge({
  version,
  size = "xs",
}: {
  version: Pick<TrackVersion, "media" | "archived">;
  size?: "xs" | "sm";
}) {
  const { t } = useTranslation();
  const reason = useLossyReason();
  if (!isLossyVersion(version)) return null;
  const text = reason(version);
  return (
    <Tooltip label={text} multiline maw={260} events={{ hover: true, focus: true, touch: true }}>
      <Badge
        size={size}
        variant="outline"
        color="yellow"
        tabIndex={0}
        aria-label={`${t("lossless.badge")}: ${text}`}
        data-testid="lossy-badge"
        data-reason={version.archived ? "removed" : "source"}
        style={{ flex: "none" }}
      >
        {t("lossless.badge")}
      </Badge>
    </Tooltip>
  );
}
