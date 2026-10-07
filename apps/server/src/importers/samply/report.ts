import type { ImportReport, ImportReportItem } from "@bandroom/shared";

/** Report items kept (any outcome), plus failed items kept beyond that; counts stay exact. */
export const REPORT_MAX_ITEMS = 2000;
export const REPORT_MAX_FAILED_ITEMS = 5000;

export class Reporter {
  readonly report: ImportReport;
  private failedKept = 0;
  constructor(dryRun: boolean) {
    this.report = { dryRun, counts: {}, items: [], unmatchedAuthors: [], log: [] };
  }
  item(i: ImportReportItem): void {
    const key = `${i.kind}.${i.outcome}`;
    this.report.counts[key] = (this.report.counts[key] ?? 0) + 1;
    // Keep the stored report bounded: failures are kept past the general cap, but not without end.
    const failed = i.outcome === "failed";
    if (failed && this.failedKept >= REPORT_MAX_FAILED_ITEMS) return;
    if (this.report.items.length < REPORT_MAX_ITEMS || failed) {
      this.report.items.push(i);
      if (failed) this.failedKept++;
    }
  }
  log(line: string): void {
    this.report.log.push(line);
    if (this.report.log.length > 500) this.report.log.shift();
  }
}
