import { Step, Action, LogStatus, SelectorResult } from "../../types";
import { setInputValue, setCheckboxValue, dispatchEvents } from "../domUtils";
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
import { SelectStrategyResolver } from "./SelectStrategyResolver";
import { DateParser } from "../datepickers/DateParser";

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
  static resolveAndValidateValue(step: Step, rowData: Record<string, any>, allRows?: Record<string, any>[]): ResolvedValueResult {
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
        const formatHint = (step.columnName && allRows) ? DateParser.inferColumnDateFormat(allRows, step.columnName) : undefined;
        const parsed = DateParser.parse(rawValue, formatHint || undefined);
        if (parsed.valid) {
          const formatSample = step.defaultValue || step.value || '';
          stringValue = DateParser.format(parsed, formatSample);
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

      case Action.SELECT: {
        const selectStrategy = SelectStrategyResolver.resolve(el);
        if (selectStrategy) {
          logger.info('ExecutionEngine', `Action.SELECT resolved strategy "${selectStrategy.name}"`);
          await selectStrategy.execute(el, resolvedValue || "");
        } else {
          throw new Error(
            `No select strategy matched for element <${el.tagName.toLowerCase()}> class="${el.className}"`
          );
        }
        break;
      }

      case Action.SELECT_RADIO: {
        // Match radio by value or label text — supports both native HTML and AntD/React radio groups
        const nameAttr = el.getAttribute("name");
        if (resolvedValue) {
          let radios: HTMLInputElement[] = [];

          if (nameAttr) {
            // Primary path: native HTML radio groups with name attribute
            const escapedName = CSS.escape(nameAttr);
            const scope = el.closest('form, fieldset') || document;
            radios = Array.from(scope.querySelectorAll(`input[type="radio"][name="${escapedName}"]`)) as HTMLInputElement[];
          } else {
            // Fallback path: AntD / React radio groups without name attribute
            // Walk up to the nearest radio group container
            const radioGroup = el.closest('.ant-radio-group, [role="radiogroup"]');
            if (radioGroup) {
              radios = Array.from(radioGroup.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
              logger.debug('ExecutionEngine', `AntD radio fallback: found ${radios.length} radios in group container`);
            } else {
              // Last resort: try the parent form/fieldset
              const scope = el.closest('form, fieldset') || document;
              radios = Array.from(scope.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
              logger.debug('ExecutionEngine', `Radio fallback (no group container): found ${radios.length} radios in scope`);
            }
          }

          // Shared matching logic: match by value attribute or by label text
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
            const clickTarget = targetRadio.closest('label') || targetRadio;
            dispatchEvents(clickTarget, ["mousedown", "mouseup", "click"]);
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
      }

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
    const parsed = DateParser.parse(val);
    if (parsed.valid) {
      const detectedFormat = DateParser.detectElementDateFormat(el);
      if (detectedFormat) {
        val = DateParser.format(parsed, detectedFormat);
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


