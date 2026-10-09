import { and, isNull, type SQL } from "drizzle-orm";
import { trackVersions } from "../db/schema";

/**
 * Track versions anyone may see (SPEC §24.2): not in the Trash and not the hidden render of an
 * Apply/Bounce that is not committed yet (`edit_session_id` set). Every version list, count, mix
 * and download filters with it.
 */
export function visibleVersion(): SQL {
  return and(isNull(trackVersions.deletedAt), isNull(trackVersions.editSessionId)) as SQL;
}
