import {
  adminListLinks,
  createProjectLink,
  createSongLink,
  getLinkAnalytics,
  listProjectLinks,
  listSongLinks,
  revokeLink,
  updateLink,
  type CreateLink,
  type PublicLink,
  type UpdateLink,
} from "@bandroom/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

export const linkKeys = {
  all: ["links"] as const,
  project: (id: string) => ["links", "project", id] as const,
  song: (id: string) => ["links", "song", id] as const,
  admin: ["links", "admin"] as const,
  analytics: (id: string) => ["links", "analytics", id] as const,
};

/** Where links are listed and created: a project, a song, or the admin overview. */
export type LinkOwner =
  { kind: "project"; projectId: string } | { kind: "song"; songId: string } | { kind: "admin" };

export function useLinks(owner: LinkOwner) {
  return useQuery({
    queryKey:
      owner.kind === "project"
        ? linkKeys.project(owner.projectId)
        : owner.kind === "song"
          ? linkKeys.song(owner.songId)
          : linkKeys.admin,
    queryFn: ({ signal }) =>
      owner.kind === "project"
        ? api(listProjectLinks, { params: { id: owner.projectId } }, { signal })
        : owner.kind === "song"
          ? api(listSongLinks, { params: { id: owner.songId } }, { signal })
          : api(adminListLinks, {}, { signal }),
  });
}

export function useLinkAnalytics(id: string) {
  return useQuery({
    queryKey: linkKeys.analytics(id),
    queryFn: ({ signal }) => api(getLinkAnalytics, { params: { id } }, { signal }),
  });
}

/** Create, update and revoke; every change refreshes all link lists. */
export function useLinkMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: linkKeys.all });
  };
  const create = useMutation({
    mutationFn: ({ owner, body }: { owner: LinkOwner; body: CreateLink }) =>
      owner.kind === "project"
        ? api(createProjectLink, { params: { id: owner.projectId }, body })
        : owner.kind === "song"
          ? api(createSongLink, { params: { id: owner.songId }, body })
          : Promise.reject(new Error("admins create links on a project or song")),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateLink }) =>
      api(updateLink, { params: { id }, body }),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (link: PublicLink) => api(revokeLink, { params: { id: link.id } }),
    onSuccess: refresh,
  });
  return { create, update, revoke };
}
