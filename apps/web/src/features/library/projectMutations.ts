import { starProject, unstarProject, updateProject, type LibraryProject } from "@bandroom/shared";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { useInvalidateContent } from "./queries";

type LibraryData = { projects: LibraryProject[] };
const LIST_PREFIX = ["projects", "list"] as const;

/** Stars or unstars a project (SPEC §11): the Library lists update at once, undone on errors. */
export function useStarProject() {
  const qc = useQueryClient();
  const apiError = useApiError();
  return useMutation({
    mutationFn: ({ id, starred }: { id: string; starred: boolean }) =>
      api(starred ? starProject : unstarProject, { params: { id } }),
    onMutate: async ({ id, starred }) => {
      await qc.cancelQueries({ queryKey: LIST_PREFIX });
      const before = qc.getQueriesData<LibraryData>({ queryKey: LIST_PREFIX });
      qc.setQueriesData<LibraryData>({ queryKey: LIST_PREFIX }, (data) =>
        data ? { projects: data.projects.map((p) => (p.id === id ? { ...p, starred } : p)) } : data,
      );
      return { before };
    },
    onError: (err, _vars, context) => {
      for (const [key, data] of context?.before ?? []) qc.setQueryData(key, data);
      notifications.show({ color: "red", message: apiError(err) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: LIST_PREFIX }),
  });
}

/** Archives or unarchives a project (SPEC §11.2; needs settings.manage). */
export function useArchiveProject(projectId: string) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateContent();
  return useMutation({
    mutationFn: (archived: boolean) =>
      api(updateProject, { params: { id: projectId }, body: { archived } }),
    onSuccess: () => {
      invalidate();
      notifications.show({ color: "teal", message: t("settings.saved") });
    },
    onError: (err) => notifications.show({ color: "red", message: apiError(err) }),
  });
}
