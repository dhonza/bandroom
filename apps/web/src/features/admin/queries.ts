import { adminListInvites, adminListUsers } from "@bandroom/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

export const ADMIN_USERS_KEY = ["admin", "users"] as const;
export const ADMIN_INVITES_KEY = ["admin", "invites"] as const;

export function useAdminUsers() {
  return useQuery({
    queryKey: ADMIN_USERS_KEY,
    queryFn: ({ signal }) => api(adminListUsers, undefined, { signal }),
  });
}

export function useAdminInvites() {
  return useQuery({
    queryKey: ADMIN_INVITES_KEY,
    queryFn: ({ signal }) => api(adminListInvites, undefined, { signal }),
  });
}

export function useInvalidateAdmin() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["admin"] });
  };
}
