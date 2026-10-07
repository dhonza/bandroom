import { nodeDuration, type ImportProject } from "@bandroom/shared";
import { Alert, Button, Checkbox, Group, Paper, Stack, Text, TextInput } from "@mantine/core";
import { IconPhotoOff } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "../../../lib/media";
import {
  findNode,
  groupAsMultitrack,
  groupLengthsDiffer,
  setProjectIncluded,
  suggestTitle,
} from "./mappingEdit";
import { NodeRow, type Edit, type Selection } from "./NodeRow";

/** One Samply project in the review: include it, group items into multitrack songs, its tree. */
export function ProjectTree({ project, onChange }: { project: ImportProject; onChange: Edit }) {
  const { t } = useTranslation();
  const [ids, setIds] = useState<string[]>([]);
  const [title, setTitle] = useState<string | null>(null);
  const picked = ids.map((id) => findNode(project.nodes, id)).filter((n) => n !== undefined);
  const anchor = picked[0];
  const selection: Selection = {
    ids,
    toggle: (node, on) => {
      setIds((cur) => (on ? [...cur, node.id] : cur.filter((x) => x !== node.id)));
      setTitle(null);
    },
  };
  const length = anchor ? nodeDuration(anchor) : null;
  return (
    <Paper withBorder p="md" data-testid="import-project-tree">
      <Stack gap="xs">
        <Checkbox
          label={
            <Text fw={600} component="span">
              {project.name}
            </Text>
          }
          description={project.existingProjectId ? t("admin.import.review.existing") : undefined}
          checked={project.include}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            onChange((m) => setProjectIncluded(m, project.samplyId, on));
          }}
        />
        {project.include && project.artworkUrl && !project.nodes.some((n) => n.isArtwork) && (
          <Alert
            color="yellow"
            variant="light"
            p="xs"
            icon={<IconPhotoOff size={16} />}
            data-testid="artwork-unavailable"
          >
            <Text size="sm">{t("admin.import.review.artworkUnavailable")}</Text>
          </Alert>
        )}
        {project.include && (
          <Text size="xs" c="dimmed">
            {t("admin.import.review.groupHint")}
          </Text>
        )}
        {project.include && picked.length > 0 && (
          <Paper withBorder p="sm" bg="var(--mantine-color-default-hover)" data-testid="group-bar">
            <Group gap="xs" wrap="wrap" align="flex-end">
              <Text size="sm" style={{ flex: "1 1 160px" }}>
                {t("admin.import.review.selected", { count: picked.length })}
                {length !== null ? ` · ${formatDuration(length)}` : ""}
              </Text>
              <TextInput
                label={t("admin.import.review.songTitle")}
                size="sm"
                w={220}
                value={title ?? suggestTitle(picked)}
                onChange={(e) => {
                  setTitle(e.currentTarget.value);
                }}
                data-testid="group-title"
              />
              <Button
                size="sm"
                disabled={picked.length < 2}
                onClick={() => {
                  const name = title ?? suggestTitle(picked);
                  onChange((m) => groupAsMultitrack(m, project.samplyId, ids, name));
                  setIds([]);
                  setTitle(null);
                }}
                data-testid="group-make"
              >
                {t("admin.import.review.makeMultitrack")}
              </Button>
              <Button
                size="sm"
                variant="default"
                onClick={() => {
                  setIds([]);
                  setTitle(null);
                }}
              >
                {t("admin.import.review.clearSelection")}
              </Button>
              {groupLengthsDiffer(picked) && (
                <Text size="xs" c="orange" w="100%" data-testid="group-length-warning">
                  {t("admin.import.review.differentLength")}
                </Text>
              )}
            </Group>
          </Paper>
        )}
        {project.include &&
          project.nodes.map((n) => (
            <NodeRow
              key={n.id}
              node={n}
              depth={0}
              project={project}
              onChange={onChange}
              selection={selection}
            />
          ))}
      </Stack>
    </Paper>
  );
}
