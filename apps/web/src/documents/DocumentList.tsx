import {
  createProjectTextDocument,
  createSongTextDocument,
  DocumentTitleSchema,
  type Document,
  type DocumentKind,
} from "@bandroom/shared";
import {
  Alert,
  Badge,
  Box,
  Button,
  FileButton,
  Group,
  Loader,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import {
  IconFile,
  IconFileMusic,
  IconFileText,
  IconFileTypePdf,
  IconMarkdown,
  IconPhoto,
  IconPlus,
  IconUpload,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { blobUrl } from "../lib/media";
import { UploadRow, isDocumentUpload, useUploadErrorText } from "../upload/UploadRow";
import { useUploads } from "../upload/uploadStore";
import { DocumentMenu } from "./DocumentActions";
import { useDocumentUpload, useInvalidateDocuments } from "./queries";

const KIND_ICONS: Record<DocumentKind, typeof IconFile> = {
  markdown: IconMarkdown,
  text: IconFileText,
  pdf: IconFileTypePdf,
  image: IconPhoto,
  midi: IconFileMusic,
  other: IconFile,
};

export interface DocumentScope {
  projectId: string;
  /** Null = project-level documents. */
  songId: string | null;
}

/** Upload rows of document uploads running in this scope. */
function useScopeUploads(scope: DocumentScope) {
  const all = useUploads((s) => s.items);
  return useMemo(
    () =>
      all.filter(
        (u) =>
          isDocumentUpload(u) &&
          u.status !== "done" &&
          u.projectId === scope.projectId &&
          u.songId === scope.songId,
      ),
    [all, scope.projectId, scope.songId],
  );
}

/**
 * Upload and "New document" buttons for a scope (SPEC §10). Files become new documents; the kind
 * is detected by the server.
 */
export function DocumentToolbar({ scope }: { scope: DocumentScope }) {
  const { t } = useTranslation();
  const upload = useDocumentUpload();
  const [creating, setCreating] = useState(false);
  return (
    <Group gap="xs" wrap="wrap">
      <FileButton
        multiple
        onChange={(files) => {
          upload(
            files,
            () => ({ type: "newDocument", projectId: scope.projectId, songId: scope.songId }),
            scope,
          );
        }}
      >
        {(props) => (
          <Button
            {...props}
            variant="light"
            h={44}
            leftSection={<IconUpload size={18} />}
            data-testid="doc-upload"
          >
            {t("documents.upload")}
          </Button>
        )}
      </FileButton>
      <Button
        variant="default"
        h={44}
        leftSection={<IconPlus size={18} />}
        onClick={() => {
          setCreating(true);
        }}
        data-testid="doc-new"
      >
        {t("documents.new")}
      </Button>
      {creating && (
        <NewDocumentModal
          scope={scope}
          onClose={() => {
            setCreating(false);
          }}
        />
      )}
    </Group>
  );
}

function NewDocumentModal({ scope, onClose }: { scope: DocumentScope; onClose: () => void }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateDocuments();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"markdown" | "text">("markdown");
  const [text, setText] = useState("");
  const valid = DocumentTitleSchema.safeParse(title).success;
  const create = useMutation({
    mutationFn: () => {
      const body = { title, kind, text };
      return scope.songId
        ? api(createSongTextDocument, { params: { id: scope.songId }, body })
        : api(createProjectTextDocument, { params: { id: scope.projectId }, body });
    },
    onSuccess: () => {
      void invalidate();
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title={t("documents.new")} centered size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate();
        }}
      >
        <Stack>
          {create.isError && <Alert color="red">{apiError(create.error)}</Alert>}
          <TextInput
            label={t("documents.title")}
            placeholder={t("documents.titlePlaceholder")}
            value={title}
            onChange={(e) => {
              setTitle(e.currentTarget.value);
            }}
            data-autofocus
            data-testid="doc-new-title"
          />
          <SegmentedControl
            value={kind}
            onChange={(v) => {
              setKind(v === "text" ? "text" : "markdown");
            }}
            data={[
              { value: "markdown", label: t("documents.kinds.markdown") },
              { value: "text", label: t("documents.kinds.text") },
            ]}
            aria-label={t("documents.kind")}
          />
          <Textarea
            label={t("documents.text")}
            description={
              kind === "markdown" ? t("documents.markdownHint") : t("documents.textHint")
            }
            value={text}
            onChange={(e) => {
              setText(e.currentTarget.value);
            }}
            autosize
            minRows={8}
            maxRows={20}
            data-testid="doc-new-text"
            styles={{
              input: {
                fontFamily: kind === "text" ? "var(--mantine-font-family-monospace)" : undefined,
              },
            }}
          />
          <Group justify="flex-end">
            <Button variant="default" h={44} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              h={44}
              loading={create.isPending}
              disabled={!valid}
              data-testid="doc-new-save"
            >
              {t("common.save")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** Document rows with thumbnails; dropping a file on a row uploads a new version (SPEC §10). */
export function DocumentList({
  documents,
  scope,
  canUpload,
  onOpen,
  loading,
  emptyText,
}: {
  documents: readonly Document[];
  scope: DocumentScope;
  canUpload: boolean;
  onOpen: (doc: Document) => void;
  loading?: boolean;
  emptyText?: string;
}) {
  const { t } = useTranslation();
  const uploads = useScopeUploads(scope);
  const errorText = useUploadErrorText();
  return (
    <Stack gap="xs" data-testid="doc-list">
      {uploads.map((u) => (
        <UploadRow key={u.id} item={u} errorText={errorText} />
      ))}
      {loading && <Loader size="sm" />}
      {!loading && documents.length === 0 && uploads.length === 0 && (
        <Text size="sm" c="dimmed" data-testid="doc-empty">
          {emptyText ?? t("documents.empty")}
        </Text>
      )}
      {documents.map((d) => (
        <DocumentRow key={d.id} doc={d} canUpload={canUpload} onOpen={onOpen} />
      ))}
    </Stack>
  );
}

function DocumentRow({
  doc,
  canUpload,
  onOpen,
}: {
  doc: Document;
  canUpload: boolean;
  onOpen: (doc: Document) => void;
}) {
  const { t } = useTranslation();
  const upload = useDocumentUpload();
  const [dragOver, setDragOver] = useState(false);
  const v = doc.current;
  const kind = v?.kind ?? doc.kind;
  const Icon = KIND_ICONS[kind];
  const status =
    v?.status === "failed"
      ? t("documents.failedShort")
      : v && v.status !== "ready"
        ? t("documents.processing")
        : null;
  const details = [
    t(`documents.kinds.${kind}`),
    v?.pages ? t("documents.pages", { count: v.pages }) : null,
    doc.versionCount > 1 ? `v${String(v?.number ?? doc.versionCount)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Paper
      withBorder
      radius="md"
      p={6}
      data-testid="doc-row"
      data-doc-id={doc.id}
      style={dragOver ? { outline: "2px dashed var(--mantine-primary-color-filled)" } : undefined}
      onDragOver={(e) => {
        if (!canUpload || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => {
        setDragOver(false);
      }}
      onDrop={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file)
          upload([file], () => ({ type: "documentVersion", documentId: doc.id }), {
            projectId: doc.projectId,
            songId: doc.songId,
          });
      }}
    >
      <Group gap="sm" wrap="nowrap">
        <UnstyledButton
          onClick={() => {
            onOpen(doc);
          }}
          style={{ flex: 1, minWidth: 0, minHeight: 44 }}
          data-testid="doc-open"
          aria-label={t("documents.open", { title: doc.title })}
        >
          <Group gap="sm" wrap="nowrap">
            {v?.thumbHash ? (
              <Box
                component="img"
                src={blobUrl(v.thumbHash)}
                alt=""
                w={44}
                h={44}
                style={{ objectFit: "cover", borderRadius: 6, flex: "none", background: "white" }}
              />
            ) : (
              <ThemeIcon size={44} variant="light" color="gray" radius="md">
                <Icon size={22} />
              </ThemeIcon>
            )}
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text fw={500} truncate data-testid="doc-title">
                {doc.title}
              </Text>
              <Group gap={6} wrap="nowrap">
                <Text size="xs" c="dimmed" truncate>
                  {details}
                </Text>
                {status && (
                  <Badge
                    size="xs"
                    variant="light"
                    color={v?.status === "failed" ? "red" : "gray"}
                    data-testid="doc-status"
                  >
                    {status}
                  </Badge>
                )}
              </Group>
            </Stack>
          </Group>
        </UnstyledButton>
        <DocumentMenu doc={doc} canUpload={canUpload} />
      </Group>
    </Paper>
  );
}
