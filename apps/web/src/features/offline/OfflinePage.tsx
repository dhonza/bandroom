import type { OfflineQuality } from "@bandroom/shared";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Checkbox,
  Group,
  Progress,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { IconCloudDown, IconRefresh, IconSend, IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useFormatters } from "../../i18n/format";
import { formatBytes } from "../../lib/media";
import {
  deviceOfflinePrefs,
  offlineSupported,
  refreshItem,
  removeAllOffline,
  removeOffline,
  replayNow,
  setAutoUpdate,
  setDeviceOfflinePrefs,
  useOffline,
} from "../../offline/controller";
import type { OfflineItem } from "../../offline/db";
import { InstallHint } from "../../offline/InstallHint";
import { PendingTakes } from "../../record/PendingTakes";
import { useTakes } from "../../record/takes";
import { useDownloadPercent } from "../../offline/OfflineButton";
import { useOnline } from "../../offline/online";
import { isPhoneDevice } from "../../rehearse/prefs";
import { AppModal } from "../../components/ResponsivePanel";

interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean | null;
}

function useStorageInfo(deps: unknown): StorageInfo | null {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  useEffect(() => {
    const run = { cancelled: false };
    void (async () => {
      try {
        const est = await navigator.storage.estimate();
        const persisted = await navigator.storage.persisted().catch(() => null);
        if (!run.cancelled) setInfo({ usage: est.usage ?? 0, quota: est.quota ?? 0, persisted });
      } catch {
        if (!run.cancelled) setInfo(null);
      }
    })();
    return () => {
      run.cancelled = true;
    };
  }, [deps]);
  return info;
}

/**
 * Offline page = storage management (SPEC §11.2, §13): offline songs and projects with sizes,
 * update status, auto-update and remove; the storage usage bar; install instructions; pending
 * offline changes; defaults for new downloads.
 */
export function OfflinePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const items = useOffline((s) => s.items);
  const outbox = useOffline((s) => s.outbox);
  const pendingTakes = useTakes((s) => s.pending.length);
  const online = useOnline();
  const storage = useStorageInfo(items);
  const sorted = [...items].sort((a, b) => a.title.localeCompare(b.title, locale));
  const total = items.reduce((n, i) => n + i.bytes, 0);

  const [confirmAll, setConfirmAll] = useState(false);

  return (
    <Stack gap="lg" data-testid="offline-page">
      <Title order={2}>{t("pages.offline.title")}</Title>

      {!offlineSupported() && <Alert color="yellow">{t("offline.unsupported")}</Alert>}

      <Card withBorder padding="md">
        <Stack gap="xs">
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Text fw={600}>{t("offline.storage.title")}</Text>
            <Text size="sm" c="dimmed" data-testid="offline-total">
              {t("offline.storage.offlineTotal", { size: formatBytes(total, locale) })}
            </Text>
          </Group>
          {storage && storage.quota > 0 ? (
            <>
              <Progress
                value={Math.min(100, (storage.usage / storage.quota) * 100)}
                aria-label={t("offline.storage.title")}
              />
              <Text size="sm" c="dimmed">
                {t("offline.storage.usage", {
                  used: formatBytes(storage.usage, locale),
                  quota: formatBytes(storage.quota, locale),
                })}
              </Text>
            </>
          ) : (
            <Text size="sm" c="dimmed">
              {t("offline.storage.unknown")}
            </Text>
          )}
          {storage?.persisted !== null && storage?.persisted !== undefined && (
            <Text size="sm" c={storage.persisted ? "green" : "yellow"} data-testid="persisted">
              {storage.persisted
                ? t("offline.storage.persisted")
                : t("offline.storage.notPersisted")}
            </Text>
          )}
          <InstallHint always />
        </Stack>
      </Card>

      {pendingTakes > 0 && (
        <Stack gap="xs" data-testid="offline-pending-takes">
          <Text fw={600}>{t("record.pending.title")}</Text>
          <Text size="sm" c="dimmed">
            {t("record.pending.explain")}
          </Text>
          <PendingTakes />
        </Stack>
      )}

      {outbox.length > 0 && (
        <Alert color="yellow" variant="light" data-testid="outbox-pending">
          <Group justify="space-between" gap="xs">
            <Text size="sm">{t("offline.outbox.pending", { count: outbox.length })}</Text>
            <Button
              h={44}
              variant="light"
              leftSection={<IconSend size={16} />}
              disabled={!online}
              onClick={() => void replayNow()}
            >
              {t("offline.outbox.sendNow")}
            </Button>
          </Group>
        </Alert>
      )}

      {sorted.length === 0 ? (
        <Center mih={200}>
          <Stack align="center" gap="sm" maw={420}>
            <ThemeIcon size={64} radius="xl" variant="light">
              <IconCloudDown size={34} aria-hidden />
            </ThemeIcon>
            <Text ta="center" c="dimmed">
              {t("pages.offline.empty")}
            </Text>
            <Text ta="center" size="sm" c="dimmed">
              {t("offline.emptyHint")}
            </Text>
          </Stack>
        </Center>
      ) : (
        <Stack gap="sm">
          {sorted.map((item) => (
            <OfflineItemCard key={item.key} item={item} online={online} />
          ))}
          <Group justify="flex-end">
            <Button
              variant="subtle"
              color="red"
              h={44}
              leftSection={<IconTrash size={16} />}
              onClick={() => {
                setConfirmAll(true);
              }}
              data-testid="offline-remove-all"
            >
              {t("offline.removeAll")}
            </Button>
          </Group>
        </Stack>
      )}

      <DefaultsCard />

      <AppModal
        opened={confirmAll}
        onClose={() => {
          setConfirmAll(false);
        }}
        title={t("offline.removeAllTitle")}
        centered
      >
        <Stack gap="md">
          <Text size="sm">{t("offline.removeAllExplain")}</Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              h={44}
              onClick={() => {
                setConfirmAll(false);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              color="red"
              h={44}
              onClick={() => {
                setConfirmAll(false);
                void removeAllOffline();
              }}
              data-testid="offline-remove-all-confirm"
            >
              {t("offline.removeAll")}
            </Button>
          </Group>
        </Stack>
      </AppModal>
    </Stack>
  );
}

function statusKey(item: OfflineItem) {
  switch (item.status) {
    case "downloading":
      return "offline.status.downloading" as const;
    case "outdated":
      return "offline.status.outdated" as const;
    case "error":
      return item.error === "STORAGE_FULL"
        ? ("offline.status.storageFull" as const)
        : ("offline.status.error" as const);
    default:
      return "offline.status.ready" as const;
  }
}

function OfflineItemCard({ item, online }: { item: OfflineItem; online: boolean }) {
  const { t, i18n } = useTranslation();
  const fmt = useFormatters();
  const percent = useDownloadPercent(item.key);
  const locale = i18n.resolvedLanguage ?? "en";
  const color =
    item.status === "error"
      ? "red"
      : item.status === "outdated"
        ? "yellow"
        : item.status === "downloading"
          ? "blue"
          : "green";
  return (
    <Card withBorder padding="sm" data-testid="offline-item" data-status={item.status}>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Anchor
              component={Link}
              to={item.kind === "song" ? `/songs/${item.id}` : `/projects/${item.id}`}
              fw={600}
              style={{ overflowWrap: "anywhere" }}
            >
              {item.title}
            </Anchor>
            <Text size="xs" c="dimmed">
              {[
                t(item.kind === "song" ? "offline.kind.song" : "offline.kind.project", {
                  count: item.songIds.length,
                }),
                formatBytes(item.bytes, locale),
                t(item.quality === "small" ? "offline.quality.small" : "offline.quality.normal"),
                ...(item.lossless ? [t("offline.quality.flac")] : []),
              ].join(" · ")}
            </Text>
          </Stack>
          <Badge
            color={color}
            variant="light"
            style={{ flex: "none" }}
            data-testid="offline-item-status"
          >
            {t(statusKey(item))}
          </Badge>
        </Group>
        {item.status === "downloading" && <Progress value={percent ?? 0} animated />}
        <Text size="xs" c="dimmed">
          {item.syncedAt
            ? t("offline.lastUpdated", { when: fmt.relative(item.syncedAt) })
            : t("offline.notYet")}
        </Text>
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Switch
            checked={item.autoUpdate}
            onChange={(e) => void setAutoUpdate(item.key, e.currentTarget.checked)}
            label={t("offline.autoUpdate")}
            styles={{ body: { alignItems: "center", minHeight: 44 } }}
          />
          <Group gap="xs">
            <Button
              variant="default"
              h={44}
              leftSection={<IconRefresh size={16} />}
              disabled={!online || item.status === "downloading"}
              onClick={() => void refreshItem(item.key)}
              data-testid="offline-item-update"
            >
              {t("offline.updateNow")}
            </Button>
            <Button
              variant="subtle"
              color="red"
              h={44}
              leftSection={<IconTrash size={16} />}
              onClick={() => void removeOffline(item.key)}
              data-testid="offline-item-remove"
            >
              {t("offline.remove")}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Card>
  );
}

/** Quality for new downloads on this device (SPEC §13 "small" and "offline lossless"). */
function DefaultsCard() {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState(deviceOfflinePrefs);
  const update = (p: { quality: OfflineQuality; lossless: boolean }) => {
    setPrefs(p);
    setDeviceOfflinePrefs(p);
  };
  return (
    <Card withBorder padding="md">
      <Stack gap="xs">
        <Text fw={600}>{t("offline.defaults.title")}</Text>
        <Text size="sm" c="dimmed">
          {t("offline.defaults.explain")}
        </Text>
        <SegmentedControl
          value={prefs.quality}
          onChange={(v) => {
            update({ ...prefs, quality: v });
          }}
          data={[
            { value: "normal", label: t("offline.quality.normal") },
            { value: "small", label: t("offline.quality.small") },
          ]}
        />
        {!isPhoneDevice() && (
          <Checkbox
            checked={prefs.lossless}
            onChange={(e) => {
              update({ ...prefs, lossless: e.currentTarget.checked });
            }}
            label={t("offline.quality.lossless")}
          />
        )}
      </Stack>
    </Card>
  );
}
