import { DatePickerRegistry } from "./DatePickerRegistry";
import { logger } from "../../utils/logger";

/**
 * Orchestrator for click-based custom date-picker widgets.
 *
 * Delegates matching to DatePickerRegistry (adapters self-register on module
 * load — see DatePickerRegistry.ts and its adapters/ folder). fill() runs the
 * full open -> navigateToMonth -> selectDay -> verify sequence for whichever
 * adapter matches the given element, and reports whether it succeeded.
 *
 * Supports three value shapes:
 *   - Single:  "2026/07/15"
 *   - Range:   "2026/07/02 - 2026/07/11"   (start - end)
 *   - Multi:   "2026/07/02, 2026/07/04, 2026/07/06"  (comma-separated)
 *
 * For range/multi, the calendar is opened once and each component date is
 * clicked in sequence — RMDP keeps the calendar open in range/multi mode and
 * expects sequential day clicks.
 */
export class DatePickerEngine {
  /**
   * Attempts to fill a date field using a registered adapter.
   *
   * @param el The date input/trigger element.
   * @param dateValue The target date as a string — single, range, or multi.
   * @returns true if a matching adapter completed the full fill sequence
   * successfully; false if no adapter matched, any date couldn't be parsed,
   * or any stage of the sequence failed.
   */
  static async fill(el: HTMLElement, dateValue: string): Promise<boolean> {
    const adapter = DatePickerRegistry.detect(el);
    if (!adapter) {
      logger.warn("DatePickerEngine", "No adapter matched this element.");
      return false;
    }

    // Split compound values into individual date strings
    const dateStrings = this.splitCompoundValue(dateValue);
    if (dateStrings.length === 0) {
      logger.warn("DatePickerEngine", `No date components found in "${dateValue}".`);
      return false;
    }

    // Parse all component dates upfront — fail early if any are invalid
    const targetDates: Date[] = [];
    for (const ds of dateStrings) {
      const parsed = this.parseDate(ds);
      if (!parsed || isNaN(parsed.getTime())) {
        logger.warn("DatePickerEngine", `Could not parse date component "${ds}" from value "${dateValue}".`);
        return false;
      }
      targetDates.push(parsed);
    }

    const isCompound = targetDates.length > 1;
    logger.debug("DatePickerEngine", `Using "${adapter.name}" adapter for ${targetDates.length} date(s).`);

    try {
      // Open the calendar once
      const opened = await adapter.open(el);
      if (!opened) {
        logger.warn("DatePickerEngine", `${adapter.name}: calendar did not open.`);
        return false;
      }

      // Click each date in sequence
      for (let i = 0; i < targetDates.length; i++) {
        const targetDate = targetDates[i];
        const isLast = i === targetDates.length - 1;

        const navigated = await adapter.navigateToMonth(targetDate);
        if (!navigated) {
          logger.warn("DatePickerEngine", `${adapter.name}: could not navigate to month/year for date ${i + 1}/${targetDates.length}.`);
          return false;
        }

        const selected = await adapter.selectDay(targetDate);
        if (!selected) {
          logger.warn("DatePickerEngine", `${adapter.name}: could not select day for date ${i + 1}/${targetDates.length}.`);
          return false;
        }

        // Only verify after the final date click — intermediate clicks in
        // range/multi mode update the input progressively and the calendar
        // stays open, so verifying intermediate state is unreliable.
        if (!isCompound || isLast) {
          const verified = await adapter.verify(el, targetDate);
          if (!verified) {
            logger.warn("DatePickerEngine", `${adapter.name}: value did not verify after selection.`);
            return false;
          }
        } else {
          // Small delay between compound clicks to let the calendar re-render
          await new Promise(r => setTimeout(r, 150));
        }
      }

      return true;
    } catch (err) {
      logger.error("DatePickerEngine", `${adapter.name} threw during fill: ${(err as Error).message}`, err);
      return false;
    }
  }

  /**
   * Splits compound date values into individual date strings.
   *
   * Handles:
   *   - Range: "2026/07/02 - 2026/07/11" → ["2026/07/02", "2026/07/11"]
   *   - Multi: "2026/07/02, 2026/07/04, 2026/07/06" → ["2026/07/02", "2026/07/04", "2026/07/06"]
   *   - Single: "2026/07/15" → ["2026/07/15"]
   */
  private static splitCompoundValue(value: string): string[] {
    if (!value || !value.trim()) return [];

    const trimmed = value.trim();

    // Range mode: " - " separator between two dates
    // Must check before comma split since range dates don't contain commas
    if (trimmed.includes(" - ")) {
      return trimmed.split(" - ").map(s => s.trim()).filter(Boolean);
    }

    // Multi-date mode: ", " separator between dates
    if (trimmed.includes(", ")) {
      return trimmed.split(", ").map(s => s.trim()).filter(Boolean);
    }

    // Single date
    return [trimmed];
  }

  /**
   * Parses common date string formats into a Date object.
   * ISO-style (YYYY-MM-DD) parses via native UTC parsing (matches
   * GenericDatePickerAdapter's UTC-getter convention). Slash/dash separated
   * year-last formats (DD/MM/YYYY or MM/DD/YYYY) parse via the local Date
   * constructor (matches RmdpAdapter's local-getter convention), defaulting
   * to day-first when ambiguous — consistent with this codebase's rmdp
   * default format elsewhere (see ExecutionEngine's detectElementDateFormat).
   */
  private static parseDate(value: string): Date | null {
    if (!value) return null;

    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      const parts = value.split("T")[0].split("-").map(Number);
      if (parts.length >= 3 && !parts.some(isNaN)) {
        return new Date(parts[0], parts[1] - 1, parts[2]);
      }
      const isoDate = new Date(value);
      return isNaN(isoDate.getTime()) ? null : isoDate;
    }

    const parts = value.split(/[\/\-.]/).filter(Boolean);
    if (parts.length !== 3) {
      const fallback = new Date(value);
      return isNaN(fallback.getTime()) ? null : fallback;
    }

    const [p1, p2, p3] = parts.map(Number);
    if ([p1, p2, p3].some((n) => isNaN(n))) return null;

    // Year-first: YYYY/MM/DD
    if (parts[0].length === 4) {
      return new Date(p1, p2 - 1, p3);
    }
    // Year-last: DD/MM/YYYY or MM/DD/YYYY
    if (parts[2].length === 4) {
      if (p1 > 12) return new Date(p3, p2 - 1, p1); // unambiguous day-first
      if (p2 > 12) return new Date(p3, p1 - 1, p2); // unambiguous month-first
      return new Date(p3, p2 - 1, p1); // ambiguous — default to day-first
    }

    return null;
  }
}
