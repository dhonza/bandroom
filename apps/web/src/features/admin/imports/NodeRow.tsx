import { type ImportMapping, type ImportNode, type ImportProject } from "@bandroom/shared";
import {
  Badge,
  Box,
  Checkbox,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconFile, IconFolder, IconStack2 } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatBytes, formatDuration } from "../../../lib/media";
import {
  actionsFor,
  canGroup,
  nodeStats,
  setDocumentTarget,
  setNodeAction,
  setSongTitle,
  setTrackName,
  songLabel,
  songTargets,
} from "./mappingEdit";

const KIND_ICON = { folder: IconFolder, stack: IconStack2, file: IconFile } as const;

/** Applies an edit to the review mapping. */
export type Edit = (fn: (m: ImportMapping) => ImportMapping) => void;

/** The items picked in a project tree for "Make multitrack song". */
export interface Selection {
  ids: string[];
  toggle: (node: ImportNode, on: boolean) => void;
}

/** One Samply item in the review tree (with its children): role, targets, names, selection. */
export function NodeRow({
  node,
  depth,
  project,
  onChange,
  selection,
}: {
  node: ImportNode;
  depth: number;
  project: ImportProject;
  onChange: Edit;
  selection: Selection;
}) {
  const { t, i18n } = useTranslation();
  const Icon = KIND_ICON[node.kind];
  const { size, comments, duration, allImported } = nodeStats(node);
  const targets = songTargets(project, node.id);
  const actions = actionsFor(node).filter((a) => a !== "trackOf" || targets.length > 0);
  const skipped = node.action === "skip";
  const selectable = canGroup(node) && !skipped;
  const checked = selection.ids.includes(node.id);
  return (
    <>
      <Box pl={depth * 20} data-testid="import-node" data-node-name={node.name}>
        <Group justify="space-between" wrap="wrap" gap="xs" py={4}>
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: "1 1 200px" }}>
            {selectable ? (
              <Checkbox
                aria-label={t("admin.import.review.select", { name: node.name })}
                checked={checked}
                onChange={(e) => {
                  selection.toggle(node, e.currentTarget.checked);
                }}
                data-testid="import-node-select"
                styles={{ input: { cursor: "pointer" } }}
              />
            ) : (
              <Box w={20} style={{ flexShrink: 0 }} />
            )}
            <Icon size={18} style={{ flexShrink: 0, opacity: skipped ? 0.4 : 1 }} />
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" fw={500} truncate c={skipped ? "dimmed" : undefined}>
                {node.name}
              </Text>
              {node.kind !== "folder" && (
                <Text size="xs" c="dimmed" className="tabular-nums">
                  {[
                    duration !== null ? formatDuration(duration) : null,
                    t("admin.import.review.versions", { count: node.versions.length }),
                    size > 0 ? formatBytes(size, i18n.language) : null,
                    comments > 0 ? t("admin.import.review.comments", { count: comments }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              )}
            </Stack>
            {allImported && (
              <Badge size="xs" variant="light" color="teal">
                {t("admin.import.review.allImported")}
              </Badge>
            )}
            {node.isArtwork && (
              <Tooltip label={t("admin.import.review.artworkHint")} withinPortal multiline w={260}>
                <Badge size="xs" variant="light" color="violet" data-testid="import-node-artwork">
                  {t("admin.import.review.artwork")}
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Group gap="xs" wrap="wrap">
            <Select
              aria-label={t("admin.import.review.action")}
              size="sm"
              w={220}
              allowDeselect={false}
              value={node.action}
              data={actions.map((a) => ({ value: a, label: t(`admin.import.action.${a}`) }))}
              onChange={(v) => {
                if (v) onChange((m) => setNodeAction(m, project.samplyId, node.id, v));
              }}
              data-testid="import-node-action"
            />
            {node.action === "songMultitrack" && node.kind !== "folder" && (
              <>
                <TextInput
                  aria-label={t("admin.import.review.songTitle")}
                  placeholder={t("admin.import.review.songTitle")}
                  size="sm"
                  w={200}
                  value={node.songTitle ?? node.name}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    onChange((m) => setSongTitle(m, project.samplyId, node.id, v));
                  }}
                  data-testid="import-node-song-title"
                />
                <TextInput
                  aria-label={t("admin.import.review.trackName")}
                  size="sm"
                  w={160}
                  value={node.trackName}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    onChange((m) => setTrackName(m, project.samplyId, node.id, v));
                  }}
                />
              </>
            )}
            {node.action === "trackOf" && (
              <>
                <Select
                  aria-label={t("admin.import.review.trackOf")}
                  size="sm"
                  w={200}
                  allowDeselect={false}
                  value={node.targetId}
                  data={targets.map((s) => ({ value: s.id, label: songLabel(s) }))}
                  onChange={(v) => {
                    if (v)
                      onChange((m) => setNodeAction(m, project.samplyId, node.id, "trackOf", v));
                  }}
                />
                <TextInput
                  aria-label={t("admin.import.review.trackName")}
                  size="sm"
                  w={160}
                  value={node.trackName}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    onChange((m) => setTrackName(m, project.samplyId, node.id, v));
                  }}
                />
              </>
            )}
            {node.action === "document" && targets.length > 0 && (
              <Select
                aria-label={t("admin.import.review.attachTo")}
                size="sm"
                w={200}
                allowDeselect={false}
                value={node.targetId ?? PROJECT_TARGET}
                data={[
                  { value: PROJECT_TARGET, label: t("admin.import.review.attachProject") },
                  ...targets.map((s) => ({ value: s.id, label: songLabel(s) })),
                ]}
                onChange={(v) => {
                  onChange((m) =>
                    setDocumentTarget(
                      m,
                      project.samplyId,
                      node.id,
                      v && v !== PROJECT_TARGET ? v : null,
                    ),
                  );
                }}
                data-testid="import-node-attach"
              />
            )}
          </Group>
        </Group>
      </Box>
      {!skipped &&
        node.children.map((c) => (
          <NodeRow
            key={c.id}
            node={c}
            depth={depth + 1}
            project={project}
            onChange={onChange}
            selection={selection}
          />
        ))}
    </>
  );
}

const PROJECT_TARGET = "__project__";
