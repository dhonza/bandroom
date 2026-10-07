import { isLossyVersion, type TrackVersion } from "@bandroom/shared";
import { Badge, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../i18n/format";

/** Message keys per archive reason (SPEC §26.4, §28.2, §28.3): without and with a name. */
const ARCHIVED_TEXT = {
  removed: ["lossless.removedOn", "lossless.removedOnBy"],
  upload: ["lossless.convertedOnUpload", "lossless.convertedOnUploadBy"],
  reencode: ["lossless.reencodedOn", "lossless.reencodedOnBy"],
} as const;

/**
 * Why a version is lossy, in words: full quality removed, converted on upload or re-encoded
 * (when, by whom), or a lossy source.
 */
export function useLossyReason(): (v: Pick<TrackVersion, "media" | "archived">) => string {
  const { t } = useTranslation();
  const fmt = useFormatters();
  return (v) => {
    if (!v.archived) return t("lossless.lossySource");
    const [plain, named] = ARCHIVED_TEXT[v.archived.reason];
    const date = fmt.date(v.archived.at);
    return v.archived.by ? t(named, { date, name: v.archived.by.displayName }) : t(plain, { date });
  };
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
        data-reason={version.archived ? version.archived.reason : "source"}
        style={{ flex: "none" }}
      >
        {t("lossless.badge")}
      </Badge>
    </Tooltip>
  );
}
