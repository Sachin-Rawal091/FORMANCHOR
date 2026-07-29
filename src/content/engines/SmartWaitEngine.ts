import { SelectorMeta, SelectorResult } from "../../types";
import { SelectorEngine } from "./SelectorEngine";
import { getExecutionContext } from "./executionContext";
import {
  POLL_INTERVAL_BASE,
  WAIT_DOM_STABILITY_SILENCE,
  WAIT_NETWORK_IDLE_TIMEOUT,
  NETWORK_IDLE_CEILING,
  NAVIGATION_DOM_THRESHOLD,
} from "../../shared/constants";

export class SmartWaitEngine {
  /**
   * Polls until the element is present in the DOM.
   * Uses exponential backoff for the polling interval.
   */
  static async waitForElement(
    meta: SelectorMeta,
    selector: string,
    timeout: number
  ): Promise<SelectorResult> {
    return this.pollForCondition(
      () => SelectorEngine.findElement(meta, selector),
      timeout
    );
  }

  /**
   * Checks if an element is visible (not display: none, width/height > 0).
   */
  static async waitForElementVisible(
    meta: SelectorMeta,
    selector: string,
    timeout: number
  ): Promise<SelectorResult> {
    return this.pollForCondition(() => {
      const result = SelectorEngine.findElement(meta, selector);
      if (result) {
        const el = result.element as HTMLElement;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const isBypass = el.tagName === "INPUT" && 
          ["checkbox", "radio", "file"].includes((el as HTMLInputElement).type?.toLowerCase());

        if (style.display !== "none" && style.visibility !== "hidden") {
          if (isBypass) {
            return result;
          }
          if (rect.width > 0 && rect.height > 0 && style.opacity !== "0") {
            return result;
          }
        }
      }
      return null;
    }, timeout);
  }

  /**
   * Checks if an element is interactable (not disabled).
   */
  static async waitForElementClickable(
    meta: SelectorMeta,
    selector: string,
    timeout: number
  ): Promise<SelectorResult> {
    return this.pollForCondition(() => {
      const result = SelectorEngine.findElement(meta, selector);
      if (result) {
        const el = result.element as HTMLElement;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const isDisabled = (el as HTMLButtonElement | HTMLInputElement).disabled;
        const isBypass = el.tagName === "INPUT" && 
          ["checkbox", "radio", "file"].includes((el as HTMLInputElement).type?.toLowerCase());

        if (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.pointerEvents !== "none" &&
          !isDisabled
        ) {
          if (isBypass) {
            return result;
          }
          if (rect.width > 0 && rect.height > 0) {
            return result;
          }
        }
      }
      return null;
    }, timeout);
  }

  /**
   * Resolves when there have been no DOM mutations for WAIT_DOM_STABILITY_SILENCE ms.
   * If timeout is reached, it resolves anyway to prevent hanging.
   *
   * BUG-AUDIT-FIX-8: Now pause/abort-aware — mutations during pause are ignored,
   * abort resolves immediately, and the hard timeout accounts for pause time.
   */
  static async waitForDOMStability(timeout: number): Promise<void> {
    return new Promise((resolve) => {
      let silenceTimer: ReturnType<typeof setTimeout>;
      let timeoutTimer: ReturnType<typeof setTimeout>;
      let pauseStart: number | null = null;
      let accumulatedPauseTime = 0;
      const startTime = Date.now();

      const observer = new MutationObserver(() => {
        const executor = getExecutionContext();

        // If aborted, resolve immediately — don't block execution teardown
        if (executor && !executor.isRunning) {
          cleanup();
          resolve();
          return;
        }

        // If paused, ignore mutations — don't reset the silence timer
        if (executor && executor.isPaused) {
          if (pauseStart === null) pauseStart = Date.now();
          return;
        }

        // Unpaused — account for accumulated pause time
        if (pauseStart !== null) {
          accumulatedPauseTime += Date.now() - pauseStart;
          pauseStart = null;
        }

        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          cleanup();
          resolve();
        }, WAIT_DOM_STABILITY_SILENCE);
      });

      const cleanup = () => {
        observer.disconnect();
        clearTimeout(silenceTimer);
        clearTimeout(timeoutTimer);
      };

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      // Initial silence timer if no mutations happen at all
      silenceTimer = setTimeout(() => {
        cleanup();
        resolve();
      }, WAIT_DOM_STABILITY_SILENCE);

      // Hard timeout — uses polling to account for pause time
      const checkTimeout = () => {
        const executor = getExecutionContext();
        if (executor && !executor.isRunning) {
          cleanup();
          resolve();
          return;
        }
        if (executor && executor.isPaused) {
          if (pauseStart === null) pauseStart = Date.now();
        } else if (pauseStart !== null) {
          accumulatedPauseTime += Date.now() - pauseStart;
          pauseStart = null;
        }
        const elapsed = Date.now() - startTime - accumulatedPauseTime;
        if (elapsed >= timeout) {
          cleanup();
          resolve();
        } else {
          timeoutTimer = setTimeout(checkTimeout, 300);
        }
      };
      timeoutTimer = setTimeout(checkTimeout, Math.min(timeout, 300));
    });
  }

  /**
   * Detects navigation by monitoring for URL change OR significant DOM mutations.
   * Resolves on EITHER condition to handle:
   * - Full page navigations (URL changes)
   * - SPA router transitions (URL + minor DOM changes)
   * - In-page wizard transitions (DOM-only, no URL change)
   */
  static async waitForURLChange(currentURL: string, timeout: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let observer: MutationObserver;
      let resolved = false;
      const initialChildrenCount = document.body.children.length;
      let mutationCount = 0;

      const startTime = Date.now();
      let accumulatedPauseTime = 0;
      let pauseStartTime = 0;

      const done = (result: boolean) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        if (result) {
          resolve(true);
        } else {
          reject(new Error(`URL change timeout after ${timeout}ms`));
        }
      };

      // Fallback polling for pushState/replaceState which don't fire events natively
      const pollInterval = setInterval(() => {
        const executor = getExecutionContext();
        if (executor && !executor.isRunning) {
          if (!resolved) {
            resolved = true;
            cleanup();
            reject(new Error("Execution aborted."));
          }
          return;
        }

        if (executor && executor.isPaused) {
          if (pauseStartTime === 0) {
            pauseStartTime = Date.now();
          }
          return;
        }

        if (pauseStartTime > 0) {
          accumulatedPauseTime += Date.now() - pauseStartTime;
          pauseStartTime = 0;
        }

        const elapsed = Date.now() - startTime - accumulatedPauseTime;
        if (elapsed >= timeout) {
          done(false);
          return;
        }

        if (window.location.href !== currentURL) {
          done(true);
        }
      }, 300);

      // BUG-AUDIT-FIX-7: Added isRunning abort guard — previously only the
      // 300ms poller checked for abort, creating a race window where event-driven
      // callbacks could resolve on an already-aborted execution.
      const checkURLChange = () => {
        const executor = getExecutionContext();
        if (executor && !executor.isRunning) {
          done(false);
          return;
        }
        if (executor && executor.isPaused) {
          return;
        }
        if (window.location.href !== currentURL) {
          done(true);
        }
      };

      const checkDOMMutation = () => {
        const executor = getExecutionContext();
        // BUG-AUDIT-FIX-7: Abort guard for event-driven DOM mutation callback
        if (executor && !executor.isRunning) {
          done(false);
          return;
        }
        if (executor && executor.isPaused) {
          return;
        }
        mutationCount++;
        
        // If URL changed, resolve immediately
        if (window.location.href !== currentURL) {
          done(true);
          return;
        }

        // Check for significant DOM body changes (section toggling, content replacement)
        const currentChildrenCount = document.body.children.length;
        const diff = Math.abs(currentChildrenCount - initialChildrenCount);
        const thresholdMet = initialChildrenCount === 0 || (diff / initialChildrenCount) > NAVIGATION_DOM_THRESHOLD;

        if (thresholdMet) {
          done(true);
          return;
        }
      };

      const cleanup = () => {
        if (observer) observer.disconnect();
        clearInterval(pollInterval);
        window.removeEventListener("popstate", checkURLChange);
        window.removeEventListener("hashchange", checkURLChange);
      };

      // Listen for URL changes
      window.addEventListener("popstate", checkURLChange);
      window.addEventListener("hashchange", checkURLChange);

      // Watch for DOM changes including subtree mutations (catches section toggling)
      observer = new MutationObserver(checkDOMMutation);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
  }

  /**
   * Waits for new <option> elements in a dependent select.
   */
  static async waitForSelectOptions(
    meta: SelectorMeta,
    selector: string,
    timeout: number
  ): Promise<boolean> {
    const result = await this.waitForElement(meta, selector, timeout);
    if (!result) return false;

    const selectEl = result.element as HTMLSelectElement;
    if (selectEl.options.length > 1) {
      return true; // Already loaded — no need for observer
    }

    const initialOptionsCount = selectEl.options.length;

    return new Promise((resolve) => {
      let timeoutTimer: ReturnType<typeof setTimeout>;
      const observer = new MutationObserver(() => {
        if (selectEl.options.length > initialOptionsCount || selectEl.options.length > 1) {
          cleanup();
          resolve(true);
        }
      });

      const cleanup = () => {
        observer.disconnect();
        clearTimeout(timeoutTimer);
      };

      observer.observe(selectEl, { childList: true, subtree: true });

      // If already has options (maybe loaded before we checked)
      if (selectEl.options.length > initialOptionsCount || selectEl.options.length > 1) {
        cleanup();
        resolve(true);
      }

      timeoutTimer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeout);
    });
  }

  /**
   * Tracks network idle state. 
   * Note: A complete implementation in MV3 requires a main-world injected script
   * to proxy fetch/XHR. We provide the polling interface here.
   */
  static async waitForNetworkIdle(timeout: number = WAIT_NETWORK_IDLE_TIMEOUT): Promise<void> {
    // Wait for the ceiling unconditionally as a fallback or implement 
    // postMessage communication with an injected script.
    // For now, resolving after a short delay since we can't block indefinitely
    // without the proxy script active.
    return new Promise((resolve) => {
      // Listen for network idle messages from the injected script
      const listener = (event: MessageEvent) => {
        // BUG-AUDIT-09 fix: validate both source AND origin to prevent forged
        // FORMPILOT_NETWORK_IDLE messages from cross-origin scripts in the page.
        if (event.source !== window || !event.data) return;
        const expectedOrigin = window.location.origin === "null" ? "*" : window.location.origin;
        if (expectedOrigin !== "*" && event.origin !== expectedOrigin) return;
        if (event.data.type === "FORMPILOT_NETWORK_IDLE") {
          clearTimeout(ceilingTimer);
          window.removeEventListener("message", listener);
          resolve();
        }
      };
      window.addEventListener("message", listener);

      const ceilingTimer = setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve();
      }, Math.min(timeout, NETWORK_IDLE_CEILING));
    });
  }

  /**
   * Public wrapper around the internal poll loop, exposed so other engines/adapters
   * (e.g. DatePickerEngine's click-based calendar adapters) can wait on arbitrary
   * custom conditions — appearance of a popup, a header label changing after a click,
   * a day cell becoming available — while remaining aware of pause/abort state,
   * exactly like every other wait in this class.
   */
  static async waitForCondition<T>(conditionFn: () => T | null, timeout: number): Promise<T> {
    return this.pollForCondition(conditionFn, timeout);
  }

  /**
   * Helper method to poll with exponential backoff.
   */
  private static async pollForCondition<T>(
    conditionFn: () => T | null,
    timeout: number
  ): Promise<T> {
    let startTime = Date.now();
    let pollInterval = POLL_INTERVAL_BASE;
    let pauseStart: number | null = null;

    return new Promise((resolve, reject) => {
      const check = () => {
        const executor = getExecutionContext();
        if (executor && !executor.isRunning) {
          reject(new Error("Execution aborted."));
          return;
        }

        if (executor && executor.isPaused) {
          if (pauseStart === null) {
            pauseStart = Date.now();
          }
          setTimeout(check, pollInterval);
          return;
        }

        if (pauseStart !== null) {
          startTime += Date.now() - pauseStart;
          pauseStart = null;
        }

        const result = conditionFn();
        if (result !== null && result !== undefined) {
          resolve(result);
          return;
        }

        if (Date.now() - startTime >= timeout) {
          reject(new Error(`Timeout of ${timeout}ms exceeded`));
          return;
        }

        setTimeout(check, pollInterval);
        // Exponential backoff, capped at 1000ms
        pollInterval = Math.min(pollInterval * 1.5, 1000);
      };

      check();
    });
  }
}
