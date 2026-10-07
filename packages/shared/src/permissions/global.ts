import { z } from "zod";

export const GLOBAL_ROLES = ["admin", "member", "guest"] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];
export const GlobalRoleSchema = z.enum(GLOBAL_ROLES);

/**
 * Instance-wide capabilities that do not depend on a project or song (SPEC §3.2, layer 1).
 * Content capabilities (project/song scope) arrive with the three-layer resolution in M2.
 */
export const GLOBAL_CAPABILITIES = ["admin.access", "project.create", "users.directory"] as const;
export type GlobalCapability = (typeof GLOBAL_CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<GlobalRole, readonly GlobalCapability[]> = {
  admin: GLOBAL_CAPABILITIES,
  /** users.directory: list band members, e.g. to grant roles; guests cannot enumerate users. */
  member: ["project.create", "users.directory"],
  guest: [],
};

export interface Principal {
  globalRole: GlobalRole;
  disabledAt: number | null;
}

export function hasGlobalCapability(user: Principal | null, capability: GlobalCapability): boolean {
  if (user === null || user.disabledAt !== null) return false;
  return ROLE_CAPABILITIES[user.globalRole].includes(capability);
}
