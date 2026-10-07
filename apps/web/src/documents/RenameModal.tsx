import { DocumentTitleSchema, type Document } from "@bandroom/shared";
import { Alert, Button, Group, Modal, Stack, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../api/useApiError";
import { useRenameDocument } from "./queries";

export function RenameModal({ doc, onClose }: { doc: Document; onClose: () => void }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const [title, setTitle] = useState(doc.title);
  const valid = DocumentTitleSchema.safeParse(title).success;
  const save = useRenameDocument(doc.id, onClose);
  return (
    <Modal opened onClose={onClose} title={t("documents.rename")} centered>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate(title);
        }}
      >
        <Stack>
          {save.isError && <Alert color="red">{apiError(save.error)}</Alert>}
          <TextInput
            label={t("documents.title")}
            value={title}
            onChange={(e) => {
              setTitle(e.currentTarget.value);
            }}
            data-autofocus
            data-testid="doc-title-input"
            error={valid ? null : t("validation.required")}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!valid}>
              {t("common.save")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
