import {
  cancelImport,
  deleteMySamplyKey,
  getImportRun,
  getMySamplyKey,
  listImportProjects,
  listImportRuns,
  samplyConnect,
  saveMySamplyKey,
  scanImport,
  startImport,
  updateImportMapping,
  type ImportMapping,
  type ImportRun,
} from "@bandroom/shared";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../../api/client";
import { errorMessage } from "../../../api/errorMessage";

export const importKeys = {
  all: ["admin", "imports"] as const,
  run: (id: string) => ["admin", "imports", id] as const,
  projects: (id: string) => ["admin", "imports", id, "projects"] as const,
  savedKey: ["me", "secrets", "samply"] as const,
};

const active = (run: ImportRun | undefined) =>
  run?.status === "scanning" || run?.status === "running";

export function useImportRuns() {
  return useQuery({
    queryKey: importKeys.all,
    queryFn: ({ signal }) => api(listImportRuns, undefined, { signal }),
  });
}

/** Polls while a scan or import runs (SSE `import.progress` also invalidates it). */
export function useImportRun(id: string) {
  return useQuery({
    queryKey: importKeys.run(id),
    queryFn: ({ signal }) => api(getImportRun, { params: { id } }, { signal }),
    refetchInterval: (q) => (active(q.state.data?.run) ? 3000 : false),
  });
}

export function useImportProjects(id: string, enabled: boolean) {
  return useQuery({
    queryKey: importKeys.projects(id),
    queryFn: ({ signal }) => api(listImportProjects, { params: { id } }, { signal }),
    enabled,
    staleTime: 60_000,
  });
}

/** How the admin connects: a typed key (optionally remembered) or their saved key. */
export type SamplyConnectInput = { apiKey: string; remember: boolean } | { useSavedKey: true };

/**
 * Connects a Samply account and opens the new run. A typed key is remembered only after Samply
 * accepted it (SPEC §25.11); failing to remember it does not fail the connection.
 */
export function useSamplyConnect(onConnected: (runId: string) => void) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: async (input: SamplyConnectInput) => {
      const res = await api(samplyConnect, {
        body: "apiKey" in input ? { apiKey: input.apiKey } : { useSavedKey: true },
      });
      if ("apiKey" in input && input.remember) {
        try {
          qc.setQueryData(
            importKeys.savedKey,
            await api(saveMySamplyKey, { body: { apiKey: input.apiKey } }),
          );
        } catch (err) {
          notifications.show({ color: "red", message: errorMessage(t, err) });
        }
      }
      return res;
    },
    onSuccess: ({ run, projects }) => {
      qc.setQueryData(importKeys.run(run.id), { run });
      qc.setQueryData(importKeys.projects(run.id), { projects });
      void qc.invalidateQueries({ queryKey: importKeys.all, exact: true });
      onConnected(run.id);
    },
  });
}

/** The admin's saved Samply key: only whether it exists and its last four characters. */
export function useSavedSamplyKey() {
  return useQuery({
    queryKey: importKeys.savedKey,
    queryFn: ({ signal }) => api(getMySamplyKey, undefined, { signal }),
  });
}

export function useForgetSamplyKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api(deleteMySamplyKey),
    onSuccess: (data) => {
      qc.setQueryData(importKeys.savedKey, data);
    },
  });
}

/** Scans the selected Samply projects. */
export function useScanImport(runId: string, projectIds: string[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api(scanImport, { params: { id: runId }, body: { projectIds } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: importKeys.run(runId) }),
  });
}

/** Saves the reviewed mapping and starts the import (or a dry run: the mutation variable). */
export function useStartImport(runId: string, mapping: ImportMapping | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dryRun: boolean) => {
      if (!mapping) return;
      await api(updateImportMapping, { params: { id: runId }, body: { mapping } });
      await api(startImport, { params: { id: runId }, body: { dryRun } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: importKeys.all }),
  });
}

/** Cancels a run; failures are shown as a toast. */
export function useCancelImport(runId: string, onCancelled: () => void) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api(cancelImport, { params: { id: runId } }),
    onSuccess: () => {
      onCancelled();
      void qc.invalidateQueries({ queryKey: importKeys.all });
    },
    onError: (err) => notifications.show({ color: "red", message: errorMessage(t, err) }),
  });
}
