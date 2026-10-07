import { getSetting, instanceLogo, listDirectoryUsers, setSetting } from "@bandroom/server-core";
import {
  adminGetSettings,
  adminUpdateSettings,
  listUsersDirectory,
  type InstanceSettings,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";

function readSettings(ctx: AppContext): InstanceSettings {
  return {
    instanceName: getSetting(ctx.db, "instanceName"),
    defaultLocale: getSetting(ctx.db, "defaultLocale"),
    defaultProjectRoleMember: getSetting(ctx.db, "defaultProjectRole.member"),
    defaultProjectRoleGuest: getSetting(ctx.db, "defaultProjectRole.guest"),
    trashRetentionDays: getSetting(ctx.db, "trash.retentionDays"),
  };
}

export function registerDirectoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  registerContract(app, listUsersDirectory, () => ({ users: listDirectoryUsers(db) }));

  registerContract(app, adminGetSettings, () => ({
    settings: readSettings(ctx),
    logo: instanceLogo(db),
  }));

  registerContract(app, adminUpdateSettings, ({ body }, request) => {
    const before = readSettings(ctx);
    db.transaction(() => {
      if (body.instanceName !== undefined) setSetting(db, "instanceName", body.instanceName);
      if (body.defaultLocale !== undefined) setSetting(db, "defaultLocale", body.defaultLocale);
      if (body.defaultProjectRoleMember !== undefined) {
        setSetting(db, "defaultProjectRole.member", body.defaultProjectRoleMember);
      }
      if (body.defaultProjectRoleGuest !== undefined) {
        setSetting(db, "defaultProjectRole.guest", body.defaultProjectRoleGuest);
      }
      if (body.trashRetentionDays !== undefined) {
        setSetting(db, "trash.retentionDays", body.trashRetentionDays);
      }
    });
    const after = readSettings(ctx);
    audit(db, request, {
      action: "settings.changed",
      targetType: "settings",
      details: { before, after },
    });
    return { settings: after };
  });
}
