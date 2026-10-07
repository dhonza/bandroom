import type { Project } from "@bandroom/shared";
import { Anchor, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { DocumentList, DocumentToolbar } from "./DocumentList";
import { useProjectDocuments } from "./queries";

/**
 * Project page "Documents" tab (SPEC §11.2): the project's own documents (setlist, contacts,
 * band rules) and, below, the documents of each song the user can see.
 */
export function ProjectDocumentsTab({ project }: { project: Project }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const docs = useProjectDocuments(project.id);
  const caps = project.access.capabilities;
  const full = project.visibility === "full";
  const canUpload = full && caps.includes("upload");
  const scope = { projectId: project.id, songId: null };
  const open = (d: { id: string }) => {
    void navigate(`/documents/${d.id}`);
  };
  const songs = docs.data?.songs ?? [];
  return (
    <Stack gap="lg" data-testid="project-documents">
      {full && (
        <Stack gap="sm">
          {canUpload && <DocumentToolbar scope={scope} />}
          <DocumentList
            documents={docs.data?.documents ?? []}
            loading={docs.isPending}
            scope={scope}
            canUpload={canUpload}
            onOpen={open}
            emptyText={t("documents.emptyProject")}
          />
        </Stack>
      )}
      {songs.map((s) => (
        <Stack key={s.songId} gap="xs" data-testid="project-song-documents">
          <Anchor component={Link} to={`/songs/${s.songId}`} fw={600}>
            {s.songTitle}
          </Anchor>
          <DocumentList
            documents={s.documents}
            scope={{ projectId: project.id, songId: s.songId }}
            canUpload={false}
            onOpen={open}
          />
        </Stack>
      ))}
      {!full && songs.length === 0 && !docs.isPending && (
        <Text size="sm" c="dimmed">
          {t("documents.empty")}
        </Text>
      )}
    </Stack>
  );
}
