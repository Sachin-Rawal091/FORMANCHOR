import { Step, Action, LogStatus, SelectorResult } from "../../types";
import { setInputValue, setSelectValue, setCheckboxValue, dispatchEvents } from "../domUtils";
import { SmartWaitEngine } from "./SmartWaitEngine";
import { WAIT_DOM_STABLE_TIMEOUT, WAIT_URL_CHANGE_TIMEOUT, CLOSE_DISMISS_REGEX, SUBMIT_KEYWORD_REGEX } from "../../shared/constants";
import { StorageManager } from "../../storage/StorageManager";
import { logger } from "../../utils/logger";
import { sanitizeTextValue } from "../../utils/sanitize";
import { DatePickerEngine } from "../datepickers/DatePickerEngine";
import { DatePickerRegistry } from "../datepickers/DatePickerRegistry";
import { InputNormalizer } from "../datepickers/InputNormalizer";
import { FieldDetector } from "../datepickers/FieldDetector";
import { StrategyResolver } from "../datepickers/StrategyResolver";

// Exposed so tests can disable the real-world settle/verification wait without
// ExecutionEngine needing to know it's running under a test runner. Defaults to
// enabled; test setup (e.g. a global beforeEach) can flip this off explicitly.
export let ENABLE_ACTION_SETTLE_WAIT = true;

export function disableActionSettleWait() {
  ENABLE_ACTION_SETTLE_WAIT = false;
}
export function enableActionSettleWait() {
  ENABLE_ACTION_SETTLE_WAIT = true;
}

export interface ResolvedValueResult {
  value: string | null;
  status: LogStatus;
  shouldSkipRow: boolean;
  shouldSkipStep: boolean;
}

export class ExecutionEngine {
  private static getLabelForInput(id: string | null): HTMLLabelElement | null {
    if (!id) return null;
    return document.querySelector(`label[for="${CSS.escape(id)}"]`);
  }

  /**
   * Resolves the variable from Excel row data and handles the 8 missing-value scenarios.
   */
  static resolveAndValidateValue(step: Step, rowData: Record<string, any>): ResolvedValueResult {
    if (!step.columnName) {
      // If no column mapping, just use step.value directly if present
      return {
        value: step.value ? sanitizeTextValue(step.value) : null,
        status: "FILLED",
        shouldSkipRow: false,
        shouldSkipStep: !step.value && step.skipOnEmpty ? true : false,
      };
    }

    const targetCol = step.columnName.trim().toLowerCase();
    const actualKey = Object.keys(rowData).find(k => k.trim().toLowerCase() === targetCol);
    const hasColumn = actualKey !== undefined;
    const rawValue = hasColumn ? rowData[actualKey!] : undefined;
    const isMissing = rawValue === undefined || rawValue === null || String(rawValue).trim() === "";

    // Scenarios 2 & 3: Column not found
    if (!hasColumn) {
      if (step.required) {
        return { value: null, status: "ROW_SKIPPED", shouldSkipRow: true, shouldSkipStep: true };
      }
      return { value: null, status: "STEP_SKIPPED", shouldSkipRow: false, shouldSkipStep: true };
    }

    // Scenarios 4, 5 & 6: Value empty/null
    if (isMissing) {
      if (step.action === Action.TOGGLE_CHECKBOX) {
        const defaultValue = step.defaultValue !== undefined && step.defaultValue !== null && step.defaultValue !== ""
          ? sanitizeTextValue(String(step.defaultValue))
          : (step.checked !== undefined ? String(step.checked) : "true");
        return { value: defaultValue, status: "FILLED_DEFAULT", shouldSkipRow: false, shouldSkipStep: false };
      }
      if (step.defaultValue !== undefined && step.defaultValue !== null && step.defaultValue !== "") {
        return { value: sanitizeTextValue(String(step.defaultValue)), status: "FILLED_DEFAULT", shouldSkipRow: false, shouldSkipStep: false };
      }
      if (step.required) {
        return { value: null, status: "ROW_SKIPPED", shouldSkipRow: true, shouldSkipStep: true };
      }
      return { value: null, status: "STEP_SKIPPED", shouldSkipRow: false, shouldSkipStep: true };
    }

    // Scenarios 1, 7 & 8: Type coercion
    let stringValue = String(rawValue);
    let status: LogStatus = "FILLED";

    if (step.expectedType) {
      const typeOfValue = typeof rawValue;
      if (step.expectedType === "number" && typeOfValue !== "number") {
        const coerced = Number(rawValue);
        if (!isNaN(coerced)) {
          stringValue = String(coerced);
          status = "FILLED_COERCED";
        } else {
          status = "WARN";
        }
      } else if (step.expectedType === "boolean" && typeOfValue !== "boolean") {
        const lower = stringValue.toLowerCase().trim();
        if (lower === "true" || lower === "yes" || lower === "1") {
          stringValue = "true";
          status = "FILLED_COERCED";
        } else if (lower === "false" || lower === "no" || lower === "0") {
          stringValue = "false";
          status = "FILLED_COERCED";
        } else {
          status = "WARN";
        }
      } else if (step.expectedType === "date") {
        let parsedDate: Date | null = null;
        
        // 1. Check if the value is an Excel numeric date serial
        const numValue = Number(rawValue);
        if (typeof rawValue !== 'boolean' && !isNaN(numValue) && numValue > 10000 && numValue < 100000) {
          parsedDate = parseExcelSerialDate(numValue);
        }
        
        // 2. Parse from date string or Date object
        if (!parsedDate) {
          const formatSample = step.defaultValue || step.value || '';
          parsedDate = rawValue instanceof Date ? rawValue : parseDateString(stringValue, formatSample);
        }

        if (parsedDate && !isNaN(parsedDate.getTime())) {
          // Use step.defaultValue as the format sample (reverting to step.value as fallback)
          const formatSample = step.defaultValue || step.value || '';
          stringValue = formatDate(parsedDate, formatSample);
          status = "FILLED_COERCED";
        } else {
          status = "WARN";
        }
      } else if (step.expectedType === "text" && typeOfValue !== "string") {
        status = "FILLED_COERCED"; // simple string cast happened above
      }
    }

    return { value: sanitizeTextValue(stringValue), status, shouldSkipRow: false, shouldSkipStep: false };
  }

  /**
   * Executes the DOM action for a specific step.
   * Assumes the element has already been found via SelectorEngine/SmartWaitEngine.
   */
  static async executeAction(
    step: Step,
    selectorResult: SelectorResult,
    resolvedValue: string | null
  ): Promise<void> {
    const el = selectorResult.element as HTMLElement;

    switch (step.action) {
      case Action.FILL: {
        const normalizedVal = InputNormalizer.normalize(resolvedValue);
        const detection = FieldDetector.detect(el);
        const strategy = StrategyResolver.resolve(detection);
        
        logger.info('ExecutionEngine', `Action.FILL on step ${step.id} resolved strategy "${strategy.name}" (Score: ${detection.score})`);
        const filled = await strategy.execute(el, normalizedVal, detection);
        if (!filled && normalizedVal) {
          throw new Error(`Fill attempt using ${strategy.name} failed for step ${step.id}. Element remained empty or unverified.`);
        }
        break;
      }

      case Action.CLICK: {
        const beforeClickUrl = window.location.href;
        let clickMutationObserved = false;
        
        const clickObserver = new MutationObserver(() => {
          clickMutationObserved = true;
        });
        
        clickObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });

        dispatchEvents(el, ["mousedown", "mouseup", "click"]);

        if (ENABLE_ACTION_SETTLE_WAIT && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button')) {
          const start = Date.now();
          while (Date.now() - start < 500) {
            if (window.location.href !== beforeClickUrl || clickMutationObserved) {
              break;
            }
            await new Promise(r => setTimeout(r, 50));
          }
          clickObserver.disconnect();
          
          if (window.location.href === beforeClickUrl && !clickMutationObserved) {
            throw new Error(`Click on <${el.tagName.toLowerCase()}> had no measurable effect on the page (no URL change or DOM mutations detected).`);
          }
        } else {
          clickObserver.disconnect();
          if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') {
            await new Promise(r => setTimeout(r, 300));
          }
        }
        break;
      }

      case Action.NAVIGATE_NEXT: {
        const currentURL = window.location.href;
        dispatchEvents(el, ["mousedown", "mouseup", "click"]);
        await SmartWaitEngine.waitForURLChange(currentURL, WAIT_URL_CHANGE_TIMEOUT);
        break;
      }

      case Action.SELECT:
        if (el instanceof HTMLSelectElement) {
          const matchResult = setSelectValue(el, resolvedValue || "");
          
          if (matchResult) {
            logger.info('ExecutionEngine', `Matched "${resolvedValue}" using strategy ${matchResult.strategy} (${matchResult.confidence}%) -> "${matchResult.matchedText}"`);
          }

          await SmartWaitEngine.waitForDOMStability(WAIT_DOM_STABLE_TIMEOUT).catch((err) => {
            logger.debug('ExecutionEngine', `SELECT DOM stability wait timed out: ${err.message}`);
          });
          // BUG-101: Readback verification
          if (resolvedValue && !el.value) {
            throw new Error(`Select element remained unselected after fill attempt.`);
          }
        }
        break;

      case Action.SELECT_RADIO:
        // Match radio by value attribute — scope to closest form/fieldset to avoid wrong-form matches
        const nameAttr = el.getAttribute("name");
        if (nameAttr && resolvedValue) {
          const escapedName = CSS.escape(nameAttr);
          const scope = el.closest('form, fieldset') || document;
          const radios = Array.from(scope.querySelectorAll(`input[type="radio"][name="${escapedName}"]`)) as HTMLInputElement[];
          const targetRadio = radios.find(r => {
            const valMatch = r.value.trim().toLowerCase() === resolvedValue.trim().toLowerCase();
            if (valMatch) return true;
            
            // Try matching by label text
            let labelText = "";
            if (r.id) {
              const labelEl = ExecutionEngine.getLabelForInput(r.id);
              if (labelEl) {
                labelText = labelEl.textContent || "";
              }
            }
            if (!labelText) {
              const parentLabel = r.closest('label');
              if (parentLabel) {
                labelText = parentLabel.textContent || "";
              }
            }
            return labelText.trim().toLowerCase() === resolvedValue.trim().toLowerCase();
          });
          if (targetRadio) {
            setCheckboxValue(targetRadio, true);
            // BUG-101: Readback verification
            if (!targetRadio.checked) {
              throw new Error(`Radio button failed to check.`);
            }
          } else {
            throw new Error(`Radio button matching value or label "${resolvedValue}" not found.`);
          }
        }
        break;

      case Action.TOGGLE_CHECKBOX:
        {
          let checkboxInput: HTMLInputElement | null = null;
          if (el instanceof HTMLInputElement && el.type === "checkbox") {
            checkboxInput = el;
          } else {
            // Find nested checkbox input
            checkboxInput = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
            if (!checkboxInput) {
              if (el.id) {
                const labelEl = ExecutionEngine.getLabelForInput(el.id);
                if (labelEl && labelEl instanceof HTMLInputElement && labelEl.type === "checkbox") {
                  checkboxInput = labelEl;
                }
              }
              if (el instanceof HTMLLabelElement && el.htmlFor) {
                const target = document.getElementById(el.htmlFor);
                if (target instanceof HTMLInputElement && target.type === "checkbox") {
                  checkboxInput = target;
                }
              }
              if (!checkboxInput) {
                const parentLabel = el.closest('label');
                if (parentLabel) {
                  checkboxInput = parentLabel.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
                  if (!checkboxInput && parentLabel.htmlFor) {
                    const target = document.getElementById(parentLabel.htmlFor);
                    if (target instanceof HTMLInputElement && target.type === "checkbox") {
                      checkboxInput = target;
                    }
                  }
                }
              }
            }
          }

          if (checkboxInput) {
            let desiredState = true;
            
            if (resolvedValue !== null && resolvedValue !== undefined) {
              const lowerVal = resolvedValue.toLowerCase().trim();
              const standardTrue = ["true", "yes", "1", "on", "checked"];
              const standardFalse = ["false", "no", "0", "off", "unchecked"];
              
              if (standardTrue.includes(lowerVal)) {
                desiredState = true;
              } else if (standardFalse.includes(lowerVal)) {
                desiredState = false;
              } else {
                // Custom value matching: e.g. "Sports, Music"
                const elValue = checkboxInput.value ? checkboxInput.value.toLowerCase().trim() : "";
                let labelText = "";
                if (checkboxInput.id) {
                  const labelEl = ExecutionEngine.getLabelForInput(checkboxInput.id);
                  if (labelEl) {
                    labelText = labelEl.textContent || "";
                  }
                }
                if (!labelText) {
                  const parentLabel = checkboxInput.closest('label');
                  if (parentLabel) {
                    labelText = parentLabel.textContent || "";
                  }
                }
                const lowerLabel = labelText.toLowerCase().trim();
                const parts = lowerVal.split(',').map(p => p.trim());
                
                const hasValMatch = elValue && elValue !== "on" && (parts.includes(elValue) || lowerVal.includes(elValue));
                const hasLabelMatch = lowerLabel && (parts.includes(lowerLabel) || parts.some(p => lowerLabel.includes(p) || p.includes(lowerLabel)));
                
                desiredState = !!(hasValMatch || hasLabelMatch);
              }
            } else {
              desiredState = step.checked !== undefined ? step.checked : true;
            }

            if (checkboxInput.checked !== desiredState) {
              // 1. Dispatch click events to trigger React/Vue handlers naturally.
              dispatchEvents(checkboxInput, ["mousedown", "mouseup", "click"]);
              
              // 2. Always follow up with direct property set and change/input event dispatch
              // to ensure maximum framework compatibility and readback verification.
              setCheckboxValue(checkboxInput, desiredState);
              
              // 3. Readback verification
              if (checkboxInput.checked !== desiredState) {
                throw new Error(`Checkbox failed to toggle to ${desiredState}.`);
              }
            }
          } else {
            // Fallback for custom checkboxes: click to toggle
            dispatchEvents(el, ["mousedown", "mouseup", "click"]);
          }
        }
        break;

      case Action.WAIT:
        await SmartWaitEngine.waitForDOMStability(WAIT_DOM_STABLE_TIMEOUT);
        break;

      case Action.SCROLL: {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await new Promise(r => setTimeout(r, 500)); // wait for scroll
        
        // Scroll verification: Check if the element's bounding rect intersects the viewport
        const rect = el.getBoundingClientRect();
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        
        const isIntersecting = !(
          rect.bottom < 0 ||
          rect.top > viewportHeight ||
          rect.right < 0 ||
          rect.left > viewportWidth
        );
        if (!isIntersecting) {
          throw new Error(`Element was not scrolled into viewport.`);
        }
        break;
      }

      case Action.SUBMIT: {
        const beforeSubmitUrl = window.location.href;
        let submitMutationObserved = false;
        
        const submitObserver = new MutationObserver(() => {
          submitMutationObserved = true;
        });
        
        submitObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });

        if (el instanceof HTMLFormElement) {
          const submitBtn = ExecutionEngine.findPrimarySubmitButton(el);
          if (submitBtn) {
            dispatchEvents(submitBtn, ["mousedown", "mouseup", "click"]);
          } else {
            el.submit();
          }
        } else {
          const elementAttrs = (el.id || "") + " " + (el.className || "") + " " + (el.getAttribute("aria-label") || "");
          const isCloseOrDismiss = CLOSE_DISMISS_REGEX.test(elementAttrs);
          const parentForm = el.closest("form") as HTMLFormElement | null;
          const realSubmitBtn = parentForm ? ExecutionEngine.findPrimarySubmitButton(parentForm) : null;

          if (isCloseOrDismiss && realSubmitBtn) {
            logger.warn('ExecutionEngine', `Target element ${el.id || el.className} is a modal/close button. Redirecting SUBMIT action to real form submit button.`);
            dispatchEvents(realSubmitBtn, ["mousedown", "mouseup", "click"]);
          } else if (isCloseOrDismiss && !parentForm) {
            logger.warn('ExecutionEngine', `Target element is a close button outside form. Executing CLICK instead of SUBMIT.`);
            dispatchEvents(el, ["mousedown", "mouseup", "click"]);
            submitObserver.disconnect();
            break;
          } else {
            dispatchEvents(el, ["mousedown", "mouseup", "click"]);
          }
        }

        if (ENABLE_ACTION_SETTLE_WAIT) {
          const start = Date.now();
          while (Date.now() - start < 1000) {
            if (window.location.href !== beforeSubmitUrl || submitMutationObserved) {
              break;
            }
            await new Promise(r => setTimeout(r, 50));
          }
          submitObserver.disconnect();
          
          if (window.location.href === beforeSubmitUrl && !submitMutationObserved) {
            throw new Error(`Form submission had no measurable effect on the page (no URL change or DOM mutations detected).`);
          }
        } else {
          submitObserver.disconnect();
        }
        break;
      }

      case Action.FILE_UPLOAD:
        if (el instanceof HTMLInputElement && el.type === "file" && resolvedValue) {
          try {
            // Send message to SW to fetch the file blob from IndexedDB since content script might not have direct IDB access or it might be asynchronous
            // For now, if we have a direct dependency on StorageManager, we'll use it
            const fileBlob = await StorageManager.getFileBlob(resolvedValue);
            if (fileBlob && fileBlob.data) {
              const file = new File([fileBlob.data], fileBlob.name, { type: fileBlob.type });
              const dataTransfer = new DataTransfer();
              dataTransfer.items.add(file);
              el.files = dataTransfer.files;
              dispatchEvents(el, ["change", "input"]);
              // BUG-101: Readback verification
              if (!el.files || el.files.length === 0) {
                throw new Error(`File input remained empty after upload attempt.`);
              }
            } else {
              logger.warn('ExecutionEngine', `File blob not found for alias: ${resolvedValue}`);
            }
          } catch (e) {
            logger.error('ExecutionEngine', `Failed to inject file blob for ${resolvedValue}`, e);
            throw e;
          }
        }
        break;

      case Action.RICH_TEXT:
        el.focus();
        // Modern approach: Selection API plus text node replacement avoids deprecated execCommand.
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
          range.deleteContents();
          range.insertNode(document.createTextNode(resolvedValue || ''));
          selection.removeAllRanges();
        }
        el.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: resolvedValue || '',
          bubbles: true,
          cancelable: true
        }));
        if (el.textContent !== (resolvedValue || '')) {
          el.textContent = resolvedValue || '';
        }
        dispatchEvents(el, ["input", "change", "blur"]);
        // BUG-101: Readback verification
        if ((resolvedValue || '').trim() && !el.textContent?.trim()) {
          throw new Error(`Rich text container remained empty after input attempt.`);
        }
        break;

      case Action.MANUAL_IFRAME:
        logger.info('ExecutionEngine', `Pausing for manual iframe interaction on step ${step.id}`);
        // executor.ts will handle the pause + popup logic
        break;

      case Action.DATEPICKER:
        logger.info('ExecutionEngine', `Handling Action.DATEPICKER for step ${step.id}`);
        if (resolvedValue) {
          const matchedAdapter = DatePickerRegistry.detect(el);
          const filled = await DatePickerEngine.fill(el, resolvedValue);
          if (!filled) {
            if (matchedAdapter) {
              if (matchedAdapter.name === "GenericDatePickerAdapter") {
                logger.warn('ExecutionEngine', `GenericDatePickerAdapter could not open popup for step ${step.id}. Escalating to direct input fallback.`);
                await this.fallbackDatePickerFill(el, resolvedValue);
                break;
              }
              throw new Error(`DatePicker adapter matched (${matchedAdapter.name}) but could not complete the fill sequence for step ${step.id}. See prior WARN logs for the exact stage that failed.`);
            }
            logger.warn('ExecutionEngine', `DatePickerEngine could not match any adapter for step ${step.id}. Falling back to native/direct interaction.`);
            await this.fallbackDatePickerFill(el, resolvedValue);
          }
        } else {
          logger.warn('ExecutionEngine', `No resolved value provided for DATEPICKER action on step ${step.id}`);
        }
        break;
    }
  }

  /**
   * Naive fallback strategy for DatePicker execution.
   */
  static async fallbackDatePickerFill(el: HTMLElement, resolvedValue: string): Promise<void> {
    dispatchEvents(el, ["mousedown", "mouseup", "click"]);
    let val = resolvedValue;
    const dateObj = parseDateString(val);
    if (dateObj && !isNaN(dateObj.getTime())) {
      const detectedFormat = detectElementDateFormat(el);
      if (detectedFormat) {
        val = formatDate(dateObj, detectedFormat);
      }
    }
    
    const targetInput = el instanceof HTMLInputElement ? el : (el.querySelector('input') as HTMLInputElement | null);
    if (targetInput instanceof HTMLInputElement) {
      setInputValue(targetInput, val);
      dispatchEvents(targetInput, ["input", "change", "blur"]);
      targetInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      targetInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      targetInput.blur();
    }

    // Also try setting on any hidden input within the same container
    const container = el.closest('.datepicker, .date-picker, .flatpickr-wrapper, [class*="date"]');
    if (container) {
      const hiddenInput = container.querySelector('input[type="hidden"], input.flatpickr-input') as HTMLInputElement | null;
      if (hiddenInput && hiddenInput !== targetInput) {
        setInputValue(hiddenInput, val);
        dispatchEvents(hiddenInput, ["input", "change", "blur"]);
      }
    }
  }

  /**
   * Resolves the primary submit button in a form, excluding close/dismiss/modal buttons
   * and prioritizing submit keyword text matches.
   */
  static findPrimarySubmitButton(form: HTMLFormElement): HTMLElement | null {
    const candidates = Array.from(
      form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type]), input[type="button"]')
    ) as HTMLElement[];

    const validCandidates = candidates.filter((btn) => {
      const type = btn.getAttribute("type")?.toLowerCase();
      if (type === "button" && !SUBMIT_KEYWORD_REGEX.test(btn.textContent || "")) {
        return false;
      }
      const attrs = (btn.id || "") + " " + (btn.className || "") + " " + (btn.getAttribute("aria-label") || "");
      return !CLOSE_DISMISS_REGEX.test(attrs);
    });

    if (validCandidates.length === 0) return null;

    // Prefer explicit text match for submit keywords
    const textMatch = validCandidates.find((btn) => SUBMIT_KEYWORD_REGEX.test(btn.textContent || ""));
    return textMatch || validCandidates[0];
  }
}

/**
 * Converts an Excel numeric serial date (e.g. 45789) to a JavaScript Date object.
 */
function parseExcelSerialDate(serial: number): Date | null {
  // Excel base date is Dec 30, 1899 due to 1900 leap year bug
  const excelEpoch = new Date(Date.UTC(1899, 11, 30));
  const msInDay = 24 * 60 * 60 * 1000;
  const parsed = new Date(excelEpoch.getTime() + serial * msInDay);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Checks if a format string suggests Day-first (DD/MM) rather than Month-first (MM/DD).
 */
function isDDMMFormat(formatStr: string): boolean {
  const clean = formatStr.toLowerCase().trim();
  const separator = clean.includes('/') ? '/' : clean.includes('-') ? '-' : clean.includes('.') ? '.' : '';
  if (!separator) return true; // default fallback

  const parts = clean.split(separator);
  if (parts.length !== 3) return true; // default fallback

  // If first part is explicitly 'd' or a number > 12, it is DD/MM/YYYY
  if (parts[0].includes('d') || Number(parts[0]) > 12) {
    return true;
  }
  // If second part is 'd' or a number > 12, it is MM/DD/YYYY
  if (parts[1].includes('d') || Number(parts[1]) > 12) {
    return false;
  }
  // If first part is 'm', it is MM/DD/YYYY
  if (parts[0].includes('m')) {
    return false;
  }
  // If second part is 'm', it is DD/MM/YYYY
  if (parts[1].includes('m')) {
    return true;
  }

  return true; // default fallback
}

/**
 * Parses date strings in various common formats (e.g. DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD).
 */
function parseDateString(str: string, formatPreference?: string | null): Date | null {
  if (!str) return null;
  
  // Try standard native parsing for ISO strings (containing 'T') or YYYY-MM-DD strings
  const nativeParsed = new Date(str);
  if (!isNaN(nativeParsed.getTime())) {
    if (str.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(str)) {
      return nativeParsed;
    }
  }
  
  const cleanStr = str.replace(/[^0-9\-/\.]/g, '').trim();
  
  let separator = '';
  if (cleanStr.includes('/')) separator = '/';
  else if (cleanStr.includes('-')) separator = '-';
  else if (cleanStr.includes('.')) separator = '.';
  
  if (!separator) {
    const parsed = new Date(cleanStr);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  
  const parts = cleanStr.split(separator);
  if (parts.length !== 3) {
    const parsed = new Date(cleanStr);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  
  const val1 = Number(parts[0]);
  const val2 = Number(parts[1]);
  const val3 = Number(parts[2]);
  if (isNaN(val1) || isNaN(val2) || isNaN(val3)) {
    const parsed = new Date(cleanStr);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  
  // Year is first: YYYY/MM/DD
  if (parts[0].length === 4) {
    return new Date(Date.UTC(val1, val2 - 1, val3));
  }
  
  // Year is last
  if (parts[2].length === 4) {
    // DD/MM/YYYY vs MM/DD/YYYY
    if (val1 > 12) {
      return new Date(Date.UTC(val3, val2 - 1, val1));
    }
    if (val2 > 12) {
      return new Date(Date.UTC(val3, val1 - 1, val2));
    }
    
    // Both parts <= 12, use formatPreference if available
    const isDDMM = formatPreference ? isDDMMFormat(formatPreference) : true;
    if (isDDMM) {
      return new Date(Date.UTC(val3, val2 - 1, val1)); // Day is val1, Month is val2
    } else {
      return new Date(Date.UTC(val3, val1 - 1, val2)); // Day is val2, Month is val1
    }
  }
  
  const parsed = new Date(cleanStr);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Formats a Date object to match the exact string format of a sample value.
 */
function formatDate(date: Date, formatSample?: string): string {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1);
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const d = String(date.getUTCDate());

  if (!formatSample || typeof formatSample !== 'string') {
    return `${yyyy}-${mm}-${dd}`;
  }

  const sampleClean = formatSample.replace(/[{}]/g, '').trim();
  
  // If the sample contains letters, it is a column placeholder (e.g. {{DMR-OPEN-DATE}}), not a date formatting template
  if (/[a-zA-Z]/.test(sampleClean)) {
    return `${yyyy}-${mm}-${dd}`;
  }

  let separator = '';
  if (formatSample.includes('/')) separator = '/';
  else if (formatSample.includes('-')) separator = '-';
  else if (formatSample.includes('.')) separator = '.';

  if (!separator) {
    return `${yyyy}-${mm}-${dd}`;
  }

  const parts = sampleClean.split(separator);
  if (parts.length !== 3) {
    return `${yyyy}-${mm}-${dd}`;
  }

  // Year is first: YYYY/MM/DD
  if (parts[0].length === 4) {
    const padMonth = parts[1].length === 2;
    const padDay = parts[2].length === 2;
    return `${yyyy}${separator}${padMonth ? mm : m}${separator}${padDay ? dd : d}`;
  }

  // Year is last: DD/MM/YYYY or MM/DD/YYYY
  if (parts[2].length === 4) {
    const pad1 = parts[0].length === 2;
    const pad2 = parts[1].length === 2;
    const val1 = Number(parts[0]);
    const val2 = Number(parts[1]);

    if (!isNaN(val1) && val1 > 12) {
      return `${pad1 ? dd : d}${separator}${pad2 ? mm : m}${separator}${yyyy}`;
    } else if (!isNaN(val2) && val2 > 12) {
      return `${pad1 ? mm : m}${separator}${pad2 ? dd : d}${separator}${yyyy}`;
    }
    return `${pad1 ? dd : d}${separator}${pad2 ? mm : m}${separator}${yyyy}`;
  }

  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Detects the date format template of a DOM input element by checking its value, placeholder, other inputs on the page, or library fallbacks.
 */
function detectElementDateFormat(el: HTMLElement): string | null {
  if (!(el instanceof HTMLInputElement)) return null;

  const getFormatFromInput = (input: HTMLInputElement): string | null => {
    // 1. Check existing attribute value (e.g. value="13/05/2025")
    const attrValue = input.getAttribute('value') || input.value;
    if (attrValue && attrValue.trim() && !/[a-zA-Z]/.test(attrValue)) {
      const cleanVal = attrValue.trim();
      if (cleanVal.split(/[-/\.]/).length === 3) {
        return cleanVal;
      }
    }
    // 2. Check placeholder attribute
    const placeholder = input.getAttribute('placeholder') || input.placeholder;
    if (placeholder && placeholder.trim()) {
      const cleanPlac = placeholder.replace(/[{}]/g, '').trim();
      if (cleanPlac.split(/[-/\.]/).length === 3) {
        return cleanPlac;
      }
    }
    return null;
  };

  // 1. Try the current element first
  const selfFormat = getFormatFromInput(el);
  if (selfFormat) return selfFormat;

  // 2. Try other date inputs on the same page (limit to first 20 inputs to prevent performance bottleneck)
  const otherInputs = document.querySelectorAll('input.rmdp-input, input.datepicker, input.flatpickr-input, input[type="date"]') as NodeListOf<HTMLInputElement>;
  const limit = Math.min(otherInputs.length, 20);
  for (let i = 0; i < limit; i++) {
    const format = getFormatFromInput(otherInputs[i]);
    if (format) return format;
  }

  // 3. Fallback based on library class names
  if (el.classList.contains('rmdp-input')) {
    return "DD/MM/YYYY"; // React Multi Date Picker default format
  }

  return null;
}

