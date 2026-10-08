import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  API_PREFIX,
  ApiErrorSchema,
  buildPath,
  UploadResultSchema,
  type ContractDef,
  type ContractInput,
  type ContractResponse,
  type UploadResult,
  type UploadTarget,
} from "@bandroom/shared";
import type { RemoteConfig } from "./config";

/** An error answer of the API, with its stable code (SPEC §18.3). */
export class RemoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

/** Upload chunk size: small enough for slow links, few requests for big renders. */
export const CHUNK_BYTES = 16 * 1024 * 1024;

type Input = { params?: unknown; query?: unknown; body?: unknown };

async function errorOf(res: Response): Promise<RemoteError> {
  const text = await res.text();
  try {
    const e = ApiErrorSchema.parse(JSON.parse(text));
    return new RemoteError(res.status, e.code, e.message, e.params);
  } catch {
    return new RemoteError(res.status, `HTTP_${res.status}`, text.slice(0, 200) || res.statusText);
  }
}

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** A typed API client over the shared contracts, authenticated by an API key. */
export class Client {
  constructor(
    readonly config: RemoteConfig,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  get apiBase(): string {
    return `${this.config.url}${API_PREFIX}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}`, ...extra };
  }

  async call<C extends ContractDef>(
    contract: C,
    input: ContractInput<C> = {} as ContractInput<C>,
  ): Promise<ContractResponse<C>> {
    const i = input as Input;
    const params = (i.params ?? {}) as Record<string, string>;
    const url = new URL(`${this.apiBase}${buildPath(contract.path, params)}`);
    for (const [k, v] of Object.entries((i.query ?? {}) as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        url.searchParams.set(k, String(v));
    }
    const hasBody = i.body !== undefined;
    const res = await this.doFetch(url, {
      method: contract.method,
      headers: this.headers(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(hasBody && { body: JSON.stringify(i.body) }),
    });
    if (!res.ok) throw await errorOf(res);
    return contract.response.parse(await res.json()) as ContractResponse<C>;
  }

  /** `GET {url}/healthz` (no key needed). */
  async health(): Promise<{ status: number; body: unknown }> {
    const res = await this.doFetch(`${this.config.url}/healthz`, { headers: this.headers() });
    const body: unknown = await res.json();
    return { status: res.status, body };
  }

  /**
   * A tus upload (SPEC §5.1) of a local file: create, then PATCH in chunks. Returns the result of
   * the last chunk (the created track/version).
   */
  async upload(
    file: string,
    target: UploadTarget,
    onProgress: (sent: number, total: number) => void = () => undefined,
  ): Promise<UploadResult> {
    const size = fs.statSync(file).size;
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    const meta = `filename ${b64(path.basename(file))},target ${b64(JSON.stringify(target))}`;
    const create = await this.doFetch(`${this.apiBase}/uploads`, {
      method: "POST",
      headers: this.headers({
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(size),
        "Upload-Metadata": meta,
      }),
    });
    if (create.status !== 201) throw await errorOf(create);
    const location = create.headers.get("location");
    if (!location) throw new RemoteError(500, "NO_LOCATION", "The server sent no upload URL");
    const uploadUrl = new URL(location, `${this.apiBase}/uploads`).toString();

    const fd = fs.openSync(file, "r");
    try {
      let offset = 0;
      for (;;) {
        const len = Math.min(CHUNK_BYTES, size - offset);
        const buf = Buffer.alloc(len);
        if (len > 0) fs.readSync(fd, buf, 0, len, offset);
        const res = await this.doFetch(uploadUrl, {
          method: "PATCH",
          headers: this.headers({
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": String(offset),
            "Content-Type": "application/offset+octet-stream",
          }),
          body: new Uint8Array(buf),
        });
        if (!res.ok) throw await errorOf(res);
        offset += len;
        onProgress(offset, size);
        if (offset >= size) {
          return UploadResultSchema.parse(await res.json());
        }
        await res.arrayBuffer();
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}
