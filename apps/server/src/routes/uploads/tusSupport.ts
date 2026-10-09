import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Upload } from "@tus/server";
import {
  activeAdminNames,
  getAsset,
  getDocumentRow,
  getTrackRow,
  getTrackVersionRow,
  resolveApiKey,
  resolveSession,
  type UserRow,
} from "@bandroom/server-core";
import {
  canUploadAudio,
  canUploadNewSong,
  hasGlobalCapability,
  hasScope,
  UploadTargetSchema,
  type ApiErrorBody,
  type ErrorCode,
  type UploadTarget,
} from "@bandroom/shared";
import type { AppContext } from "../../context";
import { AppError } from "../../http/errors";
import { checkScope, type ScopeAccess } from "../../http/scope";
import { bearerToken, SESSION_COOKIE } from "../../http/session";

export const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** @tus/server sends `status_code` and `body` of thrown errors to the client. */
export class TusError extends Error {
  constructor(
    readonly status_code: number,
    readonly body: string,
  ) {
    super(body);
    this.name = "TusError";
  }
}

export function tusError(
  code: ErrorCode,
  status: number,
  message: string,
  params?: Record<string, string | number>,
): TusError {
  const body: ApiErrorBody = { code, message, ...(params && { params }) };
  return new TusError(status, JSON.stringify(body));
}

export function toTusError(err: unknown): TusError {
  if (err instanceof TusError) return err;
  if (err instanceof AppError) return tusError(err.code, err.statusCode, err.message, err.params);
  return tusError("INTERNAL", 500, "Upload failed");
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/**
 * Client address per raw request, as Fastify resolved it (honouring `trustProxy`). The tus hooks
 * get a web Request built from the raw one and cannot see `request.ip`.
 */
export const clientIps = new WeakMap<IncomingMessage, string>();

/** The API key behind a raw request (bearer uploads, SPEC §29.3), for events. */
export const clientApiKeys = new WeakMap<IncomingMessage, string>();

function nodeOf(req: Request): IncomingMessage | undefined {
  return (req as { runtime?: { node?: { req?: IncomingMessage } } }).runtime?.node?.req;
}

/** The client's address for events, or null when unknown. */
export function ipOf(req: Request): string | null {
  const node = nodeOf(req);
  return (node && clientIps.get(node)) ?? null;
}

/** The API key id of a bearer upload request, or null for a cookie session. */
export function apiKeyIdOf(req: Request): string | null {
  const node = nodeOf(req);
  return (node && clientApiKeys.get(node)) ?? null;
}

/**
 * Resolves the user from the web Request (tus hooks do not see the Fastify request): a bearer API
 * key with the `write` scope, else the session cookie.
 */
export function userOf(ctx: AppContext, req: Request): UserRow {
  const bearer = bearerToken(req.headers.get("authorization"));
  if (bearer !== null) {
    const key = resolveApiKey(ctx.db, bearer, { ip: ipOf(req) });
    if (!key) throw tusError("API_KEY_INVALID", 401, "Invalid API key");
    if (!hasScope(key.scopes, "write"))
      throw tusError("API_KEY_SCOPE", 403, "The API key may not upload");
    return key.user;
  }
  const token = cookieValue(req.headers.get("cookie"), SESSION_COOKIE);
  const resolved = token ? resolveSession(ctx.db, token) : null;
  if (!resolved) throw tusError("UNAUTHENTICATED", 401, "Login required");
  return resolved.user;
}

export function adminNames(ctx: AppContext): string {
  return activeAdminNames(ctx.db).join(", ");
}

/** Content scope of the target, or null for the instance logo (admins only). */
export function authorizeTarget(
  ctx: AppContext,
  user: UserRow,
  target: UploadTarget,
): ScopeAccess | null {
  switch (target.type) {
    case "instanceLogo":
      if (!hasGlobalCapability(user, "admin.access"))
        throw new AppError("FORBIDDEN", "Missing capability admin.access");
      return null;
    case "newTrack":
      return requireAudioUpload(
        checkScope(ctx.db, user, "song", target.songId, "upload"),
        target.source === "recording",
      );
    case "newVersion":
      return requireAudioUpload(
        checkScope(ctx.db, user, "track", target.trackId, "upload"),
        target.source === "recording",
      );
    case "newSong": {
      const recording = target.source === "recording";
      const access = checkScope(
        ctx.db,
        user,
        "project",
        target.projectId,
        recording ? "record" : "song.create",
      );
      if (!canUploadNewSong(access.role, recording))
        throw new AppError("FORBIDDEN", "Missing capability upload, record or song.create");
      return access;
    }
    case "projectImage":
      return checkScope(ctx.db, user, "project", target.projectId, "settings.manage");
    case "newDocument":
      return checkScope(ctx.db, user, "project", target.projectId, "upload");
    case "documentVersion": {
      const access = checkScope(ctx.db, user, "document", target.documentId, "upload");
      if (!getDocumentRow(ctx.db, target.documentId))
        throw new AppError("NOT_FOUND", "Document not found");
      return access;
    }
  }
}

/** A recorded take (SPEC §9) also needs `record`, checked by the central permissions module. */
function requireAudioUpload(access: ScopeAccess, recording: boolean): ScopeAccess {
  if (!canUploadAudio(access.role, recording))
    throw new AppError("FORBIDDEN", "Missing capability record");
  return access;
}

export function parseTarget(upload: Upload): { target: UploadTarget; filename: string } {
  const filename = upload.metadata?.filename?.trim() || "upload";
  let raw: unknown;
  try {
    raw = JSON.parse(upload.metadata?.target ?? "null");
  } catch {
    throw tusError("VALIDATION_FAILED", 400, "Invalid upload target");
  }
  const parsed = UploadTargetSchema.safeParse(raw);
  if (!parsed.success) throw tusError("VALIDATION_FAILED", 400, "Invalid upload target");
  return { target: parsed.data, filename: path.basename(filename).slice(0, 255) };
}

/** The target stored with an upload session, or null when it no longer parses. */
export function parseStoredTarget(json: string): UploadTarget | null {
  try {
    const parsed = UploadTargetSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Client-side dedupe (SPEC §29.5): a new version whose declared SHA-256 equals the original of
 * the track's current version is refused before any byte is sent.
 */
export function refuseDuplicateVersion(ctx: AppContext, trackId: string, sha256: string): void {
  const track = getTrackRow(ctx.db, trackId);
  const current = track?.currentVersionId
    ? getTrackVersionRow(ctx.db, track.currentVersionId)
    : undefined;
  const asset = current ? getAsset(ctx.db, current.assetId) : undefined;
  if (asset?.originalHash === sha256) {
    throw tusError("DUPLICATE_VERSION", 409, "Same file as the current version", {
      trackVersionId: current?.id ?? "",
    });
  }
}
