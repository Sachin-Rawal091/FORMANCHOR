import { Step, Action, SelectorMeta, FormPilotMessage, MessageType, ExecutionState, ExecutionStatus } from "../types";
import { INPUT_DEBOUNCE_MS, DOUBLE_CLICK_WINDOW_MS, XPATH_MAX_DEPTH, SUBMIT_LATCH_SAFETY_MS, CLOSE_DISMISS_REGEX, SUBMIT_KEYWORD_REGEX } from "../shared/constants";
import { logger } from "../utils/logger";
import { generateUUID } from "../utils/uuid";

import { FieldDetector } from "./datepickers/FieldDetector";
import { ActionFactory } from "./datepickers/ActionFactory";

export class RecordingEngine {
  private isRecording = false;
  private recordingId = "";
  private currentStepIndex = 0;
  private lastClickTime = 0;
  private lastClickedElement: HTMLElement | null = null;
  private debounceTimers: WeakMap<HTMLElement, ReturnType<typeof setTimeout>> = new WeakMap();
  private activeTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  private lastStepDedupeMap: Map<string | HTMLElement, { action: Action; timestamp: number }> = new Map();
  // BUG-NEW-1 fix: replaces the old lastButtonSubmitTime timestamp comparison.
  // true once a submit-type click has been recorded synchronously, until either
  // the correlated native submit event is observed or the safety timer clears it.
  private recentClickWasSubmit = false;
  private submitLatchSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  // BUG-C fix: Track inputs whose value changes were already recorded by
  // handleClickEvent's checkChanges() to prevent handleInputEvent from
  // re-recording the same value change in the same interaction cycle.
  private recentlyRecordedByClick: WeakSet<HTMLElement> = new WeakSet();

  constructor() {
    this.setupMessageListener();
    this.setupDOMEventListeners();
    this.restoreRecordingState();
    (globalThis as any).__FP_RECORDER_INSTANCE__ = this;
  }

  private setupMessageListener() {
    chrome.runtime.onMessage.addListener((message: FormPilotMessage) => {
      switch (message.type) {
        case MessageType.START_RECORDING:
          this.isRecording = true;
          this.recordingId = (message.payload as { recordingId: string })?.recordingId || "default";
          this.currentStepIndex = 0;
          logger.info('Recorder', `Recording started for session ID: ${message.sessionId}, recordingId: ${this.recordingId}`);
          break;
        case MessageType.STOP_RECORDING:
        case MessageType.START_EXECUTION:
          this.isRecording = false;
          // Clear all pending debounce timers to prevent steps being recorded after stop
          this.activeTimers.forEach(timer => clearTimeout(timer));
          this.activeTimers.clear();
          // BUG-NEW-1 fix: also reset the submit latch so state doesn't leak into a
          // subsequent recording session.
          if (this.submitLatchSafetyTimer) {
            clearTimeout(this.submitLatchSafetyTimer);
            this.submitLatchSafetyTimer = null;
          }
          this.recentClickWasSubmit = false;
          logger.info('Recorder', `Recording stopped/prevented due to message type: ${MessageType[message.type]}`);
          break;
      }
    });
  }

  private restoreRecordingState() {
    // Gate on lightweight local storage check before waking the service worker
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get('isRecordingActive', (result) => {
        if (chrome.runtime.lastError) {
          logger.warn('Recorder', 'Local storage check failed:', chrome.runtime.lastError.message);
          return;
        }
        // Only send GET_STATUS if there's evidence of an active recording
        if (!result || !result.isRecordingActive) {
          logger.debug('Recorder', 'No recording active in local storage, skipping GET_STATUS.');
          return;
        }

        logger.debug('Recorder', 'Recording state found in local storage, sending GET_STATUS...');
        chrome.runtime.sendMessage({
          type: MessageType.GET_STATUS,
          sessionId: "",
          payload: {},
          timestamp: Date.now()
        }, (response) => {
          if (chrome.runtime.lastError) {
            logger.warn('Recorder', 'GET_STATUS failed:', chrome.runtime.lastError.message);
            return;
          }
          logger.debug('Recorder', 'GET_STATUS response received:', JSON.stringify(response));
          if (response && response.recordingState) {
            const state = response.recordingState;
            if (state.isRecording) {
              this.isRecording = true;
              this.recordingId = state.recordingId || "default";
              this.currentStepIndex = state.activeRecordingSteps ? state.activeRecordingSteps.length : 0;
              logger.info('Recorder', `Restored recording state. isRecording: true, recordingId: ${this.recordingId}, stepIndex: ${this.currentStepIndex}`);
            } else {
              this.isRecording = false;
              if (chrome.storage?.local) {
                chrome.storage.local.set({ isRecordingActive: false });
              }
            }
          } else {
            this.isRecording = false;
            if (chrome.storage?.local) {
              chrome.storage.local.set({ isRecordingActive: false });
            }
          }
        });
      });
    } catch (err) {
      logger.error('Recorder', 'Error checking recording state:', err);
    }
  }

  private setupDOMEventListeners() {
    // Standard actions
    document.addEventListener("click", (e) => this.handleClickEvent(e), true);
    document.addEventListener("focusin", (e) => this.handleFocusEvent(e), true);
    document.addEventListener("input", (e) => this.handleInputEvent(e), true);
    document.addEventListener("change", (e) => this.handleChangeEvent(e), true);
    
    // File upload drag & drop actions
    document.addEventListener("dragover", (e) => e.preventDefault(), true);
    document.addEventListener("drop", (e) => this.handleDropEvent(e), true);

    // Form submits
    document.addEventListener("submit", (e) => this.handleSubmitEvent(e), true);

    // Navigation tracking
    window.addEventListener("popstate", () => this.handleNavigationEvent());
    window.addEventListener("hashchange", () => this.handleNavigationEvent());
    // BUG-NEW-3 fix: Track pushState/replaceState for SPA navigation (React Router, Next.js, Vue Router)
    window.addEventListener("fp:locationchange", () => this.handleNavigationEvent());
    this.wrapHistoryMethods();
    
    logger.debug('Recorder', 'DOM event listeners attached.');
  }

  private handleNavigationEvent() {
    if (!this.isRecording) return;
    chrome.runtime.sendMessage({
      type: MessageType.PAGE_NAVIGATED,
      sessionId: this.recordingId,
      payload: { url: window.location.href },
      timestamp: Date.now()
    }).catch((err) => {
      logger.warn('Recorder', 'PAGE_NAVIGATED message failed:', err);
    });
  }

  /**
   * BUG-NEW-3 fix: Monkey-patch history.pushState/replaceState to dispatch navigation events.
   * pushState/replaceState do not fire popstate — this is the standard approach for SPA tracking.
   */
  private wrapHistoryMethods() {
    // Guard: don't double-wrap if content script re-injects on the same page
    if ((history.pushState as any).__fpWrapped) return;
    // Note: originals may themselves already be wrappers (e.g. from analytics or other extensions).
    // Capturing whatever is currently installed preserves the existing chain.
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function (...args: Parameters<typeof history.pushState>) {
      originalPushState.apply(this, args);
      window.dispatchEvent(new Event('fp:locationchange'));
    };
    (history.pushState as any).__fpWrapped = true;
    history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
      originalReplaceState.apply(this, args);
      window.dispatchEvent(new Event('fp:locationchange'));
    };
    (history.replaceState as any).__fpWrapped = true;
  }

  private getEventTarget(e: Event): HTMLElement | null {
    if (e.composedPath && e.composedPath().length > 0) {
      return e.composedPath()[0] as HTMLElement;
    }
    return (e.target as HTMLElement) || null;
  }

  private isInsideAntSelectDropdown(el: HTMLElement): boolean {
    return el.closest(
      '.ant-select-dropdown, .ant-select-item, [class*="ant-select-dropdown"]'
    ) !== null;
  }

  private getActiveComboboxForDropdown(dropdownOptionEl: HTMLElement): HTMLElement | null {
    const dropdownContainer = dropdownOptionEl.closest('.ant-select-dropdown') as HTMLElement;
    
    // 1. Try ARIA ID association (aria-controls / aria-owns matching dropdown ID)
    if (dropdownContainer?.id) {
      const ariaMatch = document.querySelector(
        `[aria-controls="${dropdownContainer.id}"], [aria-owns="${dropdownContainer.id}"]`
      ) as HTMLElement;
      if (ariaMatch) return ariaMatch;
    }

    // 2. Try .ant-select-open active container on page
    const activeContainer = document.querySelector('.ant-select-open') as HTMLElement;
    if (activeContainer) {
      const input = activeContainer.querySelector('.ant-select-selection-search-input, input') as HTMLElement;
      if (input) return input;
    }

    // 3. Active element fallback
    if (document.activeElement?.closest('.ant-select')) {
      return document.activeElement as HTMLElement;
    }

    return null;
  }

  private observeSelectionUpdate(combobox: HTMLElement, expectedText: string) {
    const selectContainer = combobox.closest('.ant-select') as HTMLElement;
    if (!selectContainer) {
      this.addRecordedStep(Action.SELECT, combobox, expectedText);
      return;
    }

    const observer = new MutationObserver(() => {
      const selectionItem = selectContainer.querySelector('.ant-select-selection-item');
      if (selectionItem) {
        const displayText = selectionItem.textContent?.trim() || expectedText;
        observer.disconnect();
        clearTimeout(safetyTimer);
        this.addRecordedStep(Action.SELECT, combobox, displayText);
      }
    });

    observer.observe(selectContainer, { childList: true, subtree: true, characterData: true });

    const safetyTimer = setTimeout(() => {
      observer.disconnect();
      this.addRecordedStep(Action.SELECT, combobox, expectedText);
    }, 2000);
    this.activeTimers.add(safetyTimer);
  }

  private handleFocusEvent(e: FocusEvent) {
    if (!this.isRecording || !e.isTrusted) return;
    // focusin is used purely for active state tracking; steps are created on explicit user interactions
  }  private getAllInputsDeep(root: ParentNode = document): (HTMLInputElement | HTMLTextAreaElement)[] {
    const results: (HTMLInputElement | HTMLTextAreaElement)[] = [];
    const walk = (node: ParentNode) => {
      const inputs = node.querySelectorAll("input, textarea");
      inputs.forEach((input) => {
        if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
          results.push(input);
        }
      });
      node.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) {
          walk(el.shadowRoot);
        }
      });
    };
    walk(root);
    return results;
  }

  private handleClickEvent(e: MouseEvent) {
    if (!this.isRecording) return;

    const el = this.getEventTarget(e);
    if (!el) return;

    // Skip recording clicks on checkboxes, radios, or their associated labels/containers
    // to prevent double-recording (the native change handler will record TOGGLE_CHECKBOX / SELECT_RADIO)
    if (this.isCheckboxOrRadioOrLabel(el)) {
      return;
    }

    logger.debug('Recorder', `Click event on <${el.tagName.toLowerCase()}> id=${el.id || 'none'} type=${el.getAttribute('type') || 'none'}`);

    const tagName = el.tagName.toLowerCase();

    const interactiveTarget = el.closest(
      "button, a, label, select, [role='button'], [role='option'], [role='combobox'], [role='listbox'], [role='menuitem'], .select-trigger, .dropdown-toggle"
    ) as HTMLElement | null;
    const button = el.closest("button");
    const targetElement = interactiveTarget || button || el;

    // Intercept clicks inside AntD Select dropdown portal to record Action.SELECT
    if (this.isInsideAntSelectDropdown(targetElement)) {
      const optionEl = (targetElement.closest('.ant-select-item-option') || targetElement) as HTMLElement;
      const optionText = optionEl
        ?.querySelector('.ant-select-item-option-content')?.textContent?.trim()
        || optionEl?.textContent?.trim() || "";

      const activeCombobox = this.getActiveComboboxForDropdown(targetElement);

      if (optionText && activeCombobox) {
        this.observeSelectionUpdate(activeCombobox, optionText);
      }
      return;
    }

    // Track submit button clicks to deduplicate subsequent form submit events.
    // Ensure target element is genuinely a button or submit input element
    const typeAttr = targetElement ? targetElement.getAttribute("type")?.toLowerCase() : null;
    const isButtonTag = tagName === "button" || (button !== null) || (tagName === "input" && (typeAttr === "submit" || typeAttr === "image"));
    const isRoleButton = targetElement.getAttribute("role") === "button";
    const isValidButton = isButtonTag || isRoleButton;

    const isExplicitNonSubmit = typeAttr === "button" || typeAttr === "reset";
    const elementAttributesStr = (targetElement.id || "") + " " + (targetElement.className || "") + " " + (targetElement.getAttribute("aria-label") || "");
    const isCloseOrDismiss = CLOSE_DISMISS_REGEX.test(elementAttributesStr);

    const isSubmitButton = isValidButton && !isExplicitNonSubmit && !isCloseOrDismiss && (
      typeAttr === "submit" ||
      typeAttr === "image" ||
      (isValidButton && !typeAttr && SUBMIT_KEYWORD_REGEX.test(targetElement.textContent || "")) ||
      (button && !typeAttr && button.closest("form") !== null)
    );

    if (isSubmitButton) {
      const formEl = targetElement.closest("form") as HTMLFormElement | null;
      this.addRecordedStep(Action.SUBMIT, formEl || targetElement);

      this.recentClickWasSubmit = true;
      if (this.submitLatchSafetyTimer) {
        clearTimeout(this.submitLatchSafetyTimer);
      }
      this.submitLatchSafetyTimer = setTimeout(() => {
        this.recentClickWasSubmit = false;
        this.submitLatchSafetyTimer = null;
      }, SUBMIT_LATCH_SAFETY_MS);
    }

    // Deduplication of double-clicks
    const now = Date.now();
    if (now - this.lastClickTime < DOUBLE_CLICK_WINDOW_MS && this.lastClickedElement === targetElement) {
      return;
    }
    this.lastClickTime = now;
    this.lastClickedElement = targetElement;

    // Capture values of all inputs on the page (including inside Shadow DOM roots)
    const inputsBeforeClick = new Map<HTMLInputElement | HTMLTextAreaElement, string>();
    this.getAllInputsDeep().forEach((input) => {
      inputsBeforeClick.set(input, input.value);
    });

    let programmaticChangeDetected = false;
    const recordedInputs = new Set<HTMLInputElement | HTMLTextAreaElement>();

    const checkChanges = () => {
      let changeFound = false;
      inputsBeforeClick.forEach((oldValue, inputEl) => {
        if (!document.body.contains(inputEl)) return;
        const newValue = inputEl.value;
        if (newValue !== oldValue && !recordedInputs.has(inputEl)) {
          // If the new value is empty, it's likely a form reset/clear, ignore it
          if (newValue === "" && oldValue !== "") {
            return;
          }

          recordedInputs.add(inputEl);
          this.recentlyRecordedByClick.add(inputEl);
          changeFound = true;
          programmaticChangeDetected = true;
          logger.info('Recorder', `Detected programmatic value change on <${inputEl.tagName.toLowerCase()}> after click: "${oldValue}" -> "${newValue}"`);
          
          const detection = FieldDetector.detect(inputEl);
          const isDateInput = 
            inputEl.type === 'date' || 
            detection.isNativeDate ||
            detection.isCustomDatePicker ||
            inputEl.classList.contains('datepicker') || 
            inputEl.classList.contains('rmdp-input') || 
            inputEl.classList.contains('flatpickr-input') ||
            /date|calendar|picker|dob|birth|expiry/i.test(inputEl.name || inputEl.id || inputEl.className || inputEl.placeholder || '');
          
          const action = isDateInput ? Action.DATEPICKER : Action.FILL;
          this.addRecordedStep(action, inputEl, newValue);
        }
      });
      return changeFound;
    };

    // Run programmatic change checks at intervals covering React/Vue async re-renders and exit animations
    const intervals = [50, 100, 250, 400];
    intervals.forEach((delay) => {
      const timer = setTimeout(() => {
        checkChanges();
        this.activeTimers.delete(timer);

        // Evaluate click step recording at 100ms (zero delay for buttons/links)
        if (delay === 100) {
          if (isSubmitButton) {
            return;
          }

          const isControlClick = this.isButtonOrLink(targetElement) && !this.isInsideDatePicker(targetElement);

          if (!this.isInsideDatePicker(targetElement)) {
            if (!programmaticChangeDetected || isControlClick) {
              const selectEl = el.tagName.toLowerCase() === "select" ? el : el.closest("select");
              if (selectEl) {
                const selectVal = (el instanceof HTMLOptionElement && el.value !== undefined && el.value !== "")
                  ? el.value
                  : (selectEl as HTMLSelectElement).value;
                this.addRecordedStep(Action.SELECT, selectEl, selectVal);
              } else {
                // Ignore plain value inputs for CLICK steps, allow buttons/submits
                if (tagName === "input" || tagName === "textarea") {
                  const typeAttr = el.getAttribute("type")?.toLowerCase() || "";
                  if (typeAttr !== "submit" && typeAttr !== "button" && typeAttr !== "image") {
                    return;
                  }
                }

                // Guard: Only record Action.CLICK on genuinely interactive elements.
                // Skip passive container elements (div, span, section, form, p, td, li, etc.)
                const isInteractive = this.isButtonOrLink(targetElement) || this.isInteractiveTarget(targetElement);
                if (!isInteractive) {
                  logger.debug('Recorder', `Skipped Action.CLICK recording on passive container <${targetElement.tagName.toLowerCase()}>`);
                  return;
                }

                this.addRecordedStep(Action.CLICK, targetElement);
              }
            }
          }
        }
      }, delay);
      this.activeTimers.add(timer);
    });
  }

  private isInteractiveTarget(el: HTMLElement): boolean {
    if (!el) return false;
    const tagName = el.tagName.toLowerCase();

    // Explicit interactive tags
    if (tagName === "button" || tagName === "a" || tagName === "select" || tagName === "summary" || tagName === "details") {
      return true;
    }

    // Input tags of submit/button/image/reset/checkbox/radio
    if (tagName === "input") {
      const typeAttr = el.getAttribute("type")?.toLowerCase() || "";
      return ["submit", "button", "image", "reset", "checkbox", "radio"].includes(typeAttr);
    }

    // Elements with explicit interactive ARIA roles
    const role = el.getAttribute("role")?.toLowerCase();
    if (role && ["button", "link", "tab", "menuitem", "option", "checkbox", "radio", "switch", "combobox", "treeitem"].includes(role)) {
      return true;
    }

    // Elements with tabindex specified (interactive focusable elements)
    if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") {
      return true;
    }

    // Check if element has an explicit inline onclick handler
    if (el.getAttribute("onclick") || (el as any).onclick) {
      return true;
    }

    // Check for interactive class patterns or ancestors
    if (this.isButtonOrLink(el)) {
      return true;
    }

    return false;
  }

  private isButtonOrLink(el: HTMLElement): boolean {
    const tagName = el.tagName.toLowerCase();
    if (tagName === "button" || tagName === "a") return true;
    if (el.closest("button") || el.closest("a")) return true;
    const role = el.getAttribute("role");
    if (role === "button" || role === "combobox" || role === "option" || role === "menuitem" || role === "tab" || role === "listbox") return true;
    if (el.closest('[role="button"], [role="combobox"], [role="option"], [role="menuitem"], [role="tab"], [role="listbox"]')) return true;
    
    // Check classes for button or dropdown trigger/option patterns
    const classList = Array.from(el.classList);
    if (classList.some(c => 
      /^(?:btn|button|select|dropdown|trigger|option|combobox|item)(?:[-_].*)?$/i.test(c) || 
      /^.*[-_](?:btn|button|select|dropdown|trigger|option|combobox|item)$/i.test(c) ||
      /^(?:ant-select|react-select|mantine-Select|mui-select)/i.test(c)
    )) return true;
    
    return false;
  }

  private isInsideDatePicker(el: HTMLElement): boolean {
    // Direct CSS ancestor check for datepicker popup overlays.
    // FieldDetector.detect() is restricted to input/textarea/select elements,
    // but clicked elements inside datepicker popups are typically spans, divs, etc.
    return el.closest(
      ".rmdp-wrapper, .rmdp-calendar, .rmdp-container, .rmdp-ep, .react-multi-date-picker, " +
      ".ant-picker-dropdown, .ant-picker-panel, .ant-picker-date-panel, .ant-picker-body, .ant-picker-cell, " +
      ".MuiPickersPopper-root, .MuiPickersLayout-root, " +
      ".flatpickr-calendar, .flatpickr-wrapper, " +
      ".react-datepicker-popper, .datepicker, .datepicker-container, .date-picker, .ui-datepicker, " +
      "[class*='datepicker'], [class*='calendar']"
    ) !== null;
  }

  private handleInputEvent(e: Event) {
    if (!this.isRecording) return;

    const el = this.getEventTarget(e);
    if (!el) return;

    logger.debug('Recorder', `Input event on <${el.tagName.toLowerCase()}> id=${el.id || 'none'} isRecording=${this.isRecording}`);

    const tagName = el.tagName.toLowerCase();
    const typeAttr = el.getAttribute("type")?.toLowerCase() || "";

    // Handled under change event
    if (typeAttr === "checkbox" || typeAttr === "radio" || tagName === "select" || typeAttr === "file") {
      return;
    }

    // Skip combobox search inputs — transient search typing should not record as Action.FILL
    if (el.closest('.ant-select') || (el.getAttribute('role') === 'combobox' && el.getAttribute('aria-haspopup') === 'listbox')) {
      logger.debug('Recorder', 'Skipped Action.FILL on combobox search input');
      return;
    }

    // Handle standard inputs/textareas with debouncing to capture finalized values only
    if (tagName === "input" || tagName === "textarea" || el.isContentEditable) {
      // BUG-C fix: Skip readonly date inputs — their values are set programmatically
      // by the calendar widget and are already captured by checkChanges() in handleClickEvent.
      if (el instanceof HTMLInputElement && el.readOnly) {
        const detection = FieldDetector.detect(el);
        if (detection.isCustomDatePicker || detection.isNativeDate) {
          return;
        }
      }

      const existingTimer = this.debounceTimers.get(el);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.activeTimers.delete(existingTimer);
      }

      const timer = setTimeout(() => {
        // BUG-C fix: If this input was already recorded by checkChanges(), skip it.
        if (this.recentlyRecordedByClick.has(el)) {
          this.recentlyRecordedByClick.delete(el);
          this.debounceTimers.delete(el);
          this.activeTimers.delete(timer);
          return;
        }
        const value = el.isContentEditable ? el.innerText : (el as HTMLInputElement).value;
        const isRichText = el.isContentEditable || el.classList.contains("mce-content-body") || el.classList.contains("ql-editor");

        const detection = FieldDetector.detect(el);
        const isDateInput = 
          (el as HTMLInputElement).type === 'date' || 
          detection.isNativeDate ||
          detection.isCustomDatePicker ||
          el.classList.contains('datepicker') || 
          el.classList.contains('rmdp-input') || 
          el.classList.contains('flatpickr-input') ||
          /date|calendar|picker|dob|birth|expiry/i.test((el as HTMLInputElement).name || el.id || el.className || '');
        
        const action = isRichText ? Action.RICH_TEXT : (isDateInput ? Action.DATEPICKER : Action.FILL);
        this.addRecordedStep(action, el, value);
        this.debounceTimers.delete(el);
        this.activeTimers.delete(timer);
      }, INPUT_DEBOUNCE_MS);

      this.debounceTimers.set(el, timer);
      this.activeTimers.add(timer);
    }
  }

  private handleChangeEvent(e: Event) {
    if (!this.isRecording) return;

    const el = this.getEventTarget(e);
    if (!el) return;

    const tagName = el.tagName.toLowerCase();
    const typeAttr = el.getAttribute("type")?.toLowerCase() || "";

    if (tagName === "select") {
      const selectVal = (el as HTMLSelectElement).value;
      this.addRecordedStep(Action.SELECT, el, selectVal);
    } else if (tagName === "input") {
      if (typeAttr === "checkbox") {
        const isChecked = (el as HTMLInputElement).checked;
        this.addRecordedStep(Action.TOGGLE_CHECKBOX, el, isChecked ? "true" : "false", isChecked);
      } else if (typeAttr === "radio") {
        const radioVal = (el as HTMLInputElement).value;
        this.addRecordedStep(Action.SELECT_RADIO, el, radioVal);
      } else if (typeAttr === "file") {
        const fileInput = el as HTMLInputElement;
        const fileName = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0].name : "";
        this.addRecordedStep(Action.FILE_UPLOAD, el, fileName);
      } else if (typeAttr === "date") {
        if (this.recentlyRecordedByClick.has(el)) return;
        const dateVal = (el as HTMLInputElement).value;
        if (dateVal) {
          this.addRecordedStep(Action.DATEPICKER, el, dateVal);
        }
      }
    }
  }

  private handleDropEvent(e: DragEvent) {
    if (!this.isRecording) return;

    const el = e.target as HTMLElement;
    if (!el) return;

    // Check if files were dropped
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const filename = e.dataTransfer.files[0].name;
      this.addRecordedStep(Action.FILE_UPLOAD, el, filename);
    }
  }

  private handleSubmitEvent(e: SubmitEvent) {
    if (!this.isRecording) return;

    const formEl = e.target as HTMLFormElement;
    if (!formEl) return;

    // BUG-NEW-1 / BUG-NEW-9 fix: use the synchronous-recording latch instead of a
    // fixed timestamp window. A fixed window can't simultaneously be "long enough"
    // for slow validation/captcha-gated submits and "short enough" not to eat a
    // genuinely separate second submit — the latch is cleared deterministically by
    // whichever happens first: this event firing, or the safety timeout.
    if (this.recentClickWasSubmit) {
      logger.info('Recorder', 'Ignored native submit event because it was already recorded synchronously on click.');
      this.recentClickWasSubmit = false;
      if (this.submitLatchSafetyTimer) {
        clearTimeout(this.submitLatchSafetyTimer);
        this.submitLatchSafetyTimer = null;
      }
      return;
    }

    // No preceding click recorded this submit (e.g. Enter-key submission) — record directly.
    this.addRecordedStep(Action.SUBMIT, formEl);
  }

  private addRecordedStep(rawAction: Action, el: HTMLElement, value = "", checked?: boolean) {
    const detection = FieldDetector.detect(el);
    const resolved = ActionFactory.resolveAction(detection, rawAction);
    const action = resolved.action;

    const selectorMeta = this.generateSelectorMeta(el);
    if (resolved.metadata) {
      selectorMeta.metadata = { ...(selectorMeta.metadata || {}), ...resolved.metadata };
    }
    const primarySelector = selectorMeta.cssPath || el.tagName.toLowerCase();

    // Step Deduplication Check: ignore rapid duplicate step on same selector & action within 300ms window
    const now = Date.now();
    const dedupeKey = `${primarySelector}:${action}`;
    const lastStep = this.lastStepDedupeMap.get(dedupeKey) || this.lastStepDedupeMap.get(el);
    if (lastStep && lastStep.action === action && (now - lastStep.timestamp) < 300) {
      logger.debug('Recorder', `Deduplicated rapid step on ${primarySelector} for action ${action}`);
      return;
    }
    this.lastStepDedupeMap.set(el, { action, timestamp: now });
    this.lastStepDedupeMap.set(dedupeKey, { action, timestamp: now });

    // Mapping steps to the active page flow context
    const currentUrl = window.location.href;
    const urlPath = window.location.pathname.replace(/[^a-zA-Z0-9]/g, "_");
    const pageId = "page_" + window.location.hostname.replace(/\./g, "_") + urlPath;

    const newStep: Step = {
      id: this.generateUUID(),
      action,
      selector: primarySelector,
      selectorMeta,
      value,
      pageId,
      checked,
      required: (el as any).required === true || el.hasAttribute('required'),
      retryable: true,
      maxRetries: 3,
      expectedType: resolved.expectedType,
    };

    // Mutually exclude recording events if an automation run is currently active
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
      chrome.storage.session.get('executionState', (result) => {
        if (chrome.runtime.lastError) {
          logger.warn('Recorder', 'Session storage check failed:', chrome.runtime.lastError.message);
          this.sendRecordingEvent(newStep, currentUrl);
          return;
        }
        const execState = result?.executionState as ExecutionState | undefined;
        if (execState) {
          const status = execState.status;
          // Ignore event if status is RUNNING (1), PAUSED (2), or CAPTCHA_PAUSED (3)
          if (
            status === ExecutionStatus.RUNNING ||
            status === ExecutionStatus.PAUSED ||
            status === ExecutionStatus.CAPTCHA_PAUSED
          ) {
            logger.warn('Recorder', 'Ignored recording step because execution is active.', { status });
            return;
          }
        }
        this.sendRecordingEvent(newStep, currentUrl);
      });
    } else {
      this.sendRecordingEvent(newStep, currentUrl);
    }
  }

  private sendRecordingEvent(newStep: Step, currentUrl: string) {
    logger.debug('Recorder', 'Recorded Step:', newStep);

    // Send the recorded step to service worker which persists it and forwards to popup
    chrome.runtime.sendMessage({
      type: MessageType.RECORDING_EVENT,
      sessionId: this.recordingId,
      payload: {
        step: newStep,
        url: currentUrl,
        stepIndex: this.currentStepIndex++
      },
      timestamp: Date.now()
    }).catch(err => {
      logger.error('Recorder', 'Failed to send step to service worker:', err);
    });
  }

  private generateSelectorMeta(el: HTMLElement): SelectorMeta {
    const meta: SelectorMeta = {};

    if (el.id) {
      meta.id = el.id;
    }

    const name = el.getAttribute("name");
    if (name) {
      meta.name = name;
    }

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) {
      meta.ariaLabel = ariaLabel;
    }

    const placeholder = el.getAttribute("placeholder");
    if (placeholder) {
      meta.placeholder = placeholder;
    }

    // Try label finding
    meta.labelText = this.findAssociatedLabel(el);

    // If target is a button, link, or role=button and labelText is empty, use its text content
    const tagName = el.tagName.toLowerCase();
    const role = el.getAttribute("role")?.toLowerCase();
    if (!meta.labelText && (tagName === "button" || tagName === "a" || role === "button" || el.classList.contains("btn"))) {
      const btnText = el.textContent?.trim();
      if (btnText && btnText.length < 50) {
        meta.labelText = btnText;
      }
    }

    // BUG-NEW-6 fix: Capture data-testid and role for higher-fidelity selector metadata
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
    if (testId) {
      meta.testId = testId;
    }
    const roleAttr = el.getAttribute("role");
    if (roleAttr) {
      meta.role = roleAttr;
    }

    meta.cssPath = this.generateCssPath(el);
    meta.xpath = this.generateXPath(el);

    return meta;
  }

  private escapeValue(val: string): string {
    if (typeof CSS !== 'undefined' && CSS.escape) {
      return CSS.escape(val);
    }
    return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private isDynamicId(id: string): boolean {
    if (!id || typeof id !== 'string') return false;
    // BUG-NEW-8 fix: Added chakra-/mantine- for Chakra UI and Mantine hash-style IDs
    if (/^(radix|headlessui|mui|jss|ng|ember|__BuiOuter|react-select-|dp-|chakra-|mantine-)/i.test(id)) {
      return true;
    }
    if (/:/.test(id)) {
      return true;
    }
    if (/\d{4,}/.test(id)) {
      return true;
    }
    if (/[-_]\d+$/.test(id)) {
      return true;
    }
    return false;
  }

  private cleanLabelText(label: HTMLElement): string {
    if (!label || !label.childNodes) return "";
    return Array.from(label.childNodes)
      .filter(n => n && n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent?.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  private findAssociatedLabel(el: HTMLElement): string | undefined {
    if (!el) return undefined;
    const elId = typeof el.getAttribute === 'function' ? el.getAttribute("id") : null;
    const root = (typeof el.getRootNode === 'function' ? el.getRootNode() : document) as ParentNode;

    // 1. Explicit label with 'for' attribute matching el.id (scoped to element's root/ShadowRoot)
    if (elId && root && typeof root.querySelector === 'function') {
      try {
        const label = root.querySelector(`label[for="${this.escapeValue(elId)}"]`);
        if (label && label.textContent) {
          return label.textContent.trim();
        }
      } catch (e) {
        // ignore invalid selector
      }
    }

    // 2. Nested label wrapper (e.g. <label><input /></label>)
    const parentLabel = typeof el.closest === 'function' ? el.closest("label") : null;
    if (parentLabel) {
      return this.cleanLabelText(parentLabel);
    }

    // 3. Preceding sibling label (direct or nearby preceding sibling in same DOM parent)
    let prev = el.previousElementSibling;
    while (prev) {
      if (prev.tagName === "LABEL" || prev.classList.contains("form-label")) {
        if (prev.textContent) {
          return prev.textContent.trim();
        }
      }
      prev = prev.previousElementSibling;
    }

    // 4. Scoped container label (prefer matching for="" over first generic label)
    const container = typeof el.closest === 'function'
      ? el.closest(".form-group, .field-group, .box, .col-md-6, .col-sm-6, .form-row, td, tr") || el.parentElement
      : el.parentElement;

    if (container && typeof container.querySelector === 'function') {
      try {
        if (elId) {
          const matchingLabel = container.querySelector(`label[for="${this.escapeValue(elId)}"]`);
          if (matchingLabel && matchingLabel.textContent) {
            return matchingLabel.textContent.trim();
          }
        }

        // Preceding label inside container
        const containerLabels = Array.from(container.querySelectorAll("label, .form-label, .control-label, strong, b"));
        const precedingLabel = containerLabels.find(lbl => 
          (lbl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        );
        if (precedingLabel && precedingLabel.textContent) {
          return precedingLabel.textContent.trim();
        }
      } catch (e) {
        // ignore invalid selector
      }
    }

    return undefined;
  }

  private generateCssPath(el: HTMLElement): string {
    const path: string[] = [];
    let current: HTMLElement | null = el;

    while (current && current !== document.body && current.nodeType === Node.ELEMENT_NODE) {
      let selector = current.nodeName.toLowerCase();
      const nameAttr = typeof current.getAttribute === 'function' ? current.getAttribute("name") : null;
      const curId = typeof current.getAttribute === 'function' ? current.getAttribute("id") : null;

      if (curId && !this.isDynamicId(curId)) {
        // BUG-AUDIT-FIX-1: Verify ID is truly unique within its containing root (document or ShadowRoot)
        try {
          const root = (typeof current.getRootNode === 'function' ? current.getRootNode() : document) as ParentNode;
          const idCount = root.querySelectorAll(`#${CSS.escape(curId)}`).length;
          if (idCount === 1) {
            selector += `#${this.escapeValue(curId)}`;
            path.unshift(selector);
            break; // Verified unique stable ID within root, stop climbing
          }
          // ID appears multiple times — fall through to structural selectors
        } catch {
          // Invalid CSS selector from malformed ID — fall through
        }
      } else if (nameAttr && !/^(radix|headlessui|react-select)/i.test(nameAttr)) {
        selector += `[name="${this.escapeValue(nameAttr)}"]`;
        try {
          const root = (typeof current.getRootNode === 'function' ? current.getRootNode() : document) as ParentNode;
          if (root.querySelectorAll(`[name="${this.escapeValue(nameAttr)}"]`).length === 1) {
            path.unshift(selector);
            break;
          }
        } catch (e) {
          // ignore invalid querySelector
        }
        // BUG-NEW-4 fix: Name not globally unique (e.g. radio groups, repeated form rows).
        // Fall through to sibling-counting disambiguation.
        let nameSib = current.previousElementSibling;
        let nameNth = 1;
        while (nameSib) {
          if (nameSib.nodeName.toLowerCase() === current.nodeName.toLowerCase()) {
            nameNth++;
          }
          nameSib = nameSib.previousElementSibling;
        }
        const nameCurrNodeName = current.nodeName;
        const nameHasSameTypeSiblings = current.parentElement
          ? Array.from(current.parentElement.children)
              .filter(c => c.nodeName === nameCurrNodeName).length > 1
          : false;
        if (nameHasSameTypeSiblings) {
          selector += `:nth-of-type(${nameNth})`;
        }
      } else {
        let sib = current.previousElementSibling;
        let nth = 1;
        while (sib) {
          if (sib.nodeName.toLowerCase() === current.nodeName.toLowerCase()) {
            nth++;
          }
          sib = sib.previousElementSibling;
        }
        const currNodeName = current.nodeName;
        const hasSameTypeSiblings = current.parentElement
          ? Array.from(current.parentElement.children)
              .filter(c => c.nodeName === currNodeName).length > 1
          : false;
        if (hasSameTypeSiblings) {
          selector += `:nth-of-type(${nth})`;
        }
      }
      path.unshift(selector);
      current = current.parentElement;
    }

    return path.join(" > ");
  }

  private generateXPath(el: HTMLElement): string {
    const elId = typeof el.getAttribute === 'function' ? el.getAttribute("id") : null;
    if (elId && !this.isDynamicId(elId)) {
      // BUG-AUDIT-FIX-1: Verify ID is truly unique before using it as XPath anchor
      try {
        const idCount = document.querySelectorAll(`#${CSS.escape(elId)}`).length;
        if (idCount === 1) {
          return `//*[@id="${this.escapeValue(elId)}"]`;
        }
      } catch {
        // Invalid CSS selector from malformed ID — fall through to structural path
      }
    }

    const paths: string[] = [];
    let current: HTMLElement | null = el;
    let depth = 0;
    let anchor: string | null = null;

    while (current && current.nodeType === Node.ELEMENT_NODE && depth < XPATH_MAX_DEPTH) {
      const curId = typeof current.getAttribute === 'function' ? current.getAttribute("id") : null;
      // If we find an ancestor with a stable ID, anchor to it
      if (current !== el && curId && !this.isDynamicId(curId)) {
        // BUG-AUDIT-FIX-1: Verify ancestor ID is truly unique before anchoring
        try {
          const anchorIdCount = document.querySelectorAll(`#${CSS.escape(curId)}`).length;
          if (anchorIdCount === 1) {
            anchor = `//*[@id="${this.escapeValue(curId)}"]`;
            break;
          }
        } catch {
          // fall through
        }
      }

      const tagName = current.nodeName.toLowerCase();
      if (current !== el && (tagName === "form" || tagName === "fieldset")) {
        if (curId && !this.isDynamicId(curId)) {
          anchor = `//${tagName}[@id="${this.escapeValue(curId)}"]`;
        } else {
          anchor = `//${tagName}`;
        }
        break;
      }

      let index = 0;
      let sibling = current.previousSibling;
      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === current.nodeName) {
          index++;
        }
        sibling = sibling.previousSibling;
      }

      const pathIndex = index > 0 ? `[${index + 1}]` : "";
      paths.unshift(`${tagName}${pathIndex}`);
      
      current = current.parentElement;
      depth++;
    }

    if (anchor) {
      return `${anchor}/${paths.join("/")}`;
    }

    return paths.length ? `//${paths.join("/")}` : "";
  }

  private isCheckboxOrRadioOrLabel(el: HTMLElement): boolean {
    const tagName = el.tagName.toLowerCase();
    if (tagName === "input") {
      const type = (el as HTMLInputElement).type?.toLowerCase();
      if (type === "checkbox" || type === "radio") {
        return true;
      }
    }
    if (tagName === "label") {
      const label = el as HTMLLabelElement;
      if (label.htmlFor) {
        const target = document.getElementById(label.htmlFor);
        if (target instanceof HTMLInputElement) {
          const type = target.type?.toLowerCase();
          if (type === "checkbox" || type === "radio") {
            return true;
          }
        }
      }
      if (label.querySelector('input[type="checkbox"], input[type="radio"]')) {
        return true;
      }
    }
    const parentLabel = el.closest("label");
    if (parentLabel) {
      if (parentLabel.htmlFor) {
        const target = document.getElementById(parentLabel.htmlFor);
        if (target instanceof HTMLInputElement) {
          const type = target.type?.toLowerCase();
          if (type === "checkbox" || type === "radio") {
            return true;
          }
        }
      }
      if (parentLabel.querySelector('input[type="checkbox"], input[type="radio"]')) {
        return true;
      }
    }
    if (el.querySelector('input[type="checkbox"], input[type="radio"]')) {
      return true;
    }
    return false;
  }

  private generateUUID(): string {
    return generateUUID();
  }
}

// Instantiate the recorder with singleton guard
if (typeof window !== 'undefined' && !(globalThis as any).__FP_RECORDER_INIT__) {
  (globalThis as any).__FP_RECORDER_INIT__ = true;
  new RecordingEngine();
}
