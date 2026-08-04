import { DatePickerRegistry } from "./DatePickerRegistry";
import { DatePickerAdapter } from "./DatePickerAdapter";

export interface FieldDetectionResult {
  isNativeDate: boolean;
  isCustomDatePicker: boolean;
  adapter: DatePickerAdapter | null;
  minDate: string | null;
  maxDate: string | null;
  score: number;
}

export class FieldDetector {
  /**
   * Evaluates an HTML element using weighted signal scoring to detect date input types.
   */
  static detect(el: HTMLElement): FieldDetectionResult {
    // Guard: FieldDetector only inspects actual form field elements.
    // Container elements (forms, divs, buttons, spans, etc.) must not inherit
    // their children's date-field scores via querySelector("input").
    if (
      !(el instanceof HTMLInputElement) &&
      !(el instanceof HTMLTextAreaElement) &&
      !(el instanceof HTMLSelectElement)
    ) {
      return { isNativeDate: false, isCustomDatePicker: false, adapter: null, minDate: null, maxDate: null, score: 0 };
    }

    let score = 0;
    // el is guaranteed to be an input/textarea/select element at this point
    const targetInput = el as HTMLInputElement;

    // 1. Native Date Input Check
    const isNativeDate = targetInput.type === "date";
    if (isNativeDate) {
      score += 100;
    }

    // 2. DatePickerRegistry Adapter Matching
    const registeredAdapter = DatePickerRegistry.detect(el);
    if (registeredAdapter) {
      score += 50;
    }

    // 3. Ancestor Tree & CSS Class Signal Scoring
    const antDPicker = el.closest(".ant-picker-input, .ant-picker, .ant-picker-dropdown, .ant-picker-panel, .ant-picker-date-panel, .ant-picker-body, .ant-picker-cell") !== null;
    if (antDPicker) score += 30;

    const rmdpPicker = el.closest(".rmdp-container, .rmdp-wrapper, .rmdp-calendar, .rmdp-ep, .react-multi-date-picker") !== null;
    if (rmdpPicker) score += 30;

    const muiPicker = el.closest(".MuiPickersPopper-root, .MuiDatePicker-root, .MuiDateField-root, .MuiPickersLayout-root") !== null;
    if (muiPicker) score += 30;

    const genericPickerWrapper = el.closest(".flatpickr-wrapper, .flatpickr-calendar, .datepicker, .datepicker-container, .date-picker, .ui-datepicker, .react-datepicker-popper, [class*='datepicker'], [class*='calendar']") !== null;
    if (genericPickerWrapper) score += 25;

    // 4. ARIA Attributes
    const ariaHasPopup = el.getAttribute("aria-haspopup") || (targetInput ? targetInput.getAttribute("aria-haspopup") : null);
    if (ariaHasPopup === "grid" || ariaHasPopup === "dialog" || ariaHasPopup === "true") {
      score += 20;
    }

    // 5. Readonly Attribute in Picker Container
    const isReadonly = targetInput.hasAttribute("readonly");
    if (isReadonly && (antDPicker || rmdpPicker || muiPicker || genericPickerWrapper || registeredAdapter)) {
      score += 10;
    }

    // 6. Placeholder Text Clues
    const placeholder = (targetInput.getAttribute("placeholder") || "").toLowerCase();
    if (placeholder.includes("select date") || placeholder.includes("dd/mm") || placeholder.includes("yyyy") || placeholder.includes("date")) {
      score += 10;
    }

    // Extract HTML min and max date attributes if present
    const minDate = targetInput.getAttribute("min");
    const maxDate = targetInput.getAttribute("max");

    // EXPLICIT GUARD: Exclude Select dropdown components (e.g. AntD Select, MUI Select, Native Select)
    const isSelectDropdown = el.closest(".ant-select, .MuiSelect-root, .ant-select-dropdown, .MuiMenu-paper, select") !== null && !antDPicker;
    if (isSelectDropdown) {
      score = 0;
    }

    const isCustomDatePicker = !isNativeDate && !isSelectDropdown && (score >= 25 || registeredAdapter !== null);

    return {
      isNativeDate,
      isCustomDatePicker,
      adapter: registeredAdapter,
      minDate,
      maxDate,
      score,
    };
  }
}
