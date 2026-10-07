import type { Document, DocumentVersion } from "@bandroom/shared";
import {
  Alert,
  Box,
  Button,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../api/errorMessage";
import { useApiError } from "../api/useApiError";
import { EDITOR_SPLIT_QUERY } from "../shell/mediaQueries";
import { MarkdownBody, PlainTextBody } from "./MarkdownBody";
import { editorDirty } from "./model";
import { useDocumentText, useSaveDocumentText } from "./queries";

/**
 * In-app Markdown/text editing (SPEC §10 SHOULD): a split editor/preview (tabs on phones);
 * saving creates a new version. A newer version saved meanwhile is reported, not overwritten.
 */
export function DocumentEditor({
  doc,
  version,
  onClose,
}: {
  doc: Document;
  version: DocumentVersion;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const wide = useMediaQuery(EDITOR_SPLIT_QUERY, false, { getInitialValueInEffect: false });
  const original = useDocumentText(version.id);
  const [draft, setDraft] = useState<string | null>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const text = draft ?? original.data ?? "";
  const markdown = version.kind === "markdown";
  const dirty = editorDirty(original.isSuccess, draft, original.data);
  /** Escape, the close button and Cancel ask before throwing away unsaved edits. */
  const requestClose = () => {
    if (!dirty) onClose();
    else setConfirmDiscard((open) => !open);
  };
  const save = useSaveDocumentText(doc.id, version.id, onClose);
  const editor = (
    <Textarea
      value={text}
      onChange={(e) => {
        setDraft(e.currentTarget.value);
      }}
      autosize
      minRows={14}
      maxRows={30}
      aria-label={t("documents.editText")}
      data-testid="doc-editor"
      styles={{
        input: { fontFamily: markdown ? undefined : "var(--mantine-font-family-monospace)" },
      }}
    />
  );
  const preview = (
    <Box
      data-testid="doc-editor-preview"
      style={{ overflow: "auto", maxHeight: "70vh", minWidth: 0 }}
    >
      {markdown ? <MarkdownBody text={text} /> : <PlainTextBody text={text} />}
    </Box>
  );
  return (
    <Modal
      opened
      onClose={requestClose}
      title={t("documents.editTitle", { title: doc.title })}
      size={wide ? "90%" : "100%"}
      fullScreen={!wide}
      closeOnClickOutside={false}
      data-testid="doc-editor-modal"
    >
      <Stack gap="sm">
        {save.isError && <Alert color="red">{apiError(save.error)}</Alert>}
        {original.isPending ? (
          <Loader size="sm" />
        ) : original.isError ? (
          <Alert color="red" data-testid="doc-editor-load-error">
            {errorMessage(t, original.error)} {t("documents.editLoadFailed")}
          </Alert>
        ) : wide ? (
          <SimpleGrid cols={2} spacing="md">
            {editor}
            {preview}
          </SimpleGrid>
        ) : (
          <>
            <SegmentedControl
              value={tab}
              onChange={(v) => {
                setTab(v === "preview" ? "preview" : "write");
              }}
              data={[
                { value: "write", label: t("documents.write") },
                { value: "preview", label: t("documents.preview") },
              ]}
            />
            {tab === "write" ? editor : preview}
          </>
        )}
        {confirmDiscard ? (
          <Alert
            color="yellow"
            title={t("documents.discardTitle")}
            data-testid="doc-editor-discard-confirm"
          >
            <Stack gap="sm">
              <Text size="sm">{t("documents.discardHint")}</Text>
              <Group justify="flex-end">
                <Button
                  variant="default"
                  h={44}
                  onClick={() => {
                    setConfirmDiscard(false);
                  }}
                >
                  {t("documents.keepEditing")}
                </Button>
                <Button color="red" h={44} onClick={onClose} data-testid="doc-editor-discard">
                  {t("documents.discard")}
                </Button>
              </Group>
            </Stack>
          </Alert>
        ) : (
          <Group justify="flex-end">
            <Button variant="default" h={44} onClick={requestClose}>
              {t("common.cancel")}
            </Button>
            <Button
              h={44}
              onClick={() => {
                save.mutate(text);
              }}
              loading={save.isPending}
              disabled={!dirty}
              data-testid="doc-editor-save"
            >
              {t("documents.saveVersion")}
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
