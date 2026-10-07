import type { TrashItem, TrashList } from "@bandroom/shared";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  Menu,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowBackUp,
  IconDots,
  IconFileText,
  IconFolder,
  IconMusic,
  IconStack2,
  IconTrash,
  IconTrashX,
  IconWaveSine,
} from "@tabler/icons-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../api/useApiError";
import { errorMessage } from "../api/errorMessage";
import { ConfirmDeleteModal } from "../components/ConfirmDeleteModal";
import { useFormatters } from "../i18n/format";
import { formatBytes } from "../lib/media";
import { SelectionBar } from "../selection/SelectionBar";
import { trashSelection } from "../selection/store";
import { useSelection } from "../selection/useSelection";
import { purgeItems, restoreItems, useInvalidateBatch, withParents } from "./queries";

const KIND_ICON: Record<TrashItem["kind"], ReactNode> = {
  project: <IconFolder size={18} aria-hidden />,
  song: <IconMusic size={18} aria-hidden />,
  track: <IconWaveSine size={18} aria-hidden />,
  version: <IconStack2 size={18} aria-hidden />,
  document: <IconFileText size={18} aria-hidden />,
};

/**
 * A Trash list (SPEC §26.3): the project's (`scope` = project id) or every project's (admin).
 * Restore and Delete permanently per row or for a selection, and Empty Trash.
 */
export function TrashPanel({
  scope,
  query,
  showProject = false,
}: {
  scope: string;
  query: UseQueryResult<TrashList>;
  showProject?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateBatch();
  const items = query.data?.items ?? [];
  const selection = useSelection(
    trashSelection,
    scope,
    items.map((i) => i.id),
  );
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ items: TrashItem[]; empty: boolean } | null>(null);

  if (query.isPending) {
    return (
      <Center mih={120}>
        <Loader />
      </Center>
    );
  }
  if (query.isError) return <Alert color="red">{errorMessage(t, query.error)}</Alert>;
  const { retentionDays } = query.data;
  const selected = items.filter((i) => selection.ids.has(i.id));
  const size = (n: number) => formatBytes(n, i18n.language);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
      selection.exit();
    } catch (err) {
      notifications.show({ color: "red", message: apiError(err) });
    } finally {
      setBusy(false);
      invalidate();
    }
  };
  const restore = (chosen: readonly TrashItem[]) => {
    const all = withParents(
      chosen.filter((i) => i.canRestore),
      items,
    );
    if (!all) {
      notifications.show({ color: "red", message: t("trash.restoreNeedsSong") });
      return;
    }
    void run(async () => {
      await restoreItems(all);
      notifications.show({
        color: "teal",
        message: t("selection.restored", { count: all.length }),
      });
    });
  };
  const purge = (chosen: readonly TrashItem[]) => {
    void run(async () => {
      const bytes = await purgeItems(chosen);
      setConfirm(null);
      notifications.show({ color: "teal", message: t("trash.purged", { size: size(bytes) }) });
    });
  };
  const purgeable = items.filter((i) => i.canPurge);
  const selRestorable = selected.filter((i) => i.canRestore);
  const selPurgeable = selected.filter((i) => i.canPurge);

  return (
    <Stack gap="sm" data-testid="trash-panel">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 200 }}>
          {showProject
            ? t("trash.adminExplain", { days: retentionDays })
            : t("trash.explain", { days: retentionDays })}
        </Text>
        {items.length > 0 && (
          <Group gap="xs">
            {!selection.active && (
              <Button
                variant="default"
                h={44}
                onClick={() => {
                  selection.start();
                }}
                data-testid="trash-select"
              >
                {t("selection.select")}
              </Button>
            )}
            {purgeable.length > 0 && (
              <Button
                variant="light"
                color="red"
                h={44}
                leftSection={<IconTrashX size={16} />}
                onClick={() => {
                  setConfirm({ items: purgeable, empty: true });
                }}
                data-testid="trash-empty"
              >
                {t("trash.emptyTrash")}
              </Button>
            )}
          </Group>
        )}
      </Group>
      {items.length === 0 ? (
        <Center mih={160}>
          <Stack align="center" gap="sm">
            <ThemeIcon size={56} radius="xl" variant="light" color="gray">
              <IconTrash size={28} aria-hidden />
            </ThemeIcon>
            <Text c="dimmed">{t("trash.empty")}</Text>
          </Stack>
        </Center>
      ) : (
        <Stack gap="xs" data-testid="trash-list">
          {items.map((item) => (
            <TrashRow
              key={`${item.kind}:${item.id}`}
              item={item}
              all={items}
              showProject={showProject}
              selecting={selection.active}
              selected={selection.ids.has(item.id)}
              busy={busy}
              onToggle={() => {
                selection.toggle(item.id);
              }}
              onRestore={() => {
                restore([item]);
              }}
              onPurge={() => {
                setConfirm({ items: [item], empty: false });
              }}
            />
          ))}
        </Stack>
      )}
      {selection.active && (
        <SelectionBar
          testId="trash-selection-bar"
          count={selected.length}
          total={items.length}
          onSelectAll={() => {
            selection.setAll(items.map((i) => i.id));
          }}
          onExit={selection.exit}
          actions={[
            {
              key: "restore",
              label: t("trash.restore"),
              icon: <IconArrowBackUp size={16} />,
              allowed: selRestorable.length,
              reason: t("trash.notAllowed", { count: selected.length - selRestorable.length }),
              loading: busy,
              onClick: () => {
                restore(selRestorable);
              },
            },
            {
              key: "purge",
              label: t("trash.purge"),
              icon: <IconTrashX size={16} />,
              color: "red",
              allowed: selPurgeable.length,
              reason: t("trash.notAllowed", { count: selected.length - selPurgeable.length }),
              onClick: () => {
                setConfirm({ items: selPurgeable, empty: false });
              },
            },
          ]}
        />
      )}
      {confirm && (
        <ConfirmDeleteModal
          opened
          onClose={() => {
            setConfirm(null);
          }}
          title={confirm.empty ? t("trash.emptyTitle") : t("trash.purgeTitle")}
          explanation={t("trash.purgeExplain", { count: confirm.items.length })}
          name={t("trash.confirmWord")}
          loading={busy}
          error={null}
          onConfirm={() => {
            purge(confirm.items);
          }}
        />
      )}
    </Stack>
  );
}

function TrashRow({
  item,
  all,
  showProject,
  selecting,
  selected,
  busy,
  onToggle,
  onRestore,
  onPurge,
}: {
  item: TrashItem;
  all: readonly TrashItem[];
  showProject: boolean;
  selecting: boolean;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const { t, i18n } = useTranslation();
  const fmt = useFormatters();
  const name =
    item.kind === "version"
      ? t("trash.versionName", { track: item.track?.name ?? "", number: item.number ?? 0 }) +
        (item.name ? ` · ${item.name}` : "")
      : item.name;
  const where = [
    showProject && item.kind !== "project" ? item.project.name : null,
    item.kind !== "song" && item.song ? t("trash.inSong", { song: item.song.title }) : null,
  ].filter(Boolean);
  const parentGone = item.kind !== "song" && item.song?.deleted === true;
  const trackGone = item.kind === "version" && item.track?.deleted === true;
  const needsParents = parentGone || trackGone;
  const parentsOk = !needsParents || withParents([item], all) !== null;
  const meta = [
    item.deletedBy
      ? t("trash.deletedBy", { name: item.deletedBy.displayName })
      : t("trash.deletedUnknown"),
    fmt.dateTime(item.deletedAt),
    item.bytes > 0 ? t("trash.frees", { size: formatBytes(item.bytes, i18n.language) }) : null,
    // A copy keeps the files, so purging frees nothing (or less) on the disk (SPEC §26.6).
    item.shared ? t("trash.sharedWithCopy") : null,
    t("trash.purgeOn", { date: fmt.date(item.purgeAt) }),
  ].filter(Boolean);

  return (
    <Paper
      withBorder
      radius="md"
      p="xs"
      data-testid="trash-row"
      data-kind={item.kind}
      data-name={item.kind === "version" ? (item.track?.name ?? "") : item.name}
      onClick={selecting ? onToggle : undefined}
      style={{ cursor: selecting ? "pointer" : undefined }}
    >
      <Group gap="xs" wrap="wrap" align="center">
        {selecting && (
          <Checkbox
            checked={selected}
            onChange={onToggle}
            onClick={(e) => {
              e.stopPropagation();
            }}
            aria-label={t("selection.selectItem", { name })}
            styles={{ body: { minHeight: 44, alignItems: "center" } }}
            data-testid="trash-row-check"
          />
        )}
        <ThemeIcon variant="light" color="gray" size={36} radius="md">
          {KIND_ICON[item.kind]}
        </ThemeIcon>
        {/* Wraps the actions below the text on phones. */}
        <Stack gap={2} style={{ flex: "1 1 200px", minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <Text fw={600} size="sm" truncate>
              {name}
            </Text>
            <Badge size="xs" variant="light" color="gray">
              {t(`trash.kind.${item.kind}`)}
            </Badge>
            {(parentGone || trackGone) && (
              <Badge size="xs" variant="outline" color="yellow">
                {parentGone ? t("trash.songDeleted") : t("trash.trackDeleted")}
              </Badge>
            )}
          </Group>
          {where.length > 0 && (
            <Text size="xs" c="dimmed" truncate>
              {where.join(" · ")}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {meta.join(" · ")}
          </Text>
        </Stack>
        {!selecting && (
          <Group gap={0} wrap="nowrap" ml="auto">
            {item.canRestore && (
              <Tooltip label={t("trash.restoreNeedsSong")} disabled={parentsOk}>
                <Button
                  variant="subtle"
                  size="compact-sm"
                  h={44}
                  leftSection={<IconArrowBackUp size={16} />}
                  disabled={!parentsOk || busy}
                  onClick={onRestore}
                  data-testid="trash-restore"
                >
                  {needsParents ? t("trash.restoreWithSong") : t("trash.restore")}
                </Button>
              </Tooltip>
            )}
            {item.canPurge && (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size={44}
                    aria-label={t("common.actions")}
                    data-testid="trash-row-menu"
                  >
                    <IconDots size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    color="red"
                    leftSection={<IconTrashX size={16} />}
                    onClick={onPurge}
                    data-testid="trash-purge"
                  >
                    {t("trash.purge")}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
        )}
      </Group>
    </Paper>
  );
}
