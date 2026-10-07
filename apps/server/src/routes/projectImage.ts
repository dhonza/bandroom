import {
  fetchImage,
  SafeFetchError,
  type FetchedImage,
  type SafeFetchErrorCode,
} from "@bandroom/server-core";
import {
  IMAGE_URL_MAX_BYTES,
  ImageUrlFetchSchema,
  PROJECT_IMAGE_FETCH_PATH,
  type ErrorCode,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { registerAuthorizedRoute, userOrIpKey } from "../http/contracts";
import { AppError } from "../http/errors";

const FETCH_TIMEOUT_MS = 20_000;

const ERROR_FOR: Record<SafeFetchErrorCode, ErrorCode> = {
  INVALID_URL: "IMAGE_URL_INVALID",
  BLOCKED: "IMAGE_URL_BLOCKED",
  TOO_LARGE: "IMAGE_URL_TOO_LARGE",
  NOT_IMAGE: "IMAGE_URL_NOT_IMAGE",
  TOO_MANY_REDIRECTS: "IMAGE_URL_FAILED",
  HTTP_ERROR: "IMAGE_URL_FAILED",
  TIMEOUT: "IMAGE_URL_FAILED",
  NETWORK: "IMAGE_URL_FAILED",
};

/**
 * Project image from a URL (SPEC §25.4): the server fetches the image SSRF-safely and streams it
 * back for the browser's crop dialog. Nothing is stored and no event is written; the cropped
 * result is uploaded through tus like a picked file, which logs `project.updated`.
 */
export function registerProjectImageRoutes(api: FastifyInstance, ctx: AppContext): void {
  registerAuthorizedRoute(
    api,
    {
      method: "POST",
      url: PROJECT_IMAGE_FETCH_PATH,
      auth: { capability: "settings.manage", scope: "project" },
    },
    async (request, reply) => {
      const parsed = ImageUrlFetchSchema.safeParse(request.body);
      if (!parsed.success) throw new AppError("IMAGE_URL_INVALID", "A URL is required");
      const aborted = new AbortController();
      // The client went away: stop downloading.
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) aborted.abort();
      });
      let image: FetchedImage;
      try {
        image = await fetchImage(parsed.data.url, {
          maxBytes: IMAGE_URL_MAX_BYTES,
          timeoutMs: ctx.imageFetch.timeoutMs ?? FETCH_TIMEOUT_MS,
          signal: aborted.signal,
          ...(ctx.imageFetch.isBlocked && { isBlocked: ctx.imageFetch.isBlocked }),
          ...(ctx.imageFetch.resolve && { resolve: ctx.imageFetch.resolve }),
          ...(ctx.imageFetch.allowedPorts && { allowedPorts: ctx.imageFetch.allowedPorts }),
        });
      } catch (err) {
        if (err instanceof SafeFetchError) {
          request.log.info({ code: err.code, reason: err.message }, "image URL fetch refused");
          // The detail (addresses, hosts) stays in the log; the client gets the code only.
          throw new AppError(ERROR_FOR[err.code], "The image could not be fetched");
        }
        throw err;
      }
      // A failure after this point (size cap, timeout) can only cut the response short.
      image.stream.once("error", (err) => {
        request.log.info({ err }, "image URL fetch ended early");
      });
      reply.header("Cache-Control", "no-store");
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      if (image.contentLength !== null) reply.header("Content-Length", image.contentLength);
      return reply.type(image.mime).send(image.stream);
    },
    { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: userOrIpKey } },
  );
}
