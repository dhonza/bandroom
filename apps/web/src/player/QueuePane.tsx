import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ActionIcon,
  Button,
  Drawer,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconArrowDown, IconArrowUp, IconGripVertical, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ProjectImage } from "../components/ProjectImage";
import {
  clearUpcoming,
  moveInQueue,
  playQueueAt,
  removeFromQueue,
  useRehearse,
} from "../rehearse/controller";
import { COARSE_POINTER_QUERY } from "../shell/mediaQueries";
import type { QueueEntry } from "./queue";

/**
 * The play queue (SPEC §6.10): "Next from <project>" (or "Up next" once it mixes projects), the
 * playing song highlighted. A tap plays a song, ✕ takes one out, Clear keeps only the playing
 * song. Reorder by dragging the handle (mouse) or with the up/down buttons (touch, keyboard).
 */
export function QueueList() {
  const { t } = useTranslation();
  const queue = useRehearse((s) => s.queue);
  const coarse = useMediaQuery(COARSE_POINTER_QUERY, false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  if (!queue) return null;
  const { entries, index, source } = queue;
  const ids = entries.map((e) => e.songId);
  const onDragEnd = (e: DragEndEvent) => {
    const from = ids.indexOf(String(e.active.id));
    const to = e.over ? ids.indexOf(String(e.over.id)) : -1;
    if (from >= 0 && to >= 0) moveInQueue(from, to);
  };
  return (
    <Stack gap="xs" data-testid="queue-list">
      <Group justify="space-between" wrap="nowrap">
        <Title order={3} size="h5" lineClamp={1} data-testid="queue-title">
          {source.kind === "mixed"
            ? t("listen.upNext")
            : t("listen.nextFrom", { project: source.projectName })}
        </Title>
        <Button
          variant="subtle"
          color="gray"
          h={44}
          onClick={clearUpcoming}
          disabled={entries.length <= 1}
          data-testid="queue-clear"
        >
          {t("listen.clearQueue")}
        </Button>
      </Group>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <Stack gap={4}>
            {entries.map((e, i) => (
              <QueueRow
                key={e.songId}
                entry={e}
                index={i}
                count={entries.length}
                current={i === index}
                draggable={!coarse}
              />
            ))}
          </Stack>
        </SortableContext>
      </DndContext>
    </Stack>
  );
}

function QueueRow({
  entry,
  index,
  count,
  current,
  draggable,
}: {
  entry: QueueEntry;
  index: number;
  count: number;
  current: boolean;
  draggable: boolean;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.songId, disabled: !draggable });
  const title = entry.title;
  return (
    <Paper
      ref={setNodeRef}
      radius="sm"
      data-testid="queue-row"
      data-current={current || undefined}
      aria-current={current ? "true" : undefined}
      bg={current ? "var(--mantine-primary-color-light)" : undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        position: "relative",
        zIndex: isDragging ? 1 : undefined,
      }}
    >
      <Group gap={0} wrap="nowrap">
        {draggable && (
          <ActionIcon
            ref={setActivatorNodeRef}
            variant="subtle"
            color="gray"
            size={44}
            aria-label={t("listen.dragInQueue", { title })}
            style={{ cursor: "grab", touchAction: "none", flex: "none" }}
            {...attributes}
            {...listeners}
          >
            <IconGripVertical size={16} />
          </ActionIcon>
        )}
        <UnstyledButton
          onClick={() => {
            playQueueAt(index);
          }}
          disabled={!entry.ready}
          aria-label={t("listen.playFromQueue", { title })}
          px={draggable ? 0 : "xs"}
          py={4}
          mih={44}
          style={{ flex: 1, minWidth: 0, opacity: entry.ready ? 1 : 0.5 }}
          data-testid="queue-row-play"
        >
          <Group gap="sm" wrap="nowrap">
            <ProjectImage
              name={entry.projectName}
              color="violet"
              imageHash={entry.imageHash}
              size={36}
              radius="var(--mantine-radius-xs)"
            />
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" fw={current ? 700 : 500} truncate data-testid="queue-row-title">
                {title}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {entry.ready ? entry.projectName : t("listen.notReady")}
              </Text>
            </Stack>
          </Group>
        </UnstyledButton>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={44}
          disabled={index === 0}
          onClick={() => {
            moveInQueue(index, index - 1);
          }}
          aria-label={t("listen.moveUp", { title })}
          data-testid="queue-row-up"
          style={{ flex: "none" }}
        >
          <IconArrowUp size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={44}
          disabled={index === count - 1}
          onClick={() => {
            moveInQueue(index, index + 1);
          }}
          aria-label={t("listen.moveDown", { title })}
          data-testid="queue-row-down"
          style={{ flex: "none" }}
        >
          <IconArrowDown size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={44}
          // The playing song stays in the queue (✕ in the player closes it).
          disabled={current}
          onClick={() => {
            removeFromQueue(index);
          }}
          aria-label={t("listen.removeFromQueue", { title })}
          data-testid="queue-row-remove"
          style={{ flex: "none" }}
        >
          <IconX size={16} />
        </ActionIcon>
      </Group>
    </Paper>
  );
}

/** The queue as a right-side pane (desktop player bar). */
export function QueueDrawer({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={400}
      title={t("listen.queue")}
      closeButtonProps={{ "aria-label": t("common.close") }}
      data-testid="queue-pane"
    >
      <QueueList />
    </Drawer>
  );
}
