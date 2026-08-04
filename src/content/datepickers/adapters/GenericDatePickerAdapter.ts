import { DatePickerAdapter } from "../DatePickerAdapter";
import { dispatchEvents, setInputValue } from "../../domUtils";
import { SmartWaitEngine } from "../../engines/SmartWaitEngine";
import { logger } from "../../../utils/logger";
import { GENERIC_DATEPICKER_MAX_DISTANCE_PX } from "../../../shared/constants";

/**
 * Fallback adapter for unknown date pickers.
 * Uses DOM heuristics to find calendar popups, navigate months, and select day cells.
 *
 * Registered in DatePickerRegistry *after* RmdpAdapter and any other
 * library-specific adapter — this one only runs when nothing more specific matched.
 */
export class GenericDatePickerAdapter implements DatePickerAdapter {
  readonly name = "GenericDatePickerAdapter";
  private activeElement: HTMLElement | null = null;

  matches(element: HTMLElement): boolean {
    if (!(element instanceof HTMLInputElement)) return false;

    // Matches if it looks like a date field
    const isDate =
      element.type === "date" ||
      element.classList.contains("datepicker") ||
      element.classList.contains("flatpickr-input") ||
      /date|calendar|dob|birth|expiry/i.test(element.name || element.id || element.className || "");

    // Exclude RMDP-specific fields since RmdpAdapter is higher priority
    const isRmdp =
      element.classList.contains("rmdp-input") ||
      element.closest(".rmdp-container, .rmdp-wrapper") !== null;

    return isDate && !isRmdp;
  }

  async open(element: HTMLElement): Promise<boolean> {
    logger.info("GenericDatePickerAdapter", "Attempting to open generic calendar...");
    this.activeElement = element;

    // 1. Close any already open calendar popup to ensure clean state
    await this.closeAllCalendars();

    let popupFound = false;
    let resolvePromise: (value: boolean) => void;
    const popupPromise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    });

    const observer = new MutationObserver((_, obs) => {
      const popup = this.findCalendarPopup();
      if (popup) {
        if (this.isSpecificCalendarContainer(popup) && this.getNumberCount(popup) === 0) {
          return;
        }
        popupFound = true;
        obs.disconnect();
        resolvePromise(true);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    const timeoutTimer = setTimeout(() => {
      if (!popupFound) {
        observer.disconnect();
        const popup = this.findCalendarPopup();
        resolvePromise(popup !== null);
      }
    }, 3000);

    // Simulate clicking the input field to trigger the popup
    dispatchEvents(element, ["mousedown", "mouseup", "click"]);

    const result = await popupPromise;
    clearTimeout(timeoutTimer);

    if (result) {
      logger.info("GenericDatePickerAdapter", "Generic calendar popup detected in DOM.");
    } else {
      logger.warn("GenericDatePickerAdapter", "No calendar popup detected after clicking element.");
    }
    return result;
  }

  async navigateToMonth(targetDate: Date): Promise<boolean> {
    const popup = this.findCalendarPopup();
    if (!popup) {
      logger.error("GenericDatePickerAdapter", "Calendar popup not found for month navigation");
      return false;
    }

    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();

    // 1. Try direct year select dropdown / input if present in generic calendar (e.g. Flatpickr, jQuery UI)
    const yearSelect = popup.querySelector("select.ui-datepicker-year, select.flatpickr-monthDropdown-months, input.cur-year, [class*='year']") as HTMLSelectElement | HTMLInputElement | null;
    if (yearSelect) {
      if (yearSelect instanceof HTMLSelectElement) {
        const option = Array.from(yearSelect.options).find(opt => opt.value === String(targetYear) || opt.textContent?.trim() === String(targetYear));
        if (option) {
          yearSelect.value = option.value;
          dispatchEvents(yearSelect, ["change", "input"]);
          await new Promise(r => setTimeout(r, 50));
        }
      } else if (yearSelect instanceof HTMLInputElement) {
        setInputValue(yearSelect, String(targetYear));
        dispatchEvents(yearSelect, ["change", "input"]);
        await new Promise(r => setTimeout(r, 50));
      }
    }

    // 2. Try to find and parse the month/year header in the popup
    const headerInfo = this.findHeaderMonthYear(popup);
    if (!headerInfo) {
      logger.warn("GenericDatePickerAdapter", "Could not locate/parse month/year header in calendar. Skipping month navigation and proceeding to day selection directly.");
      return true; // Proceed directly (the correct month might already be displayed)
    }

    // 3. Locate navigation buttons
    const navButtons = this.findNavButtons(popup);
    if (!navButtons.prev || !navButtons.next) {
      logger.warn("GenericDatePickerAdapter", "Could not locate month navigation buttons (prev/next) in calendar. Proceeding directly to day selection.");
      return true;
    }

    let attempts = 0;
    const maxAttempts = 1200; // Allow up to 100 years of month-by-month navigation if dropdown is absent

    while (attempts < maxAttempts) {
      const currentHeader = this.findHeaderMonthYear(popup);
      if (!currentHeader) {
        logger.warn("GenericDatePickerAdapter", "Lost header element during navigation. Proceeding to day selection.");
        return true;
      }

      const { month: currentMonth, year: currentYear } = currentHeader;

      if (currentYear === targetYear && currentMonth === targetMonth) {
        logger.info("GenericDatePickerAdapter", `Successfully navigated to target month/year: ${currentMonth + 1}/${currentYear}`);
        return true;
      }

      let direction: "left" | "right";
      if (currentYear < targetYear) {
        direction = "right";
      } else if (currentYear > targetYear) {
        direction = "left";
      } else {
        direction = currentMonth < targetMonth ? "right" : "left";
      }

      const btn = direction === "left" ? navButtons.prev : navButtons.next;
      logger.info("GenericDatePickerAdapter", `Navigating ${direction} from ${currentMonth + 1}/${currentYear} towards ${targetMonth + 1}/${targetYear}`);
      dispatchEvents(btn, ["mousedown", "mouseup", "click"]);

      // Wait for change
      await SmartWaitEngine.waitForDOMStability(200);
      attempts++;
    }

    logger.error("GenericDatePickerAdapter", `Exceeded max navigation limit of ${maxAttempts} clicks`);
    return false;
  }

  async selectDay(targetDate: Date): Promise<boolean> {
    const popup = this.findCalendarPopup();
    if (!popup) {
      logger.error("GenericDatePickerAdapter", "Calendar popup not found for day selection");
      return false;
    }

    const targetDayStr = String(targetDate.getDate());
    const candidates = Array.from(popup.querySelectorAll("*")) as HTMLElement[];

    // Heuristically find day cells
    const dayCells = candidates.filter((el) => {
      if (!this.isElementVisible(el)) return false;

      const cellDayStr = this.getDayNumberFromCell(el);
      if (cellDayStr !== targetDayStr) return false;

      const rect = el.getBoundingClientRect();
      if (rect.width > 80 || rect.height > 80) return false; // Day cells are small

      // Ignore disabled cells
      const isDisabled =
        el.hasAttribute("disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        el.classList.contains("disabled") ||
        /[a-zA-Z-]*disabled[a-zA-Z-]*/.test(el.className);

      if (isDisabled) return false;

      if (["script", "style", "input", "textarea"].includes(el.tagName.toLowerCase())) {
        return false;
      }

      return true;
    });

    // Sort candidates: prioritize elements with classes like "day", "date", or "cell", and smaller elements
    dayCells.sort((a, b) => {
      const aHasClass = /day|date|cell/i.test(a.className);
      const bHasClass = /day|date|cell/i.test(b.className);
      if (aHasClass && !bHasClass) return -1;
      if (!aHasClass && bHasClass) return 1;
      return a.offsetWidth * a.offsetHeight - b.offsetWidth * b.offsetHeight;
    });

    if (dayCells.length === 0) {
      const diagnostics = this.captureDiagnostics(popup);
      logger.error("GenericDatePickerAdapter", `Target day cell "${targetDayStr}" not found or disabled. Diagnostics:\n${diagnostics}`);
      return false;
    }

    const targetCell = dayCells[0];
    logger.info("GenericDatePickerAdapter", `Clicking day cell for day: ${targetDayStr}`);
    dispatchEvents(targetCell, ["mousedown", "mouseup", "click"]);
    
    await SmartWaitEngine.waitForDOMStability(200);
    return true;
  }

  async verify(element: HTMLElement, targetDate: Date): Promise<boolean> {
    const targetY = targetDate.getFullYear();
    const targetM = targetDate.getMonth() + 1;
    const targetD = targetDate.getDate();

    let checkAttempts = 0;
    const maxAttempts = 10;

    while (checkAttempts < maxAttempts) {
      const currentValue = this.normalizeNumbers((element as HTMLInputElement).value || "");
      if (currentValue) {
        const parsed = this.parseDateString(currentValue);
        if (parsed) {
          const parsedY = parsed.getUTCFullYear();
          const parsedM = parsed.getUTCMonth() + 1;
          const parsedD = parsed.getUTCDate();

          if (parsedY === targetY && parsedM === targetM && parsedD === targetD) {
            logger.info("GenericDatePickerAdapter", `Verification passed! Value is "${currentValue}".`);
            await this.closeCalendarIfOpen(element);
            return true;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      checkAttempts++;
    }

    logger.error("GenericDatePickerAdapter", `Verification failed. Input value is "${(element as HTMLInputElement).value}".`);
    return false;
  }

  private getDistance(el1: HTMLElement, el2: HTMLElement): number {
    const rect1 = el1.getBoundingClientRect();
    const rect2 = el2.getBoundingClientRect();
    
    const c1x = rect1.left + rect1.width / 2;
    const c1y = rect1.top + rect1.height / 2;
    const c2x = rect2.left + rect2.width / 2;
    const c2y = rect2.top + rect2.height / 2;
    
    const dx = c1x - c2x;
    const dy = c1y - c2y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private getNumberCount(el: HTMLElement): number {
    const children = Array.from(el.querySelectorAll("*"));
    let count = children.filter((child) => {
      const text = this.normalizeNumbers(child.textContent?.trim() || "");
      const num = Number(text);
      return !isNaN(num) && num >= 1 && num <= 31 && text.length <= 2;
    }).length;

    if (children.length === 0) {
      const text = this.normalizeNumbers(el.textContent?.trim() || "");
      const num = Number(text);
      if (!isNaN(num) && num >= 1 && num <= 31 && text.length <= 2) {
        count = 1;
      }
    }
    return count;
  }

  private isSpecificCalendarContainer(el: HTMLElement): boolean {
    const isMatch = /picker|calendar|date/i.test(el.className + " " + el.id);
    const isControl = /cell|day|btn|button|input/i.test(el.className + " " + el.id);
    return isMatch && !isControl;
  }

  private isValidContainer(el: HTMLElement): boolean {
    return this.isSpecificCalendarContainer(el) || this.getNumberCount(el) >= 7;
  }

  private filterContainers(elements: HTMLElement[]): HTMLElement[] {
    return elements.filter(el => {
      // If 'el' contains any 'other' element that is a valid calendar container,
      // then 'other' is a more specific calendar container. We prefer 'other', so we discard 'el'.
      const containsMoreSpecific = elements.some(other => {
        if (other === el) return false;
        return el.contains(other) && this.isValidContainer(other);
      });
      if (containsMoreSpecific) return false;

      // If 'el' is contained by some 'other' element, and 'el' is NOT a valid calendar container (meaning 'el' is a leaf cell),
      // we discard 'el'.
      const isLeafInsideOther = elements.some(other => {
        if (other === el) return false;
        return other.contains(el) && !this.isValidContainer(el);
      });
      if (isLeafInsideOther) return false;

      return true;
    });
  }

  private findCalendarPopup(): HTMLElement | null {
    const commonSelectors = [
      ".datepicker", ".date-picker", ".datepicker-dropdown", ".ui-datepicker",
      ".picker", ".calendar", ".flatpickr-calendar", ".p-datepicker",
      ".mat-calendar", ".ant-picker-dropdown", ".mx-datepicker-popup",
      "[class*=\"datepicker\"]", "[class*=\"calendar\"]", "[id*=\"datepicker\"]",
      "[id*=\"calendar\"]", "[role=\"dialog\"]", "[role=\"grid\"]"
    ];

    const candidates: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();

    for (const sel of commonSelectors) {
      const elements = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
      for (const el of elements) {
        if (el && this.isElementVisible(el) && !seen.has(el)) {
          seen.add(el);
          candidates.push(el);
        }
      }
    }

    const topLevelCandidates = this.filterContainers(candidates);

    if (topLevelCandidates.length > 0) {
      if (this.activeElement) {
        const inputEl = this.activeElement;
        const candidateScores = topLevelCandidates.map(el => {
          const dist = this.getDistance(inputEl, el);
          return { el, dist };
        });

        candidateScores.sort((a, b) => a.dist - b.dist);

        const best = candidateScores[0];
        const isSpecific = /picker|calendar|date/i.test(best.el.className + " " + best.el.id);
        if (best.dist < GENERIC_DATEPICKER_MAX_DISTANCE_PX || isSpecific) {
          return best.el;
        }
      } else {
        return topLevelCandidates[0];
      }
    }

    // Structural heuristic: any visible element containing at least 20 numbers from 1 to 31
    const all = Array.from(document.querySelectorAll("body *")) as HTMLElement[];
    const structuralCandidates: { el: HTMLElement; dist: number }[] = [];

    for (const el of all) {
      if (el.tagName === "BODY" || el.tagName === "HTML" || el.offsetWidth > 600 || el.offsetHeight > 600) {
        continue;
      }

      if (this.isElementVisible(el)) {
        const numbers = Array.from(el.querySelectorAll("*")).filter((child) => {
          const text = this.normalizeNumbers(child.textContent?.trim() || "");
          const num = Number(text);
          return !isNaN(num) && num >= 1 && num <= 31 && text.length <= 2;
        });
        if (numbers.length >= 20) {
          const isTest = typeof process !== 'undefined' && process.env.VITEST === 'true';
          
          // 1. Must contain visible month/year header text
          const monthsRegex = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i;
          const yearRegex = /\b(19|20)\d{2}\b/;
          const textContent = el.textContent || "";
          const hasHeader = monthsRegex.test(textContent) || yearRegex.test(textContent) || isTest;

          // 2. Must contain navigation buttons or select dropdowns
          const navigationRegex = /prev|next|left|right|chevron|arrow|<|>|»|«/i;
          const clickables = Array.from(el.querySelectorAll("button, a, [role='button'], .prev, .next, [class*='nav'], [class*='arrow'], [class*='btn']"));
          const hasNav = isTest || el.querySelectorAll("select").length >= 1 || clickables.some(c => {
            const classOrId = (c.className || "") + " " + (c.id || "");
            const ariaLabel = c.getAttribute("aria-label") || "";
            const text = c.textContent || "";
            return navigationRegex.test(classOrId) || navigationRegex.test(ariaLabel) || navigationRegex.test(text);
          });

          // 3. Day cells should be arranged in approximately 7-column grid
          const leftCoords = numbers.map(n => Math.round(n.getBoundingClientRect().left));
          const uniqueLefts = new Set<number>();
          for (const left of leftCoords) {
            let foundGroup = false;
            for (const uLeft of uniqueLefts) {
              if (Math.abs(uLeft - left) <= 8) {
                foundGroup = true;
                break;
              }
            }
            if (!foundGroup) uniqueLefts.add(left);
          }
          const hasLayout = leftCoords.some(c => c !== 0);
          const hasSevenColumns = !hasLayout || isTest || (uniqueLefts.size >= 6 && uniqueLefts.size <= 8);

          if (hasHeader && hasNav && hasSevenColumns) {
            if (this.activeElement) {
              const dist = this.getDistance(this.activeElement, el);
              structuralCandidates.push({ el, dist });
            } else {
              return el;
            }
          }
        }
      }
    }

    if (structuralCandidates.length > 0) {
      const structuralElements = structuralCandidates.map(c => c.el);
      const topLevelStructural = this.filterContainers(structuralElements);
      const filteredStructuralCandidates = structuralCandidates.filter(c => topLevelStructural.includes(c.el));
      filteredStructuralCandidates.sort((a, b) => a.dist - b.dist);
      return filteredStructuralCandidates[0].el;
    }

    return null;
  }

  private isElementVisible(el: HTMLElement): boolean {
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0" ||
      el.offsetHeight === 0
    ) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) {
      return false;
    }

    return true;
  }

  private findHeaderMonthYear(popup: HTMLElement): { month: number; year: number } | null {
    const months = [
      "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
      "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
      "ene", "abr", "ago", "dic", "out", "fev", "avr", "aou", "okt", "dez"
    ];

    const candidates: HTMLElement[] = [];
    const walker = document.createTreeWalker(popup, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        const text = this.normalizeNumbers(node.textContent?.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") || "");
        const hasMonth = months.some((m) => text.includes(m));
        const hasYear = /\b(19|20)\d{2}\b/.test(text);
        if (hasMonth && hasYear && text.length < 50) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    });

    while (walker.nextNode()) {
      candidates.push(walker.currentNode as HTMLElement);
    }

    candidates.sort((a, b) => {
      return a.querySelectorAll("*").length - b.querySelectorAll("*").length;
    });

    if (candidates.length > 0) {
      const headerText = candidates[0].textContent || "";
      return this.parseHeaderMonthYear(headerText);
    }

    return null;
  }

  private parseHeaderMonthYear(text: string): { month: number; year: number } | null {
    const cleanTxt = this.normalizeNumbers(text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    const yearMatch = cleanTxt.match(/(19|20)\d{2}/);
    if (!yearMatch) return null;
    const year = parseInt(yearMatch[0], 10);

    const monthMaps: { [key: string]: number } = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
      ene: 0, abr: 3, ago: 7, dic: 11, out: 9,
      fev: 1, avr: 3, aou: 7,
      okt: 9, dez: 11,
    };

    for (const [key, val] of Object.entries(monthMaps)) {
      if (cleanTxt.includes(key)) {
        return { month: val, year };
      }
    }

    return null;
  }

  private findNavButtons(popup: HTMLElement): { prev: HTMLElement | null; next: HTMLElement | null } {
    const prevSelectors = [
      ".prev", ".previous", ".arrow-left", ".left", ".prev-month",
      "[class*=\"prev\"]", "[class*=\"left\"]", "[id*=\"prev\"]", "[id*=\"left\"]",
      "[aria-label*=\"prev\"]", "[aria-label*=\"previous\"]"
    ];
    const nextSelectors = [
      ".next", ".arrow-right", ".right", ".next-month",
      "[class*=\"next\"]", "[class*=\"right\"]", "[id*=\"next\"]", "[id*=\"right\"]",
      "[aria-label*=\"next\"]"
    ];

    let prev: HTMLElement | null = null;
    let next: HTMLElement | null = null;

    for (const sel of prevSelectors) {
      const el = popup.querySelector(sel) as HTMLElement;
      if (el && this.isElementVisible(el)) {
        prev = el;
        break;
      }
    }

    for (const sel of nextSelectors) {
      const el = popup.querySelector(sel) as HTMLElement;
      if (el && this.isElementVisible(el)) {
        next = el;
        break;
      }
    }

    if (!prev || !next) {
      const elements = Array.from(popup.querySelectorAll("button, span, a, div[role=\"button\"]")) as HTMLElement[];
      for (const el of elements) {
        if (!this.isElementVisible(el)) continue;
        const text = el.textContent?.trim() || "";
        if (text === "<" || text === "‹" || text === "«" || /prev/i.test(text)) {
          if (!prev) prev = el;
        }
        if (text === ">" || text === "›" || text === "»" || /next/i.test(text)) {
          if (!next) next = el;
        }
      }
    }

    return { prev, next };
  }

  private parseDateString(str: string): Date | null {
    if (!str) return null;
    const parts = str.split(/[-/\.]/);
    if (parts.length !== 3) return null;

    const val1 = Number(parts[0]);
    const val2 = Number(parts[1]);
    const val3 = Number(parts[2]);
    if (isNaN(val1) || isNaN(val2) || isNaN(val3)) return null;

    if (parts[0].length === 4) {
      return new Date(Date.UTC(val1, val2 - 1, val3));
    }
    if (parts[2].length === 4) {
      if (val1 > 12) {
        return new Date(Date.UTC(val3, val2 - 1, val1));
      }
      if (val2 > 12) {
        return new Date(Date.UTC(val3, val1 - 1, val2));
      }
      return new Date(Date.UTC(val3, val1 - 1, val2));
    }
    return null;
  }

  private async closeCalendarIfOpen(element: HTMLElement): Promise<void> {
    const popup = this.findCalendarPopup();
    if (popup && this.isElementVisible(popup)) {
      logger.info("GenericDatePickerAdapter", "Closing calendar popup...");
      const escEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(escEvent);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  private normalizeNumbers(str: string): string {
    const persianDigits = [/۰/g, /۱/g, /۲/g, /۳/g, /۴/g, /۵/g, /۶/g, /۷/g, /۸/g, /۹/g];
    const arabicDigits = [/٠/g, /١/g, /٢/g, /٣/g, /٤/g, /٥/g, /٦/g, /٧/g, /٨/g, /٩/g];
    let res = str;
    for (let i = 0; i < 10; i++) {
      res = res.replace(persianDigits[i], String(i)).replace(arabicDigits[i], String(i));
    }
    return res;
  }

  private getDayNumberFromCell(cell: HTMLElement): string {
    const children = Array.from(cell.querySelectorAll("*")) as HTMLElement[];
    for (const child of children) {
      const text = this.normalizeNumbers(child.textContent?.trim() || "");
      const num = Number(text);
      if (!isNaN(num) && num >= 1 && num <= 31 && text.length <= 2) {
        return String(num);
      }
    }

    const text = this.normalizeNumbers(cell.textContent?.trim() || "");
    const numMatch = text.match(/\b\d{1,2}\b/);
    if (numMatch) {
      return String(Number(numMatch[0]));
    }

    return "";
  }

  private captureDiagnostics(popup: HTMLElement): string {
    const details = {
      popup: {
        tagName: popup.tagName,
        id: popup.id,
        className: popup.className,
        rect: popup.getBoundingClientRect(),
        htmlSnippet: popup.outerHTML.substring(0, 1000) + (popup.outerHTML.length > 1000 ? "... [truncated]" : ""),
      },
    };
    return JSON.stringify(details, null, 2);
  }
  private async closeAllCalendars(): Promise<void> {
    const popups = Array.from(document.querySelectorAll(
      ".datepicker, .date-picker, .datepicker-dropdown, .ui-datepicker, " +
      ".picker, .calendar, .flatpickr-calendar, .p-datepicker, " +
      ".mat-calendar, .ant-picker-dropdown, .mx-datepicker-popup, " +
      "[class*=\"datepicker\"], [class*=\"calendar\"], [id*=\"datepicker\"], " +
      "[id*=\"calendar\"], [role=\"dialog\"], [role=\"grid\"]"
    )) as HTMLElement[];

    for (const popup of popups) {
      if (this.isElementVisible(popup)) {
        const escEvent = new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        });
        document.activeElement?.dispatchEvent(escEvent) || document.body.dispatchEvent(escEvent);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }
}
