import { getProjectExportPreview, type DownloadFormat, type Project } from "@bandroom/shared";
import { Alert, Button, Group, Loader, Modal, Select, Stack, Text } from "@mantine/core";
import { IconDownload, IconFileZip } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { useFormatters } from "../../i18n/format";
import { exportUrl } from "../../lib/media";

const FORMATS = ["flac", "wav", "opus", "original"] as const satisfies readonly DownloadFormat[];

/** "Export" on the project page (SPEC §28.7): needs `download` on the project. */
export function ExportProjectButton({ project }: { project: Project }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="default"
        h={44}
        leftSection={<IconFileZip size={16} />}
        onClick={() => {
          setOpen(true);
        }}
        data-testid="project-export"
      >
        {t("projects.export.button")}
      </Button>
      {open && (
        <ExportProjectDialog
          project={project}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

/** Format, what the archive holds, and the download link. */
export function ExportProjectDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const apiError = useApiError();
  const [format, setFormat] = useState<DownloadFormat>("flac");
  const preview = useQuery({
    queryKey: ["projects", project.id, "export", format],
    queryFn: ({ signal }) =>
      api(getProjectExportPreview, { params: { id: project.id }, query: { format } }, { signal }),
    staleTime: 0,
  });
  const p = preview.data;
  return (
    <Modal opened onClose={onClose} title={t("projects.export.title")} centered>
      <Stack gap="md" data-testid="export-dialog">
        <Select
          label={t("projects.export.format")}
          value={format}
          allowDeselect={false}
          data={FORMATS.map((f) => ({ value: f, label: t(`projects.export.formats.${f}`) }))}
          onChange={(v) => {
            if (v) setFormat(v);
          }}
          data-testid="export-format"
        />
        {preview.isPending ? (
          <Loader size="sm" />
        ) : preview.isError ? (
          <Alert color="red">{apiError(preview.error)}</Alert>
        ) : p ? (
          <Stack gap="xs">
            <Text data-testid="export-summary">
              {t("projects.export.summary", {
                files: t("projects.export.files", { count: p.files }),
                songs: t("counts.songs", { count: p.songs }),
                size: fmt.bytes(p.bytes),
              })}
            </Text>
            {p.skippedSongs > 0 && (
              <Text size="sm" c="dimmed" data-testid="export-skipped">
                {t("projects.export.skippedSongs", { count: p.skippedSongs })}
              </Text>
            )}
            {p.opusFallbacks > 0 && (
              <Text size="sm" c="dimmed" data-testid="export-opus-fallback">
                {t("projects.export.opusFallback", { count: p.opusFallbacks })}
              </Text>
            )}
            {p.originalFallbacks > 0 && (
              <Text size="sm" c="dimmed" data-testid="export-original-fallback">
                {t("projects.export.originalFallback", { count: p.originalFallbacks })}
              </Text>
            )}
            {format === "wav" && (
              <Text size="sm" c="dimmed">
                {t("projects.export.busy")}
              </Text>
            )}
          </Stack>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" h={44} onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button
            component="a"
            h={44}
            href={exportUrl(project.id, format)}
            download
            leftSection={<IconDownload size={16} />}
            disabled={!p || p.files === 0}
            data-testid="export-download"
          >
            {t("projects.export.download")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
