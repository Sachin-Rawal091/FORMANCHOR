import { DatePickerAdapter } from "../DatePickerAdapter";
import { dispatchEvents } from "../../domUtils";
import { SmartWaitEngine } from "../../engines/SmartWaitEngine";
import { logger } from "../../../utils/logger";
import {
  DATEPICKER_CALENDAR_OPEN_TIMEOUT,
  DATEPICKER_NAV_STEP_TIMEOUT,
  DATEPICKER_NAV_MAX_ITERATIONS,
  DATEPICKER_VALUE_SETTLE_TIMEOUT,
} from "../../../shared/constants";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export class MuiAdapter implements DatePickerAdapter {
  readonly name = "MuiAdapter";

  matches(element: HTMLElement): boolean {
    if (!(element instanceof HTMLInputElement)) return false;
    return (
      element.classList.contains("MuiInputBase-input") ||
      element.closest(".MuiFormControl-root, .MuiTextField-root") !== null ||
      /mui/i.test(element.className || "")
    );
  }

  async open(element: HTMLElement): Promise<boolean> {
    logger.info("MuiAdapter", "Attempting to open MUI DatePicker...");
    element.focus();
    dispatchEvents(element, ["focus", "focusin", "mousedown", "mouseup", "click"]);

    // If input has a calendar icon button next to it (common in MUI), click it to be sure
    const parent = element.closest(".MuiInputBase-root");
    if (parent) {
      const iconButton = parent.querySelector("button") as HTMLElement;
      if (iconButton) {
        dispatchEvents(iconButton, ["click"]);
      }
    }

    const popup = await SmartWaitEngine.waitForCondition(
      () => this.findPopup(),
      DATEPICKER_CALENDAR_OPEN_TIMEOUT
    ).catch(() => null);

    if (!popup) {
      logger.warn("MuiAdapter", "MUI calendar popup did not open.");
      return false;
    }

    logger.debug("MuiAdapter", "MUI popup opened successfully.");
    return true;
  }

  async navigateToMonth(targetDate: Date): Promise<boolean> {
    const popup = this.findPopup();
    if (!popup) {
      logger.error("MuiAdapter", "MUI calendar popup not found for month navigation.");
      return false;
    }

    const targetMonth = targetDate.getMonth();
    const targetYear = targetDate.getFullYear();

    // 1. Try Year View Direct Jump if year difference is >= 1
    const initialHeader = this.readHeader(popup);
    if (initialHeader) {
      const initialCurrent = this.parseHeader(initialHeader);
      if (initialCurrent && Math.abs(initialCurrent.year - targetYear) >= 1) {
        const yearViewHeader = popup.querySelector(".MuiPickersCalendarHeader-label, .MuiPickersCalendarHeader-switchViewButton") as HTMLElement;
        if (yearViewHeader) {
          logger.info("MuiAdapter", `Attempting Year View direct jump to ${targetYear}...`);
          dispatchEvents(yearViewHeader, ["click"]);
          await new Promise(r => setTimeout(r, 100));

          const yearButtons = Array.from(popup.querySelectorAll(".MuiYearCalendar-root button, .MuiPickersYear-root button, [class*='Year'] button, button")) as HTMLElement[];
          const targetYearBtn = yearButtons.find(btn => btn.textContent?.trim() === String(targetYear));
          if (targetYearBtn) {
            dispatchEvents(targetYearBtn, ["click"]);
            await new Promise(r => setTimeout(r, 100));
            logger.info("MuiAdapter", `Year View direct jump to ${targetYear} succeeded.`);
          }
        }
      }
    }

    let attempts = 0;
    while (attempts < DATEPICKER_NAV_MAX_ITERATIONS) {
      const headerText = this.readHeader(popup);
      if (!headerText) {
        logger.warn("MuiAdapter", "Could not read month/year header. Proceeding directly.");
        return true;
      }

      const current = this.parseHeader(headerText);
      if (!current) {
        logger.warn("MuiAdapter", `Could not parse header text: "${headerText}". Proceeding directly.`);
        return true;
      }

      if (current.month === targetMonth && current.year === targetYear) {
        logger.info("MuiAdapter", `Successfully navigated to target: ${headerText}`);
        return true;
      }

      // Find navigation buttons
      const buttons = Array.from(popup.querySelectorAll(".MuiPickersArrowSwitcher-button")) as HTMLElement[];
      if (buttons.length < 2) {
        logger.warn("MuiAdapter", "Prev/Next navigation buttons not found in header switcher.");
        return true;
      }

      const prevBtn = buttons[0];
      const nextBtn = buttons[1];

      let isNext = false;
      if (current.year < targetYear) {
        isNext = true;
      } else if (current.year > targetYear) {
        isNext = false;
      } else {
        isNext = current.month < targetMonth;
      }

      const clickTarget = isNext ? nextBtn : prevBtn;
      const oldText = headerText;
      dispatchEvents(clickTarget, ["click"]);
      
      await SmartWaitEngine.waitForCondition(() => {
        const currentText = this.readHeader(popup);
        return currentText !== oldText ? true : null;
      }, DATEPICKER_NAV_STEP_TIMEOUT).catch(() => null);
      attempts++;
    }

    logger.error("MuiAdapter", `Failed to navigate to month within ${DATEPICKER_NAV_MAX_ITERATIONS} steps.`);
    return false;
  }

  async selectDay(targetDate: Date): Promise<boolean> {
    const popup = this.findPopup();
    if (!popup) {
      logger.error("MuiAdapter", "MUI calendar popup not found for day selection.");
      return false;
    }

    const targetDayStr = String(targetDate.getDate());
    const dayCells = Array.from(popup.querySelectorAll(".MuiPickersDay-root, .MuiPickersDay-dayWithMargin")) as HTMLElement[];

    const matchingCell = dayCells.find((cell) => {
      // Ignore hidden or disabled days
      if (cell.classList.contains("Mui-disabled") || cell.getAttribute("aria-disabled") === "true") {
        return false;
      }
      return cell.textContent?.trim() === targetDayStr;
    });

    if (!matchingCell) {
      logger.error("MuiAdapter", `Day cell for day ${targetDayStr} not found or disabled.`);
      return false;
    }

    logger.info("MuiAdapter", `Clicking day cell: ${targetDayStr}`);
    dispatchEvents(matchingCell, ["mousedown", "mouseup", "click"]);
    return true;
  }

  async verify(element: HTMLElement, _targetDate: Date): Promise<boolean> {
    const inputEl = element as HTMLInputElement;

    // Wait for the input value to settle
    const valueSet = await SmartWaitEngine.waitForCondition(() => {
      return inputEl.value.trim() ? true : null;
    }, DATEPICKER_VALUE_SETTLE_TIMEOUT).catch(() => null);

    if (!valueSet) {
      logger.warn("MuiAdapter", `Input value did not settle. Value: "${inputEl.value}"`);
    }

    try {
      element.blur();
      dispatchEvents(element, ["blur", "focusout"]);
      const escEvent = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true });
      element.dispatchEvent(escEvent);
      document.body.dispatchEvent(escEvent);
    } catch (e) {
      logger.debug("MuiAdapter", "MUI popup dismissal error (ignored)", e);
    }

    logger.info("MuiAdapter", `MUI date successfully verified: "${inputEl.value}"`);
    return true;
  }

  private findPopup(): HTMLElement | null {
    // MUI DatePicker popups classes
    const popupSelectors = [
      ".MuiPickersPopper-root",
      ".MuiDateCalendar-root",
      ".MuiPickersLayout-root",
      ".MuiPickersFadeTransitionGroup-root",
      "[class*='MuiPickersPopper']",
      "[class*='MuiDateCalendar']"
    ];
    for (const sel of popupSelectors) {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) return el;
    }
    return null;
  }

  private readHeader(popup: HTMLElement): string | null {
    const header = popup.querySelector(".MuiPickersCalendarHeader-label") as HTMLElement;
    return header ? header.textContent?.trim() || null : null;
  }

  private parseHeader(text: string): { month: number; year: number } | null {
    // e.g. "July 2026"
    const cleaned = text.replace(/\u200e/g, "").trim(); // Remove left-to-right marks if any
    const parts = cleaned.split(/\s+/);
    if (parts.length < 2) return null;

    const monthStr = parts[0];
    const year = parseInt(parts[1], 10);
    if (isNaN(year)) return null;

    const month = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(monthStr.toLowerCase()));
    if (month === -1) return null;

    return { month, year };
  }
}
