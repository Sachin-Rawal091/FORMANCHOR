import { DatePickerAdapter } from "../DatePickerAdapter";
import { dispatchEvents } from "../../domUtils";
import { SmartWaitEngine } from "../../engines/SmartWaitEngine";
import { logger } from "../../../utils/logger";
import {
  DATEPICKER_CALENDAR_OPEN_TIMEOUT,
  DATEPICKER_NAV_STEP_TIMEOUT,
  DATEPICKER_VALUE_SETTLE_TIMEOUT,
} from "../../../shared/constants";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

export class AntDAdapter implements DatePickerAdapter {
  readonly name = "AntDAdapter";

  matches(element: HTMLElement): boolean {
    return (
      element.classList.contains("ant-picker-input") ||
      element.closest(".ant-picker-input, .ant-picker") !== null
    );
  }

  async open(element: HTMLElement): Promise<boolean> {
    logger.info("AntDAdapter", "Attempting to open AntD DatePicker...");
    element.focus();
    dispatchEvents(element, ["focus", "focusin", "mousedown", "mouseup", "click"]);

    // If there is an ant-picker container, click it as well
    const container = element.closest(".ant-picker") as HTMLElement;
    if (container) {
      dispatchEvents(container, ["click"]);
    }

    const popup = await SmartWaitEngine.waitForCondition(
      () => this.findPopup(),
      DATEPICKER_CALENDAR_OPEN_TIMEOUT
    ).catch(() => null);

    if (!popup) {
      logger.warn("AntDAdapter", "AntD calendar popup did not open.");
      return false;
    }

    logger.debug("AntDAdapter", "AntD popup opened successfully.");
    return true;
  }

  async navigateToMonth(targetDate: Date): Promise<boolean> {
    const popup = this.findPopup();
    if (!popup) {
      logger.error("AntDAdapter", "AntD calendar popup not found for month navigation.");
      return false;
    }

    const targetMonth = targetDate.getMonth();
    const targetYear = targetDate.getFullYear();

    // 1. Try AntD Year View direct panel jump if year difference is >= 5
    const headerView = popup.querySelector(".ant-picker-header-view") as HTMLElement;
    if (headerView) {
      const initialText = headerView.textContent?.trim() || "";
      const initialParsed = this.parseHeader(initialText);
      if (initialParsed && Math.abs(initialParsed.year - targetYear) >= 1) {
        const yearBtn = popup.querySelector(".ant-picker-year-btn, .ant-picker-header-view") as HTMLElement;
        if (yearBtn) {
          dispatchEvents(yearBtn, ["click"]);
          await new Promise(r => setTimeout(r, 100));

          const yearCells = Array.from(popup.querySelectorAll(".ant-picker-cell-inner")) as HTMLElement[];
          const targetCell = yearCells.find(cell => cell.textContent?.trim() === String(targetYear));
          if (targetCell) {
            dispatchEvents(targetCell, ["click"]);
            await new Promise(r => setTimeout(r, 100));
          }
        }
      }
    }

    let attempts = 0;
    const maxIterations = 200; // Calibrate limit for multi-decade gaps
    while (attempts < maxIterations) {
      const currentHeader = popup.querySelector(".ant-picker-header-view") as HTMLElement;
      if (!currentHeader) {
        logger.warn("AntDAdapter", "Could not locate .ant-picker-header-view. Proceeding directly.");
        return true;
      }

      const text = currentHeader.textContent?.trim() || "";
      const parsed = this.parseHeader(text);
      if (!parsed) {
        logger.warn("AntDAdapter", `Could not parse header text: "${text}". Proceeding directly.`);
        return true;
      }

      if (parsed.month === targetMonth && parsed.year === targetYear) {
        logger.info("AntDAdapter", `Successfully navigated to target: ${text}`);
        return true;
      }

      // Check if we need to click prev or next month button
      const prevBtn = popup.querySelector(".ant-picker-header-prev-btn") as HTMLElement;
      const nextBtn = popup.querySelector(".ant-picker-header-next-btn") as HTMLElement;
      const superPrevBtn = popup.querySelector(".ant-picker-header-super-prev-btn") as HTMLElement;
      const superNextBtn = popup.querySelector(".ant-picker-header-super-next-btn") as HTMLElement;

      let isNext = false;
      let useSuper = false;
      const yearDiff = Math.abs(parsed.year - targetYear);

      if (parsed.year < targetYear) {
        isNext = true;
        if (yearDiff >= 1 && superNextBtn) useSuper = true;
      } else if (parsed.year > targetYear) {
        isNext = false;
        if (yearDiff >= 1 && superPrevBtn) useSuper = true;
      } else {
        isNext = parsed.month < targetMonth;
      }

      const clickTarget = useSuper ? (isNext ? superNextBtn : superPrevBtn) : (isNext ? nextBtn : prevBtn);
      if (!clickTarget) {
        logger.warn("AntDAdapter", "Prev/Next month buttons not found in AntD header.");
        return true;
      }

      const oldText = text;
      dispatchEvents(clickTarget, ["click"]);
      
      await SmartWaitEngine.waitForCondition(() => {
        const currentText = currentHeader.textContent?.trim() || "";
        return currentText !== oldText ? true : null;
      }, DATEPICKER_NAV_STEP_TIMEOUT).catch(() => null);
      attempts++;
    }

    logger.error("AntDAdapter", `Failed to navigate to month within ${maxIterations} steps.`);
    return false;
  }

  async selectDay(targetDate: Date): Promise<boolean> {
    const popup = this.findPopup();
    if (!popup) {
      logger.error("AntDAdapter", "AntD calendar popup not found for day selection.");
      return false;
    }

    const targetDayStr = String(targetDate.getDate());
    
    // AntD uses .ant-picker-cell for rows/cells, and .ant-picker-cell-inner contains day number
    const cellInners = Array.from(popup.querySelectorAll(".ant-picker-cell-inner")) as HTMLElement[];

    const matchingInner = cellInners.find((inner) => {
      const cell = inner.closest(".ant-picker-cell") as HTMLElement;
      if (cell) {
        // Ignore disabled cells and cells from previous/next month (ant-picker-cell-in-view is usually true for current month)
        if (
          cell.classList.contains("ant-picker-cell-disabled") ||
          !cell.classList.contains("ant-picker-cell-in-view")
        ) {
          return false;
        }
      }
      return inner.textContent?.trim() === targetDayStr;
    });

    if (!matchingInner) {
      logger.error("AntDAdapter", `Day cell for day ${targetDayStr} not found or disabled.`);
      return false;
    }

    logger.info("AntDAdapter", `Clicking day cell: ${targetDayStr}`);
    const parentCell = matchingInner.closest(".ant-picker-cell") as HTMLElement || matchingInner;
    dispatchEvents(parentCell, ["mousedown", "mouseup", "click"]);
    dispatchEvents(matchingInner, ["mousedown", "mouseup", "click"]);
    return true;
  }

  async verify(element: HTMLElement, _targetDate: Date): Promise<boolean> {
    const inputEl = (element instanceof HTMLInputElement ? element : element.querySelector("input")) as HTMLInputElement | null;
    const targetInput = inputEl || (element as HTMLInputElement);

    // Wait for the input value to settle
    const valueSet = await SmartWaitEngine.waitForCondition(() => {
      return targetInput.value.trim() ? true : null;
    }, DATEPICKER_VALUE_SETTLE_TIMEOUT).catch(() => null);

    if (!valueSet) {
      logger.error("AntDAdapter", `Input value did not settle. Value: "${targetInput.value}"`);
      return false;
    }

    // Force AntD Form.Item to register change and sync Form.useForm validation state
    dispatchEvents(targetInput, ["input", "change", "blur", "focusout"]);

    // Adapter-owned cleanup: Dismiss AntD dropdown overlay if still open in DOM
    try {
      targetInput.blur();
      dispatchEvents(targetInput, ["blur", "focusout"]);

      const escEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      });
      targetInput.dispatchEvent(escEvent);
      document.body.dispatchEvent(escEvent);

      const popup = this.findPopup();
      if (popup && !popup.classList.contains("ant-picker-dropdown-hidden")) {
        dispatchEvents(document.body, ["mousedown", "mouseup", "click"]);
      }
    } catch (e) {
      logger.debug("AntDAdapter", "AntD popup dismissal error (ignored)", e);
    }

    logger.info("AntDAdapter", `AntD date successfully verified: "${targetInput.value}"`);
    return true;
  }

  private findPopup(): HTMLElement | null {
    const popupSelectors = [
      ".ant-picker-dropdown",
      "[class*='ant-picker-dropdown']"
    ];
    for (const sel of popupSelectors) {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) return el;
    }
    return null;
  }

  private parseHeader(text: string): { month: number; year: number } | null {
    // AntD text might be "Aug2026", "July 2026", "2026-07", or "2026年7月"
    // Insert spaces between letters and numbers if stuck together (e.g. "Aug2026" -> "Aug 2026")
    const normalizedText = text
      .replace(/([a-zA-Z]+)(\d+)/g, "$1 $2")
      .replace(/(\d+)([a-zA-Z]+)/g, "$1 $2");

    // Parse 4-digit year:
    const yearMatch = normalizedText.match(/(19|20)\d{2}/);
    if (!yearMatch) return null;
    const year = parseInt(yearMatch[0], 10);

    // Find month index:
    const cleaned = normalizedText.toLowerCase();
    for (let i = 0; i < MONTH_NAMES.length; i++) {
      if (cleaned.includes(MONTH_NAMES[i].toLowerCase())) {
        return { month: i % 12, year };
      }
    }

    // Try finding month numbers (e.g. "2026-07" or "2026年7月")
    const numbers = cleaned.replace(String(year), "").match(/\b\d{1,2}\b/);
    if (numbers) {
      const monthNum = parseInt(numbers[0], 10);
      if (monthNum >= 1 && monthNum <= 12) {
        return { month: monthNum - 1, year };
      }
    }

    // Try finding month chinese characters like "7月"
    const zhMatch = cleaned.match(/(\d{1,2})月/);
    if (zhMatch) {
      const monthNum = parseInt(zhMatch[1], 10);
      if (monthNum >= 1 && monthNum <= 12) {
        return { month: monthNum - 1, year };
      }
    }

    return null;
  }
}
