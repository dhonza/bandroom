import type { TrackVersion } from "@bandroom/shared";
import { ActionIcon, Button, FileButton, Group, Menu, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconDots,
  IconDownload,
  IconPencil,
  IconRefresh,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { downloadUrl } from "../../lib/media";
import { PHONE_QUERY } from "../../shell/mediaQueries";

/** "New version" upload button and the track's "⋯" menu (edit, downloads, retry, delete). */
export function TrackMenu({
  version,
  canDelete,
  canRetry,
  canUpload,
  onDelete,
  onRetry,
  onUpload,
  canEditTrack,
  onEditTrack,
}: {
  canEditTrack: boolean;
  onEditTrack: () => void;
  version: TrackVersion | null;
  canDelete: boolean;
  canRetry: boolean;
  canUpload: boolean;
  onDelete: () => void;
  onRetry: () => void;
  onUpload: (f: File | null) => void;
}) {
  const { t } = useTranslation();
  // Phones: "New version" is an icon, so the track name keeps its room (360 px).
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const downloads = version?.downloads ?? [];
  if (!canDelete && !canRetry && !canUpload && !canEditTrack && downloads.length === 0) return null;
  return (
    <Group gap={0} wrap="nowrap">
      {canUpload && (
        <FileButton
          onChange={onUpload}
          accept="audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a,.ogg,.opus,.wv"
        >
          {(props) =>
            phone ? (
              <Tooltip label={t("tracks.newVersion")}>
                <ActionIcon
                  {...props}
                  variant="subtle"
                  size={44}
                  aria-label={t("tracks.newVersion")}
                  data-testid="upload-version"
                >
                  <IconUpload size={20} />
                </ActionIcon>
              </Tooltip>
            ) : (
              <Button
                {...props}
                variant="subtle"
                size="compact-sm"
                mih={44}
                leftSection={<IconUpload size={16} />}
                data-testid="upload-version"
              >
                {t("tracks.newVersion")}
              </Button>
            )
          }
        </FileButton>
      )}
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            size={44}
            aria-label={t("common.actions")}
            data-testid="track-actions"
          >
            <IconDots size={20} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {canEditTrack && (
            <Menu.Item
              leftSection={<IconPencil size={16} />}
              onClick={onEditTrack}
              data-testid="edit-track"
            >
              {t("tracks.edit")}
            </Menu.Item>
          )}
          {version &&
            downloads.map((f) => (
              <Menu.Item
                key={f}
                component="a"
                href={downloadUrl(version.id, f)}
                download
                leftSection={<IconDownload size={16} />}
                data-testid={`download-${f}`}
              >
                {t(`tracks.download.${f}`)}
              </Menu.Item>
            ))}
          {canRetry && (
            <Menu.Item leftSection={<IconRefresh size={16} />} onClick={onRetry}>
              {t("tracks.retry")}
            </Menu.Item>
          )}
          {canDelete && (
            <>
              {downloads.length > 0 && <Menu.Divider />}
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={onDelete}
                data-testid="delete-track"
              >
                {t("tracks.delete")}
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
