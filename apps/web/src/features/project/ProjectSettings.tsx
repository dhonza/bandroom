import {
  deleteProject,
  DOWNLOAD_POLICIES,
  listProjectGrants,
  listUsersDirectory,
  ProjectNameSchema,
  removeProjectGrant,
  setProjectGrant,
  transferProjectOwnership,
  updateProject,
  type Project,
} from "@bandroom/shared";
import { Button, FileButton, Group, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { zodValidator } from "../../api/validate";
import { ColorSwatchPicker } from "../../components/ColorSwatchPicker";
import { ConfirmDeleteModal } from "../../components/ConfirmDeleteModal";
import { ProjectImage } from "../../components/ProjectImage";
import { startUpload } from "../../upload/startUpload";
import { UploadRow, useUploadErrorText, useUploadErrorToast } from "../../upload/UploadRow";
import { useUploads } from "../../upload/uploadStore";
import { GrantsEditor } from "../../components/GrantsEditor";
import { Section } from "../../components/Section";
import { projectKeys, useInvalidateContent } from "../library/queries";
import { dropDeletedFromQueue } from "../../player/dropDeleted";
import {
  CropImageModal,
  cropSource,
  ImageUrlModal,
  type CropSource,
} from "./imageCrop/ProjectImageDialogs";

export function ProjectSettings({ project }: { project: Project }) {
  const caps = new Set(project.access.capabilities);
  return (
    <Stack gap="lg" maw={760}>
      {caps.has("settings.manage") && <ImageSection project={project} />}
      {caps.has("settings.manage") && <GeneralSection project={project} />}
      {caps.has("grants.manage") && <MembersSection project={project} />}
      {caps.has("settings.manage") && <OwnershipSection project={project} />}
      {caps.has("project.delete") && <DangerSection project={project} />}
    </Stack>
  );
}

function projectFormValues(project: Project) {
  return {
    name: project.name,
    description: project.description,
    color: project.color,
    downloadPolicy: project.downloadPolicy,
  };
}

function GeneralSection({ project }: { project: Project }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateContent();
  const form = useForm({
    initialValues: projectFormValues(project),
    validate: { name: zodValidator(ProjectNameSchema, t) },
  });
  // A change saved elsewhere (another tab, a band mate) becomes the new baseline; unsaved edits
  // here are kept.
  useEffect(() => {
    const values = projectFormValues(project);
    const dirty = form.isDirty();
    form.setInitialValues(values);
    if (!dirty) form.setValues(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sync when the project changes
  }, [project.updatedAt]);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof api<typeof updateProject>>[1]["body"]) =>
      api(updateProject, { params: { id: project.id }, body }),
    onSuccess: () => {
      invalidate();
      form.resetDirty();
      notifications.show({ color: "teal", message: t("settings.saved") });
    },
    onError: (err) => notifications.show({ color: "red", message: apiError(err) }),
  });
  // Archiving is its own change: it leaves unsaved edits in the form alone.
  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      api(updateProject, { params: { id: project.id }, body: { archived } }),
    onSuccess: () => {
      invalidate();
      notifications.show({ color: "teal", message: t("settings.saved") });
    },
    onError: (err) => notifications.show({ color: "red", message: apiError(err) }),
  });

  return (
    <Section title={t("projects.settings.general")} testId="project-general">
      <form
        onSubmit={form.onSubmit((v) => {
          save.mutate(v);
        })}
        noValidate
      >
        <Stack>
          <TextInput label={t("projects.fields.name")} {...form.getInputProps("name")} />
          <Textarea
            label={t("projects.fields.description")}
            autosize
            minRows={2}
            maxRows={8}
            {...form.getInputProps("description")}
          />
          <ColorSwatchPicker
            label={t("projects.fields.color")}
            value={form.values.color}
            onChange={(c) => {
              form.setFieldValue("color", c);
            }}
          />
          <Select
            label={t("projects.fields.downloadPolicy")}
            description={t("projects.fields.downloadPolicyHint")}
            allowDeselect={false}
            data={DOWNLOAD_POLICIES.map((p) => ({ value: p, label: t(`downloadPolicies.${p}`) }))}
            {...form.getInputProps("downloadPolicy")}
          />
          <Group justify="space-between">
            <Button
              variant="default"
              loading={archive.isPending}
              onClick={() => {
                archive.mutate(project.archivedAt === null);
              }}
              data-testid="toggle-archive"
            >
              {project.archivedAt === null ? t("projects.archive") : t("projects.unarchive")}
            </Button>
            <Button type="submit" disabled={!form.isDirty()} loading={save.isPending}>
              {t("common.save")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Section>
  );
}

function MembersSection({ project }: { project: Project }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const grants = useQuery({
    queryKey: projectKeys.grants(project.id),
    queryFn: ({ signal }) => api(listProjectGrants, { params: { id: project.id } }, { signal }),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: projectKeys.grants(project.id) });
  };
  return (
    <Section
      title={t("grants.title")}
      description={t("grants.projectExplain")}
      testId="project-members"
    >
      <GrantsEditor
        rows={grants.data?.grants}
        loading={grants.isPending}
        error={grants.error}
        inheritLabelKey="grants.inheritDefault"
        onSet={(userId, role) =>
          api(setProjectGrant, { params: { id: project.id, userId }, body: { role } }).then(refresh)
        }
        onRemove={(userId) =>
          api(removeProjectGrant, { params: { id: project.id, userId } }).then(refresh)
        }
      />
    </Section>
  );
}

function OwnershipSection({ project }: { project: Project }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateContent();
  const [target, setTarget] = useState<string | null>(null);
  const directory = useQuery({
    queryKey: ["users", "directory"],
    queryFn: ({ signal }) => api(listUsersDirectory, undefined, { signal }),
    retry: false,
  });
  const transfer = useMutation({
    mutationFn: (userId: string) =>
      api(transferProjectOwnership, { params: { id: project.id }, body: { userId } }),
    onSuccess: () => {
      invalidate();
      setTarget(null);
      notifications.show({ color: "teal", message: t("projects.settings.transferred") });
    },
    onError: (err) => notifications.show({ color: "red", message: apiError(err) }),
  });
  if (directory.isError) return null; // e.g. a guest manager cannot list users
  return (
    <Section
      title={t("projects.settings.ownership")}
      description={t("projects.settings.ownershipExplain", {
        name: project.ownerDisplayName ?? "?",
      })}
    >
      <Group align="flex-end" wrap="wrap">
        <Select
          label={t("projects.settings.newOwner")}
          searchable
          value={target}
          onChange={setTarget}
          data={(directory.data?.users ?? [])
            .filter((u) => u.id !== project.ownerId)
            .map((u) => ({ value: u.id, label: `${u.displayName} (@${u.username})` }))}
          style={{ flex: "1 1 240px" }}
        />
        <Button
          variant="default"
          disabled={target === null}
          loading={transfer.isPending}
          onClick={() => {
            if (target) transfer.mutate(target);
          }}
        >
          {t("projects.settings.transfer")}
        </Button>
      </Group>
    </Section>
  );
}

function DangerSection({ project }: { project: Project }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const navigate = useNavigate();
  const invalidate = useInvalidateContent();
  const [opened, modal] = useDisclosure(false);
  const del = useMutation({
    mutationFn: () => api(deleteProject, { params: { id: project.id } }),
    onSuccess: () => {
      invalidate();
      dropDeletedFromQueue(t, { projectId: project.id });
      void navigate("/library", { replace: true });
    },
  });
  return (
    <Section title={t("projects.settings.danger")}>
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed" style={{ flex: "1 1 240px" }}>
          {t("projects.settings.deleteExplain")}
        </Text>
        <Button color="red" variant="light" onClick={modal.open} data-testid="delete-project">
          {t("projects.settings.delete")}
        </Button>
      </Group>
      <ConfirmDeleteModal
        opened={opened}
        onClose={modal.close}
        title={t("projects.settings.delete")}
        explanation={t("projects.settings.deleteExplain")}
        name={project.name}
        loading={del.isPending}
        error={del.isError ? apiError(del.error) : null}
        onConfirm={() => {
          del.mutate();
        }}
      />
    </Section>
  );
}

function ImageSection({ project }: { project: Project }) {
  const { t } = useTranslation();
  const invalidate = useInvalidateContent();
  const errorText = useUploadErrorText();
  const uploadErrorToast = useUploadErrorToast();
  // Select the stable array, filter outside the selector (a new array per call would loop).
  const allUploads = useUploads((s) => s.items);
  const uploads = useMemo(
    () => allUploads.filter((i) => i.target.type === "projectImage" && i.projectId === project.id),
    [allUploads, project.id],
  );
  const [busy, setBusy] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  // A picked or fetched image waits in the crop dialog (SPEC §25.4) before it is uploaded.
  const [toCrop, setToCrop] = useState<CropSource | null>(null);
  const upload = (file: File) => {
    setBusy(true);
    startUpload(
      file,
      { type: "projectImage", projectId: project.id },
      { songId: null, projectId: project.id },
    )
      .then(() => {
        notifications.show({ color: "teal", message: t("projects.settings.imageUploaded") });
        invalidate();
      })
      .catch((err: unknown) => {
        uploadErrorToast(err);
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Section
      title={t("projects.settings.image")}
      description={t("projects.settings.imageHint")}
      testId="project-image"
    >
      <Group gap="md">
        <ProjectImage
          name={project.name}
          color={project.color}
          imageHash={project.imageHash}
          size={96}
        />
        <Group gap="xs">
          <FileButton
            onChange={(file) => {
              if (file) setToCrop(cropSource(file, file.name));
            }}
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          >
            {(props) => (
              <Button
                {...props}
                variant="default"
                loading={busy}
                data-testid="upload-project-image"
              >
                {project.imageHash
                  ? t("projects.settings.changeImage")
                  : t("projects.settings.uploadImage")}
              </Button>
            )}
          </FileButton>
          <Button
            variant="default"
            disabled={busy}
            onClick={() => {
              setUrlOpen(true);
            }}
            data-testid="project-image-url"
          >
            {t("projects.settings.fromUrl")}
          </Button>
        </Group>
      </Group>
      <ImageUrlModal
        projectId={project.id}
        opened={urlOpen}
        onClose={() => {
          setUrlOpen(false);
        }}
        onFetched={(source) => {
          setUrlOpen(false);
          setToCrop(source);
        }}
      />
      <CropImageModal
        source={toCrop}
        onClose={() => {
          setToCrop(null);
        }}
        onConfirm={(file) => {
          setToCrop(null);
          upload(file);
        }}
      />
      {uploads.map((u) => (
        <UploadRow key={u.id} item={u} errorText={errorText} />
      ))}
    </Section>
  );
}
