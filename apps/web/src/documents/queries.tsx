import {
  deleteDocument,
  deleteDocumentVersion,
  getDocument,
  listDocumentVersions,
  listProjectDocuments,
  restoreDocument,
  restoreDocumentVersion,
  saveDocumentText,
  setCurrentDocumentVersion,
  updateDocument,
  type Document,
  type UploadTarget,
} from "@bandroom/shared";
import { Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { apiUrl } from "../lib/media";
import { startUpload } from "../upload/startUpload";
import { useUploadErrorToast } from "../upload/UploadRow";

export const docKeys = {
  all: ["documents"] as const,
  project: (projectId: string) => ["documents", "project", projectId] as const,
  detail: (id: string) => ["documents", "detail", id] as const,
  versions: (id: string) => ["documents", "detail", id, "versions"] as const,
  text: (versionId: string) => ["documents", "text", versionId] as const,
};

export function useProjectDocuments(projectId: string) {
  return useQuery({
    queryKey: docKeys.project(projectId),
    queryFn: ({ signal }) => api(listProjectDocuments, { params: { id: projectId } }, { signal }),
  });
}

export function useDocument(id: string | null) {
  return useQuery({
    queryKey: docKeys.detail(id ?? ""),
    queryFn: ({ signal }) => api(getDocument, { params: { id: id ?? "" } }, { signal }),
    enabled: id !== null,
  });
}

export function useDocumentVersions(id: string, enabled = true) {
  return useQuery({
    queryKey: docKeys.versions(id),
    queryFn: ({ signal }) => api(listDocumentVersions, { params: { id } }, { signal }),
    enabled,
  });
}

export function contentUrl(versionId: string): string {
  return apiUrl(`/document-versions/${versionId}/content`);
}

export function documentDownloadUrl(versionId: string): string {
  return apiUrl(`/document-versions/${versionId}/download`);
}

/** The UTF-8 text of a Markdown/text version (immutable per version id). */
export function useDocumentText(versionId: string | null) {
  return useQuery({
    queryKey: docKeys.text(versionId ?? ""),
    enabled: versionId !== null,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const res = await fetch(contentUrl(versionId ?? ""), {
        credentials: "same-origin",
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      // A leading BOM would show up as a stray character in Markdown headings.
      return (await res.text()).replace(/^\uFEFF/, "");
    },
  });
}

export function useInvalidateDocuments() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: docKeys.all });
}

/** Renames a document; `onDone` runs after a successful save. */
export function useRenameDocument(id: string, onDone: () => void) {
  const invalidate = useInvalidateDocuments();
  return useMutation({
    mutationFn: (title: string) => api(updateDocument, { params: { id }, body: { title } }),
    onSuccess: () => {
      void invalidate();
      onDone();
    },
  });
}

/** Makes another version of a document the current one. */
export function useSetCurrentDocumentVersion(id: string) {
  const invalidate = useInvalidateDocuments();
  return useMutation({
    mutationFn: (versionId: string) =>
      api(setCurrentDocumentVersion, { params: { id }, body: { versionId } }),
    onSuccess: () => invalidate(),
  });
}

/** Saves edited text as a new version on top of `baseVersionId`; `onDone` runs after success. */
export function useSaveDocumentText(id: string, baseVersionId: string, onDone: () => void) {
  const invalidate = useInvalidateDocuments();
  return useMutation({
    mutationFn: (text: string) =>
      api(saveDocumentText, { params: { id }, body: { text, baseVersionId } }),
    onSuccess: () => {
      void invalidate();
      onDone();
    },
  });
}

/** Uploads files as new documents or a new version (tus, SPEC §5.1, §10) with error toasts. */
export function useDocumentUpload() {
  const uploadErrorToast = useUploadErrorToast();
  const invalidate = useInvalidateDocuments();
  return (
    files: readonly File[],
    target: (file: File) => UploadTarget,
    scope: { projectId: string },
  ) => {
    for (const file of files) {
      startUpload(file, target(file), { projectId: scope.projectId, songId: null })
        .then(() => invalidate())
        .catch((err: unknown) => {
          uploadErrorToast(err, file.name);
        });
    }
  };
}

const UNDO_MS = 8000;

/** Shows "… deleted" with an Undo button for 8 s (SPEC §11.1: undo over confirm). */
function showUndoToast(
  id: string,
  message: string,
  label: string,
  undo: () => Promise<void>,
  onError: (err: unknown) => void,
) {
  notifications.show({
    id,
    autoClose: UNDO_MS,
    message: (
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm">{message}</Text>
        <Button
          size="sm"
          variant="light"
          h={44}
          onClick={() => {
            notifications.hide(id);
            undo().catch(onError);
          }}
          data-testid="document-undo"
        >
          {label}
        </Button>
      </Group>
    ),
  });
}

/** Soft delete of a document with undo. */
export function useDeleteDocument() {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateDocuments();
  const fail = (err: unknown) => notifications.show({ color: "red", message: apiError(err) });
  return async (doc: Document): Promise<boolean> => {
    try {
      await api(deleteDocument, { params: { id: doc.id } });
    } catch (err) {
      fail(err);
      return false;
    }
    void invalidate();
    showUndoToast(
      `doc-undo-${doc.id}`,
      t("documents.deleted", { title: doc.title }),
      t("markers.undo"),
      async () => {
        await api(restoreDocument, { params: { id: doc.id } });
        await invalidate();
      },
      fail,
    );
    return true;
  };
}

/** Soft delete of one version with undo. */
export function useDeleteDocumentVersion() {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateDocuments();
  const fail = (err: unknown) => notifications.show({ color: "red", message: apiError(err) });
  return async (versionId: string, number: number): Promise<void> => {
    try {
      await api(deleteDocumentVersion, { params: { id: versionId } });
    } catch (err) {
      fail(err);
      return;
    }
    void invalidate();
    showUndoToast(
      `docv-undo-${versionId}`,
      t("documents.versionDeleted", { number }),
      t("markers.undo"),
      async () => {
        await api(restoreDocumentVersion, { params: { id: versionId } });
        await invalidate();
      },
      fail,
    );
  };
}
