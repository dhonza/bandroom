import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  Menu,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconCloudCheck,
  IconCloudDown,
  IconCloudExclamation,
  IconRefresh,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { formatBytes } from "../lib/media";
import { isPhoneDevice } from "../rehearse/prefs";
import { PHONE_QUERY } from "../shell/mediaQueries";
import {
  deviceOfflinePrefs,
  estimateOffline,
  makeAvailableOffline,
  offlineItemFor,
  offlineSupported,
  refreshItem,
  removeOffline,
  setDeviceOfflinePrefs,
  useOffline,
} from "./controller";
import { itemKey, type OfflineItem } from "./db";
import { InstallHint } from "./InstallHint";
import { useOnline } from "./online";
import { isIos, isStandalone } from "./pwa";

const GREEN = "green";
const GRAY = "gray";

export interface OfflineTarget {
  kind: OfflineItem["kind"];
  id: string;
  title: string;
  projectId: string;
}

/** Percentage of a running download. */
export function useDownloadPercent(key: string): number | null {
  const p = useOffline((s) => s.progress[key]);
  if (!p) return null;
  return p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
}

/**
 * "Make available offline" on a song or project (SPEC §13), with the size estimate first; once
 * downloaded, a menu to update or remove it. The label is short ("Offline") so the song header
 * stays compact; icon and colour show the state, which the tooltip and accessible name spell out.
 */
export function OfflineButton(target: OfflineTarget) {
  const { t, i18n } = useTranslation();
  const online = useOnline();
  const isPhone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const key = itemKey(target.kind, target.id);
  const items = useOffline((s) => s.items);
  const ready = useOffline((s) => s.userId !== null);
  const own = items.find((i) => i.key === key);
  // A song may be offline as part of its project.
  const viaProject = !own && target.kind === "song" ? offlineItemFor(target.id, items) : undefined;
  const percent = useDownloadPercent(key);
  const [open, setOpen] = useState(false);
  if (!offlineSupported() || !ready) return null;

  const compact = (
    label: string,
    hint: string,
    icon: React.ReactNode,
    color: string,
    onClick?: () => void,
  ) =>
    isPhone ? (
      <Tooltip label={hint}>
        <ActionIcon
          size={44}
          variant="default"
          color={color}
          aria-label={hint}
          onClick={onClick}
          data-testid="offline-button"
          data-status={own?.status ?? (viaProject ? "project" : "none")}
        >
          {icon}
        </ActionIcon>
      </Tooltip>
    ) : (
      <Tooltip label={hint} disabled={hint === label}>
        <Button
          variant={own || viaProject ? "light" : "default"}
          color={color}
          h={44}
          leftSection={icon}
          onClick={onClick}
          aria-label={hint}
          data-testid="offline-button"
          data-status={own?.status ?? (viaProject ? "project" : "none")}
        >
          {label}
        </Button>
      </Tooltip>
    );
  const short = t("offline.button.make");

  if (viaProject) {
    return (
      <Link to="/offline" style={{ display: "contents" }}>
        {compact(short, t("offline.button.viaProject"), <IconCloudCheck size={18} />, GREEN)}
      </Link>
    );
  }

  if (!own) {
    if (!online) {
      return (
        <Tooltip label={t("offline.needsNetwork")}>
          <span>
            <Button
              variant="default"
              h={44}
              disabled
              leftSection={<IconCloudDown size={16} />}
              aria-label={t("offline.button.makeHint")}
            >
              {isPhone ? null : short}
            </Button>
          </span>
        </Tooltip>
      );
    }
    return (
      <>
        {compact(short, t("offline.button.makeHint"), <IconCloudDown size={18} />, GRAY, () => {
          setOpen(true);
        })}
        {open && (
          <OfflineModal
            target={target}
            onClose={() => {
              setOpen(false);
            }}
          />
        )}
      </>
    );
  }

  if (own.status === "downloading") {
    const label =
      percent === null
        ? t("offline.button.preparing")
        : t("offline.button.downloading", { percent });
    return compact(label, label, <Loader size={16} />, "blue");
  }

  const [hint, icon, color] =
    own.status === "error"
      ? [t("offline.button.failed"), <IconCloudExclamation key="i" size={18} />, "red"]
      : own.status === "outdated"
        ? [t("offline.button.outdated"), <IconCloudDown key="i" size={18} />, "yellow"]
        : [t("offline.button.ready"), <IconCloudCheck key="i" size={18} />, "green"];

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>{compact(short, hint, icon, color)}</Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          {t("offline.sizeOnDevice", {
            size: formatBytes(own.bytes, i18n.resolvedLanguage ?? "en"),
          })}
        </Menu.Label>
        <Menu.Item
          leftSection={<IconRefresh size={14} />}
          disabled={!online}
          onClick={() => void refreshItem(key)}
          data-testid="offline-update"
        >
          {t("offline.updateNow")}
        </Menu.Item>
        <Menu.Item leftSection={<IconSettings size={14} />} component={Link} to="/offline">
          {t("offline.manage")}
        </Menu.Item>
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={14} />}
          onClick={() => void removeOffline(key)}
          data-testid="offline-remove"
        >
          {t("offline.remove")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/** Size estimate and options before the download (SPEC §13). */
export function OfflineModal({ target, onClose }: { target: OfflineTarget; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const [prefs, setPrefs] = useState(deviceOfflinePrefs);
  const [estimate, setEstimate] = useState<
    { bytes: number; missing: number; songs: number } | "error" | null
  >(null);
  const desktop = !isPhoneDevice();

  useEffect(() => {
    let cancelled = false;
    estimateOffline(target.kind, target.id, prefs).then(
      (e) => {
        if (!cancelled) setEstimate(e);
      },
      () => {
        if (!cancelled) setEstimate("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [target.kind, target.id, prefs]);

  const start = () => {
    setDeviceOfflinePrefs(prefs);
    onClose();
    void makeAvailableOffline(target.kind, target.id, target.title, target.projectId, prefs).then(
      (done) => {
        notifications.show({
          color: done ? "green" : "red",
          message: done
            ? t("offline.downloaded", { title: target.title })
            : t("offline.downloadFailed", { title: target.title }),
        });
      },
    );
  };

  return (
    <Modal opened onClose={onClose} title={t("offline.modal.title")} centered>
      <Stack gap="md" data-testid="offline-modal">
        <Text size="sm">
          {t(target.kind === "song" ? "offline.modal.songExplain" : "offline.modal.projectExplain")}
        </Text>
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            {t("offline.quality.label")}
          </Text>
          <SegmentedControl
            fullWidth
            value={prefs.quality}
            onChange={(v) => {
              setEstimate(null);
              setPrefs((p) => ({ ...p, quality: v }));
            }}
            data={[
              { value: "normal", label: t("offline.quality.normal") },
              { value: "small", label: t("offline.quality.small") },
            ]}
          />
        </Stack>
        {desktop && (
          <Checkbox
            checked={prefs.lossless}
            onChange={(e) => {
              const lossless = e.currentTarget.checked;
              setEstimate(null);
              setPrefs((p) => ({ ...p, lossless }));
            }}
            label={t("offline.quality.lossless")}
          />
        )}
        {estimate === null ? (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              {t("offline.modal.estimating")}
            </Text>
          </Group>
        ) : estimate === "error" ? (
          <Alert color="red">{t("offline.modal.estimateFailed")}</Alert>
        ) : (
          <Text size="sm" data-testid="offline-estimate">
            {target.kind === "project"
              ? t("offline.modal.sizeProject", {
                  size: formatBytes(estimate.bytes, locale),
                  count: estimate.songs,
                })
              : t("offline.modal.size", { size: formatBytes(estimate.bytes, locale) })}
            {estimate.missing < estimate.bytes &&
              ` ${t("offline.modal.toDownload", { size: formatBytes(estimate.missing, locale) })}`}
          </Text>
        )}
        {isIos() && !isStandalone() && <InstallHint />}
        <Group justify="flex-end">
          <Button variant="default" h={44} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            h={44}
            leftSection={<IconCloudDown size={16} />}
            disabled={estimate === null || estimate === "error"}
            onClick={start}
            data-testid="offline-download"
          >
            {t("offline.modal.download")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
