import type { UploadTarget } from "@bandroom/shared";
import { create } from "zustand";

export type UploadStatus = "uploading" | "done" | "error" | "cancelled";

export interface UploadItem {
  id: string;
  filename: string;
  size: number;
  target: UploadTarget;
  /** Scope for refreshing caches when done. */
  songId: string | null;
  projectId: string | null;
  progress: number;
  status: UploadStatus;
  errorCode: string | null;
  errorParams: Record<string, string | number> | null;
  abort?: () => void;
}

interface UploadState {
  items: UploadItem[];
  add: (item: UploadItem) => void;
  update: (id: string, patch: Partial<UploadItem>) => void;
  remove: (id: string) => void;
}

/** Uploads in progress survive navigation (SPEC §5.1: interrupted uploads resume). */
export const useUploads = create<UploadState>((set) => ({
  items: [],
  add: (item) => {
    set((s) => ({ items: [...s.items, item] }));
  },
  update: (id, patch) => {
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  },
  remove: (id) => {
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },
}));
