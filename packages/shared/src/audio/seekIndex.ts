import * as z from "zod/mini";

/**
 * Seek index file as written by the ingest: `[sample, byte offset]` pairs in sample order
 * (decision log, M3). `zod/mini` keeps the decoder worker bundle small.
 */
export const SeekIndexSchema = z.array(
  z.tuple([z.number().check(z.nonnegative()), z.number().check(z.nonnegative())]),
);

export type SeekIndexEntries = z.infer<typeof SeekIndexSchema>;
