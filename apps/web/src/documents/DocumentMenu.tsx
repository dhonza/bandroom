import type { Document, DocumentVersion } from "@bandroom/shared";
import { ActionIcon, FileButton, Menu } from "@mantine/core";
import {
  IconDots,
  IconDownload,
  IconExternalLink,
  IconHistory,
  IconPencil,
  IconTrash,
  IconUpload,
  IconWriting,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { DocumentEditor } from "./DocumentEditor";
import { documentPermissions } from "./model";
import { documentDownloadUrl, useDeleteDocument, useDocumentUpload } from "./queries";
import { RenameModal } from "./RenameModal";
import { VersionsModal } from "./VersionsModal";

type Dialog = "versions" | "edit" | "rename" | null;

/**
 * The "⋯" menu of a document (list rows and the viewer header): open on its own page, versions,
 * edit text, upload a new version, rename, download, delete (with undo).
 */
export function DocumentMenu({
  doc,
  canUpload,
  onViewVersion,
  showOpenPage = true,
  onDeleted,
}: {
  doc: Document;
  canUpload: boolean;
  onViewVersion?: (version: DocumentVersion) => void;
  showOpenPage?: boolean;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<Dialog>(null);
  const perms = documentPermissions(doc, canUpload);
  const remove = useDeleteDocument();
  const upload = useDocumentUpload();
  const close = () => {
    setDialog(null);
  };
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            aria-label={t("documents.actions", { title: doc.title })}
            data-testid="doc-menu"
          >
            <IconDots size={18} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {showOpenPage && (
            <Menu.Item
              component={Link}
              to={`/documents/${doc.id}`}
              leftSection={<IconExternalLink size={16} />}
              data-testid="doc-open-page"
            >
              {t("documents.openPage")}
            </Menu.Item>
          )}
          <Menu.Item
            leftSection={<IconHistory size={16} />}
            onClick={() => {
              setDialog("versions");
            }}
            data-testid="doc-versions"
          >
            {t("documents.versions", { count: doc.versionCount })}
          </Menu.Item>
          {perms.canEditText && (
            <Menu.Item
              leftSection={<IconWriting size={16} />}
              onClick={() => {
                setDialog("edit");
              }}
              data-testid="doc-edit"
            >
              {t("documents.editText")}
            </Menu.Item>
          )}
          {perms.canUpload && (
            <FileButton
              onChange={(file) => {
                if (file)
                  upload([file], () => ({ type: "documentVersion", documentId: doc.id }), {
                    projectId: doc.projectId,
                  });
              }}
            >
              {(props) => (
                <Menu.Item
                  {...props}
                  closeMenuOnClick={false}
                  leftSection={<IconUpload size={16} />}
                  data-testid="doc-upload-version"
                >
                  {t("documents.uploadVersion")}
                </Menu.Item>
              )}
            </FileButton>
          )}
          {perms.canRename && (
            <Menu.Item
              leftSection={<IconPencil size={16} />}
              onClick={() => {
                setDialog("rename");
              }}
              data-testid="doc-rename"
            >
              {t("documents.rename")}
            </Menu.Item>
          )}
          {perms.canDownload && doc.current && (
            <Menu.Item
              component="a"
              href={documentDownloadUrl(doc.current.id)}
              download
              leftSection={<IconDownload size={16} />}
              data-testid="doc-download-menu"
            >
              {t("documents.download")}
            </Menu.Item>
          )}
          {perms.canDelete && (
            <Menu.Item
              color="red"
              leftSection={<IconTrash size={16} />}
              onClick={() => {
                void remove(doc).then((ok) => {
                  if (ok) onDeleted?.();
                });
              }}
              data-testid="doc-delete"
            >
              {t("common.delete")}
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
      {dialog === "versions" && (
        <VersionsModal doc={doc} onClose={close} onViewVersion={onViewVersion} />
      )}
      {dialog === "edit" && doc.current && (
        <DocumentEditor doc={doc} version={doc.current} onClose={close} />
      )}
      {dialog === "rename" && <RenameModal doc={doc} onClose={close} />}
    </>
  );
}
