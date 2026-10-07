import type { Song } from "@bandroom/shared";
import { useTranslation } from "react-i18next";
import { Section } from "../components/Section";
import { DocumentList, DocumentToolbar } from "./DocumentList";
import { useSongDocuments } from "./queries";
import { openDocsPanel } from "./store";

/**
 * The song's documents on the song page (SPEC §10: lyrics, chords, sheet music). Opening one
 * shows it next to the player (split view).
 */
export function SongDocumentsSection({ song }: { song: Song }) {
  const { t } = useTranslation();
  const docs = useSongDocuments(song.id);
  const canUpload = song.access.capabilities.includes("upload");
  const list = docs.data?.documents ?? [];
  if (!canUpload && list.length === 0) return null;
  const scope = { projectId: song.project.id, songId: song.id };
  return (
    <Section title={t("documents.panelTitle")} testId="song-documents">
      {canUpload && <DocumentToolbar scope={scope} />}
      <DocumentList
        documents={list}
        loading={docs.isPending}
        scope={scope}
        canUpload={canUpload}
        onOpen={(d) => {
          openDocsPanel(d.id);
        }}
        emptyText={t("documents.emptySong")}
      />
    </Section>
  );
}
