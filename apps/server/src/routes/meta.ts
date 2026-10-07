import { getSetting, instanceLogoHash, type Db } from "@bandroom/server-core";
import { getMeta, LOCALES, type Locale } from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import { registerContract } from "../http/contracts";

export interface InstanceInfo {
  instanceName: string;
  defaultLocale: Locale;
  logoHash: string | null;
}

/** Effective instance name and default locale: admin setting, else environment. */
export function instanceInfo(
  db: Db,
  env: { appName: string; defaultLocale: Locale },
): InstanceInfo {
  return {
    instanceName: getSetting(db, "instanceName") ?? env.appName,
    defaultLocale: getSetting(db, "defaultLocale") ?? env.defaultLocale,
    logoHash: instanceLogoHash(db),
  };
}

export function registerMetaRoutes(
  app: FastifyInstance,
  deps: { db: Db; appName: string; defaultLocale: Locale; version: string },
): void {
  registerContract(app, getMeta, () => ({
    ...instanceInfo(deps.db, deps),
    version: deps.version,
    locales: [...LOCALES],
  }));
}
