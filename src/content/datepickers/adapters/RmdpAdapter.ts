import { DatePickerAdapter } from "../DatePickerAdapter";
import { dispatchEvents } from "../../domUtils";
import { SmartWaitEngine } from "../../engines/SmartWaitEngine";
import { logger } from "../../../utils/logger";
import {
  DATEPICKER_CALENDAR_OPEN_TIMEOUT,
  DATEPICKER_VIEW_SWITCH_TIMEOUT,
  DATEPICKER_NAV_STEP_TIMEOUT,
  DATEPICKER_NAV_MAX_ITERATIONS,
  DATEPICKER_VALUE_SETTLE_TIMEOUT,
} from "../../../shared/constants";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface HeaderState {
  month: number;
  year: number;
}

/**
 * Adapter for react-multi-date-picker (rmdp) — identified by the `.rmdp-input`
 * trigger class.
 *
 * rmdp tracks the selected date purely in its own internal component state; it
 * never reads the underlying <input>'s DOM `.value`, so the generic
 * click+set-value fallback is a silent no-op here. This adapter performs the
 * real interaction sequence instead: open the calendar, get the visible
 * month/year to match the target date, then click the actual day cell.
 *
 * Stateless between calls (matches GenericDatePickerAdapter's convention) —
 * each method re-locates the open `.rmdp-wrapper` fresh via the DOM rather
 * than caching a reference, since DatePickerEngine only processes one field's
 * calendar at a time.
 */
const WRAPPER_SELECTOR = ".rmdp-wrapper";

export class RmdpAdapter implements DatePickerAdapter {
  readonly name = "RmdpAdapter";
  private activeElement: HTMLElement | null = null;
  private activeWrapper: HTMLElement | null = null;

  matches(element: HTMLElement): boolean {
    return element.classList.contains("rmdp-input");
  }

  async open(element: HTMLElement): Promise<boolean> {
    // Capture wrapper pointer BEFORE resetting active state so dismissStaleCalendars knows
    // if a portaled wrapper belongs to a same-element retry
    const previousWrapper = this.activeElement === element ? this.activeWrapper : null;
    this.activeWrapper = null;
    this.activeElement = element;

    // BUG-042: Dismiss any stale RMDP calendar that may still be open from a
    // previous datepicker field BEFORE checking if the current wrapper is open.
    // Without this order, findWrapper() on adjacent inputs picks up the stale
    // wrapper from the prior field and skips cleanup.
    await this.dismissStaleCalendars(element, previousWrapper);

    // Check if the calendar is already open for this element (to avoid toggling it closed on click)
    const existingWrapper = this.findWrapper();
    if (existingWrapper) {
      logger.debug("RmdpAdapter", "RMDP: calendar wrapper already open for this element.");
      this.activeWrapper = existingWrapper;
      return true;
    }

    element.focus();
    dispatchEvents(element, ["focus", "focusin", "mousedown", "mouseup", "click"]);
    
    const wrapper = await SmartWaitEngine.waitForCondition(
      () => this.findWrapper(),
      DATEPICKER_CALENDAR_OPEN_TIMEOUT
    ).catch(() => null);

    if (!wrapper) {
      logger.warn("RmdpAdapter", "Calendar popup did not open after clicking the input.");
      return false;
    }
    
    this.activeWrapper = wrapper;
    logger.debug("RmdpAdapter", "RMDP: wrapper active cached successfully.");
    return true;
  }

  async navigateToMonth(targetDate: Date): Promise<boolean> {
    const wrapper = this.findWrapper();
    if (!wrapper) {
      logger.error("RmdpAdapter", "Calendar wrapper not found for month navigation.");
      return false;
    }

    const targetMonth = targetDate.getMonth();
    const targetYear = targetDate.getFullYear();

    const isOnTarget = () => {
      const h = this.readHeader(wrapper);
      return !!h && h.month === targetMonth && h.year === targetYear;
    };
    if (isOnTarget()) return true;

    // Fast path: rmdp's built-in year-picker/month-picker views (jump directly).
    try {
      await this.navigateViaPickerViews(wrapper, targetMonth, targetYear);
      if (isOnTarget()) return true;
    } catch (err) {
      logger.debug("RmdpAdapter", `Picker-view navigation unavailable, falling back to arrow stepping: ${(err as Error).message}`);
    }

    // Slow-path fallback: click prev/next arrows one month at a time.
    try {
      await this.navigateViaArrowStepping(wrapper, targetMonth, targetYear);
      return true;
    } catch (err) {
      logger.error("RmdpAdapter", (err as Error).message);
      return false;
    }
  }

  async selectDay(targetDate: Date): Promise<boolean> {
    const wrapper = this.findWrapper();
    if (!wrapper) {
      logger.error("RmdpAdapter", "Calendar wrapper not found for day selection.");
      return false;
    }

    const dayCell = this.findCellByText(wrapper, String(targetDate.getDate()));
    if (!dayCell) {
      logger.error("RmdpAdapter", `Day ${targetDate.getDate()} not found in the currently displayed month.`);
      return false;
    }
    if (this.isCellDisabled(dayCell)) {
      logger.error("RmdpAdapter", `Day ${targetDate.getDate()} is disabled on this field (site does not allow this date).`);
      return false;
    }

    dispatchEvents(dayCell, ["mousedown", "mouseup", "click"]);
    return true;
  }

  async verify(element: HTMLElement, _targetDate: Date): Promise<boolean> {
    this.activeElement = element;
    const inputEl = element as HTMLInputElement;

    // Wait for the input value to be set
    const valueSet = await SmartWaitEngine.waitForCondition(() => {
      return inputEl.value.trim() ? true : null;
    }, DATEPICKER_VALUE_SETTLE_TIMEOUT).catch(() => null);

    if (!valueSet) {
      logger.error("RmdpAdapter", `Date did not appear to be set (input still empty).`);
      return false;
    }

    // Actively close the calendar after date selection completes (single, range, or multi).
    const wrapper = this.findWrapper();
    if (wrapper) {
      // 1. Blur target input immediately to trigger focus-loss close logic
      element.blur();

      // 2. Dispatch outside click on document.body for outside-click listeners
      dispatchEvents(document.body, ["mousedown", "mouseup", "click"]);

      // 3. Fast poll for DOM detachment / visibility loss (200ms ceiling)
      await SmartWaitEngine.waitForCondition(() => {
        return !wrapper.isConnected || !this.isWrapperVisible(wrapper) ? true : null;
      }, 200).catch(() => null);

      // 4. Final safety: if wrapper is STILL connected to DOM, force-remove it
      if (wrapper.isConnected) {
        logger.debug("RmdpAdapter", "Calendar wrapper still connected after blur. Force-removing from DOM.");
        wrapper.remove();
      }
    }

    // Clear activeWrapper cache on completion
    this.activeWrapper = null;
    return true;
  }

  /** Checks if a wrapper element is currently visible in the DOM viewport. */
  private isWrapperVisible(el: HTMLElement): boolean {
    if (!el.isConnected) return false;
    
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    
    if (el.getClientRects().length === 0) {
      return false;
    }

    // Verify the wrapper contains expected RMDP elements to avoid false matches
    const hasCalendarElements = el.querySelector(".rmdp-calendar") || el.querySelector(".rmdp-day");
    if (!hasCalendarElements) {
      return false;
    }

    // Verify the inner calendar popup actually has layout dimensions
    const rectEl = el.getBoundingClientRect();
    const innerCalendar = el.querySelector(".rmdp-calendar") as HTMLElement | null;
    const rectInner = innerCalendar ? innerCalendar.getBoundingClientRect() : null;
    
    const width = Math.max(rectEl.width, rectInner?.width ?? 0);
    const height = Math.max(rectEl.height, rectInner?.height ?? 0);
    
    if (width === 0 || height === 0) {
      return false;
    }

    return true;
  }

  /**
   * Finds the currently-open rmdp calendar popup.
   * Scopes search to active element container first, then falls back to active, visible portaled wrappers.
   * 
   * RMDP with portal={true} renders WRAPPER_SELECTOR directly under <body>,
   * so the wrapper may not exist inside the input container.
   */
  private findWrapper(): HTMLElement | null {
    // 1. Prefer cached activeWrapper if still valid
    if (this.activeWrapper) {
      const currentContainer = this.activeElement?.closest(".rmdp-container");
      const wrapperContainer = this.activeWrapper.closest(".rmdp-container");
      const belongsToCurrentField = !currentContainer || wrapperContainer === currentContainer;

      if (this.isWrapperVisible(this.activeWrapper) && belongsToCurrentField) {
        logger.debug("RmdpAdapter", "RMDP: using cached wrapper");
        return this.activeWrapper;
      }
      logger.debug("RmdpAdapter", "RMDP: cached wrapper was hidden, detached, or belongs to another container, invalidating");
      this.activeWrapper = null;
    }

    if (!this.activeElement) {
      // Global fallback for no-context calls
      const all = Array.from(document.querySelectorAll(WRAPPER_SELECTOR)) as HTMLElement[];
      const visible = all.filter(w => this.isWrapperVisible(w));
      return visible[0] || null;
    }

    // 2. Scoped container search
    const container = this.activeElement.closest(".rmdp-container");
    if (container) {
      const wrapper = container.querySelector(WRAPPER_SELECTOR) as HTMLElement | null;
      if (wrapper && this.isWrapperVisible(wrapper)) {
        logger.debug("RmdpAdapter", "RMDP: scoped wrapper found inside container");
        this.activeWrapper = wrapper;
        return wrapper;
      }
    }

    // 3. Global portal search
    const allWrappers = Array.from(document.querySelectorAll(WRAPPER_SELECTOR)) as HTMLElement[];
    const visibleWrappers = allWrappers.filter(w => this.isWrapperVisible(w));
    logger.debug("RmdpAdapter", `RMDP: visible wrappers = ${visibleWrappers.length}`);

    if (visibleWrappers.length === 1) {
      const singleWrapper = visibleWrappers[0];
      const singleContainer = singleWrapper.closest(".rmdp-container");
      const activeContainer = this.activeElement?.closest(".rmdp-container");

      // If both have containers and they differ, this is a stale wrapper from another field
      if (singleContainer && activeContainer && singleContainer !== activeContainer) {
        logger.debug("RmdpAdapter", "RMDP: single visible wrapper belongs to a different container, ignoring");
        return null;
      }

      logger.debug("RmdpAdapter", "RMDP: using single visible portaled wrapper");
      this.activeWrapper = singleWrapper;
      return singleWrapper;
    }

    if (visibleWrappers.length > 1) {
      // Ambiguity resolution:
      // A. Prefer container matching first (already checked above, but keep as fallback)
      const containerMatched = visibleWrappers.find(w => container && container.contains(w));
      if (containerMatched) {
        this.activeWrapper = containerMatched;
        return containerMatched;
      }

      // B. Prefer the single portal wrapper (one with no closest .rmdp-container)
      const portaledOnly = visibleWrappers.filter(w => !w.closest(".rmdp-container"));
      if (portaledOnly.length === 1) {
        logger.debug("RmdpAdapter", "RMDP: using single portaled wrapper with no container parent");
        this.activeWrapper = portaledOnly[0];
        return portaledOnly[0];
      }

      // C. Sort by geographic proximity as a last resort
      logger.debug("RmdpAdapter", "RMDP: multiple candidates, sorting by proximity as last resort");
      const inputRect = this.activeElement.getBoundingClientRect();
      visibleWrappers.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        const distA = Math.hypot(rectA.left - inputRect.left, rectA.top - inputRect.bottom);
        const distB = Math.hypot(rectB.left - inputRect.left, rectB.top - inputRect.bottom);
        return distA - distB;
      });

      this.activeWrapper = visibleWrappers[0];
      return visibleWrappers[0];
    }

    return null;
  }

  /**
   * BUG-042: Dismisses any stale RMDP calendar that may still be open on the page
   * before we open a new one. This prevents cross-contamination between adjacent
   * datepicker fields.
   */
  private async dismissStaleCalendars(newElement: HTMLElement, previousWrapper: HTMLElement | null = null): Promise<void> {
    const allWrappers = Array.from(document.querySelectorAll(WRAPPER_SELECTOR)) as HTMLElement[];
    if (allWrappers.length === 0) return;

    // Check if any open wrapper belongs to a DIFFERENT rmdp-container than our target
    const targetContainer = newElement.closest(".rmdp-container");
    let foundStale = false;
    const staleInputs: HTMLElement[] = [];
    const staleWrappers: HTMLElement[] = [];

    for (const wrapper of allWrappers) {
      if (!this.isWrapperVisible(wrapper)) continue;

      // Same-element retry guard: do not dismiss the wrapper if it belongs to the exact element being retried
      if (previousWrapper && wrapper === previousWrapper) {
        continue;
      }

      const wrapperContainer = wrapper.closest(".rmdp-container");
      if (wrapperContainer) {
        if (wrapperContainer !== targetContainer) {
          const staleInput = wrapperContainer.querySelector(".rmdp-input") as HTMLElement | null;
          if (staleInput) {
            staleInputs.push(staleInput);
            foundStale = true;
          }
        }
      } else {
        // Portaled wrapper with no container — visible but doesn't belong to targetContainer
        staleWrappers.push(wrapper);
        foundStale = true;
      }
    }

    if (foundStale) {
      logger.debug("RmdpAdapter", "RMDP: dismissing stale wrapper");
      // Clear cache first
      this.activeWrapper = null;

      // 1. Attempt body-click dismissal first (standard for portals)
      dispatchEvents(document.body, ["mousedown", "mouseup", "click"]);
      
      // Wait briefly for the body click to register
      await new Promise(r => setTimeout(r, 200));

      // 2. Only if stale wrappers are still visible, toggle the stale inputs
      const remainingStale = staleWrappers.some(w => this.isWrapperVisible(w)) || 
                             staleInputs.some(input => {
                               const c = input.closest(".rmdp-container");
                               const w = c?.querySelector(WRAPPER_SELECTOR) as HTMLElement | null;
                               return w && this.isWrapperVisible(w);
                             });

      if (remainingStale) {
        logger.debug("RmdpAdapter", "RMDP: body click failed to close all stale wrappers, toggling inputs");
        for (const staleInput of staleInputs) {
          staleInput.focus();
          dispatchEvents(staleInput, ["focus", "focusin", "mousedown", "mouseup", "click"]);
        }
      }

      // Wait up to 500ms for stale calendars to actually remove or hide
      await SmartWaitEngine.waitForCondition(() => {
        const remaining = Array.from(document.querySelectorAll(WRAPPER_SELECTOR)) as HTMLElement[];
        const hasVisibleStale = remaining.some(w => {
          if (!this.isWrapperVisible(w)) return false;
          if (previousWrapper && w === previousWrapper) return false;
          const c = w.closest(".rmdp-container");
          return !c || c !== targetContainer;
        });
        return !hasVisibleStale ? true : null;
      }, 500).catch(() => {
        logger.debug("RmdpAdapter", "Stale calendar dismissal timed out, proceeding anyway.");
      });

      // Settle delay
      await new Promise(r => setTimeout(r, 100));
    }
  }

  /** Reads the currently-displayed month/year from the header. Returns null if unavailable. */
  private readHeader(wrapper: HTMLElement): HeaderState | null {
    const headerEl = wrapper.querySelector(".rmdp-header-values");
    if (!headerEl) return null;

    const spans = headerEl.querySelectorAll("span");
    let monthText = "";
    let yearText = "";

    if (spans.length >= 2) {
      monthText = spans[0].textContent?.replace(",", "").trim() ?? "";
      yearText = spans[1].textContent?.trim() ?? "";
    } else {
      // Fallback: parse month name + year from raw text (e.g. "July, 2026")
      const raw = headerEl.textContent ?? "";
      const match = raw.match(/([A-Za-z]+)\D+(\d{4})/);
      if (!match) return null;
      monthText = match[1];
      yearText = match[2];
    }

    const month = MONTH_NAMES.indexOf(monthText);
    const year = Number(yearText);
    if (month === -1 || isNaN(year)) return null;
    return { month, year };
  }

  /** Fast path: use rmdp's built-in year-picker / month-picker views (opened by clicking the header text). */
  private async navigateViaPickerViews(wrapper: HTMLElement, targetMonth: number, targetYear: number): Promise<void> {
    const header = this.readHeader(wrapper);
    if (!header) throw new Error("rmdp: could not read header state.");

    if (header.year !== targetYear) {
      const headerSpans = wrapper.querySelectorAll(".rmdp-header-values span");
      const yearSpan = headerSpans[1] as HTMLElement | undefined;
      if (!yearSpan) throw new Error("rmdp: year header span not found.");
      dispatchEvents(yearSpan, ["mousedown", "mouseup", "click"]);

      const yearPicker = await SmartWaitEngine.waitForCondition(() => {
        const pickerEl = wrapper.querySelector(".rmdp-year-picker") as HTMLElement | null;
        return pickerEl && window.getComputedStyle(pickerEl).display !== "none" ? pickerEl : null;
      }, DATEPICKER_VIEW_SWITCH_TIMEOUT).catch(() => {
        throw new Error("rmdp: year-picker view did not open.");
      });

      let yearCell = this.findCellByText(yearPicker, String(targetYear));
      if (!yearCell) {
        let attempts = 0;
        const maxAttempts = 15;
        while (!yearCell && attempts < maxAttempts) {
          // Read currently rendered years in the year picker grid to determine direction
          const years = Array.from(yearPicker.querySelectorAll(".rmdp-day span"))
            .map(el => Number(el.textContent?.trim()))
            .filter(n => !isNaN(n));
          
          if (years.length === 0) break;
          const minYear = Math.min(...years);
          
          const isBefore = targetYear < minYear;
          const arrowSelector = isBefore ? ".rmdp-left" : ".rmdp-right";
          const arrow = wrapper.querySelector(arrowSelector) as HTMLElement | null;
          if (!arrow || arrow.classList.contains("disabled")) break;
          
          dispatchEvents(arrow, ["mousedown", "mouseup", "click"]);
          await new Promise(r => setTimeout(r, 200));
          
          const activeYearPicker = wrapper.querySelector(".rmdp-year-picker") as HTMLElement | null;
          if (!activeYearPicker) break;
          yearCell = this.findCellByText(activeYearPicker, String(targetYear));
          attempts++;
        }
      }

      if (!yearCell) throw new Error(`rmdp: year ${targetYear} not present or reachable in year-picker range.`);
      if (this.isCellDisabled(yearCell)) {
        throw new Error(`rmdp: year ${targetYear} is disabled (not selectable on this field).`);
      }
      dispatchEvents(yearCell, ["mousedown", "mouseup", "click"]);
    }

    const afterYear = this.readHeader(wrapper);
    if (!afterYear || afterYear.month !== targetMonth) {
      let monthPicker = await SmartWaitEngine.waitForCondition(() => {
        const pickerEl = wrapper.querySelector(".rmdp-month-picker") as HTMLElement | null;
        return pickerEl && window.getComputedStyle(pickerEl).display !== "none" ? pickerEl : null;
      }, DATEPICKER_VIEW_SWITCH_TIMEOUT).catch(() => null);

      if (!monthPicker) {
        const headerSpans = wrapper.querySelectorAll(".rmdp-header-values span");
        const monthSpan = headerSpans[0] as HTMLElement | undefined;
        if (!monthSpan) throw new Error("rmdp: month header span not found.");
        dispatchEvents(monthSpan, ["mousedown", "mouseup", "click"]);

        monthPicker = await SmartWaitEngine.waitForCondition(() => {
          const pickerEl = wrapper.querySelector(".rmdp-month-picker") as HTMLElement | null;
          return pickerEl && window.getComputedStyle(pickerEl).display !== "none" ? pickerEl : null;
        }, DATEPICKER_VIEW_SWITCH_TIMEOUT).catch(() => {
          throw new Error("rmdp: month-picker view did not open.");
        });
      }

      const monthCell = this.findCellByText(monthPicker, MONTH_NAMES[targetMonth]);
      if (!monthCell) throw new Error(`rmdp: month ${MONTH_NAMES[targetMonth]} not found in month-picker.`);
      if (this.isCellDisabled(monthCell)) {
        throw new Error(`rmdp: month ${MONTH_NAMES[targetMonth]} is disabled (not selectable on this field).`);
      }
      dispatchEvents(monthCell, ["mousedown", "mouseup", "click"]);
    }

    await SmartWaitEngine.waitForCondition(() => {
      const h = this.readHeader(wrapper);
      return h && h.month === targetMonth && h.year === targetYear ? true : null;
    }, DATEPICKER_VIEW_SWITCH_TIMEOUT).catch(() => {
      throw new Error("rmdp: header did not settle on target month/year after picker-view navigation.");
    });
  }

  /** Slow-path fallback: repeatedly click the prev/next arrow until the header matches. */
  private async navigateViaArrowStepping(wrapper: HTMLElement, targetMonth: number, targetYear: number): Promise<void> {
    for (let i = 0; i < DATEPICKER_NAV_MAX_ITERATIONS; i++) {
      const header = this.readHeader(wrapper);
      if (!header) throw new Error("rmdp: could not read header state during arrow stepping.");
      if (header.month === targetMonth && header.year === targetYear) return;

      const targetIsAfter =
        targetYear > header.year || (targetYear === header.year && targetMonth > header.month);
      // Matches both the real site's `.rmdp-arrow-container.rmdp-right/left` spans
      // and simplified `.rmdp-right`/`.rmdp-left` markup, since both carry this class.
      const arrowSelector = targetIsAfter ? ".rmdp-right" : ".rmdp-left";
      const arrow = wrapper.querySelector(arrowSelector) as HTMLElement | null;

      if (!arrow) throw new Error(`rmdp: navigation arrow (${targetIsAfter ? "next" : "prev"}) not found.`);
      if (arrow.classList.contains("disabled")) {
        throw new Error(
          `rmdp: reached the edge of the selectable range before reaching ${MONTH_NAMES[targetMonth]} ${targetYear} — this date may not be allowed on this field.`
        );
      }

      const prevHeaderText = wrapper.querySelector(".rmdp-header-values")?.textContent ?? "";
      dispatchEvents(arrow, ["mousedown", "mouseup", "click"]);

      await SmartWaitEngine.waitForCondition(() => {
        const currentText = wrapper.querySelector(".rmdp-header-values")?.textContent ?? "";
        return currentText !== prevHeaderText ? true : null;
      }, DATEPICKER_NAV_STEP_TIMEOUT).catch(() => {
        throw new Error("rmdp: header did not update after clicking the navigation arrow.");
      });
    }

    throw new Error(
      `rmdp: could not reach ${MONTH_NAMES[targetMonth]} ${targetYear} within ${DATEPICKER_NAV_MAX_ITERATIONS} navigation steps.`
    );
  }

  /** Finds a `.rmdp-day` cell (used for day/month/year grids alike in rmdp's DOM) whose inner <span> text exactly matches. */
  private findCellByText(scope: HTMLElement, text: string): HTMLElement | null {
    const cells = Array.from(scope.querySelectorAll(".rmdp-day")) as HTMLElement[];
    return cells.find((cell) => cell.querySelector("span")?.textContent?.trim() === text) ?? null;
  }

  /** A cell is unusable if it's a hidden filler cell (padding for the week grid) or explicitly disabled by the site. */
  private isCellDisabled(cell: HTMLElement): boolean {
    return cell.classList.contains("rmdp-day-hidden") || cell.classList.contains("rmdp-disabled");
  }
}
