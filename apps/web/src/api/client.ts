import {
  API_PREFIX,
  ApiErrorSchema,
  buildPath,
  joinBasePath,
  type ApiErrorBody,
  type ContractDef,
  type ContractInput,
  type ContractResponse,
} from "@bandroom/shared";
import { linkPathPrefix } from "../links/linkMode";
import { FROM_CACHE_HEADER } from "../offline/names";
import { reportNetworkFailure, reportNetworkSuccess } from "../offline/online";

/** Client-side error codes in addition to the server's (`errors.NETWORK`, `errors.UNKNOWN`). */
export type ClientErrorCode = "NETWORK" | "UNKNOWN";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | { code: ClientErrorCode; message: string },
  ) {
    super(body.message);
    this.name = "ApiError";
  }

  get code(): string {
    return this.body.code;
  }
}

let defaultBasePath = "";

/** Called once at startup with the runtime config's base path. */
export function setApiBasePath(basePath: string): void {
  defaultBasePath = basePath;
}

/**
 * The URL `api()` requests for a contract and input (the offline sync caches exactly these).
 * In the public-link view the same contracts are served below `/l/<token>` (SPEC §3.5).
 */
export function contractUrl(
  contract: Pick<ContractDef, "path">,
  input: {
    params?: Record<string, string | number>;
    query?: Record<string, string | number | boolean | null | undefined>;
  } = {},
  basePath = defaultBasePath,
): string {
  let url = joinBasePath(
    basePath,
    `${API_PREFIX}${linkPathPrefix()}${buildPath(contract.path, input.params)}`,
  );
  if (input.query !== undefined) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(input.query)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  return url;
}

export interface ApiOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  basePath?: string;
}

/**
 * Calls an API endpoint through its shared contract: builds the URL (base path + prefix + params),
 * sends the CSRF header, and validates the response with the contract's schema.
 */
export async function api<C extends ContractDef>(
  contract: C,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- "all keys optional" check
  ...[input, options = {}]: {} extends ContractInput<C>
    ? [input?: ContractInput<C>, options?: ApiOptions]
    : [input: ContractInput<C>, options?: ApiOptions]
): Promise<ContractResponse<C>> {
  const { signal, fetchImpl = fetch, basePath = defaultBasePath } = options;
  const { params, query, body } = (input ?? {}) as {
    params?: Record<string, string | number>;
    // Query schemas are flat objects of primitives by convention.
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
  };

  const url = contractUrl(contract, { params, query }, basePath);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Requested-With": "bandroom",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: contract.method,
      headers,
      credentials: "same-origin",
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(signal && { signal }),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    reportNetworkFailure();
    throw new ApiError(0, { code: "NETWORK", message: String(err) });
  }
  // The service worker answered from the offline cache: the network is not reachable (SPEC §13).
  if (res.headers.get(FROM_CACHE_HEADER)) reportNetworkFailure();
  else if (res.status < 502) reportNetworkSuccess();

  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(json);
    throw new ApiError(
      res.status,
      parsed.success ? parsed.data : { code: "UNKNOWN", message: `HTTP ${res.status}` },
    );
  }
  return contract.response.parse(json) as ContractResponse<C>;
}
