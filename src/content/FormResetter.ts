import { Step, MessageType } from "../types";
import { SmartWaitEngine } from "./engines/SmartWaitEngine";
import { SelectorEngine } from "./engines/SelectorEngine";
import { StateManager } from "./engines/StateManager";
import {
  POST_ROW_DELAY_MS,
  POST_DISMISS_RESET_WAIT_MS,
  FORM_READY_RETRY_STEP_MS,
  MODAL_DISMISS_CLICK_SETTLE_MS,
  MODAL_ESCAPE_SETTLE_MS,
  WAIT_DOM_STABLE_TIMEOUT
} from "../shared/constants";
import { logger } from "../utils/logger";

type SendMessageFn = (message: any, timeoutMs?: number) => Promise<any>;

/**
 * Loop D extraction (2026-07-20): owns the between-rows form reset sequence,
 * pulled out of Executor per FormPilot_Loop_D_Executor_Refactor_Plan_2026-07-20.md.
 * Pure DOM logic — the only external dependency is the message-sending
 * function, injected so this class doesn't need its own chrome.runtime
 * plumbing or duplicate Executor's timeout/retry handling.
 */
export class FormResetter {
  constructor(
    private readonly sendMessage: SendMessageFn,
    private readonly flushLogs?: () => Promise<void>
  ) {}

  // ─── FORM RESET BETWEEN ROWS ───────────────────────────────────────
  // After a successful submission, forms typically show a success modal,
  // toast, or redirect. This method dismisses success UI and resets the
  // form back to its initial state for the next row.
  // ─────────────────────────────────────────────────────────────────────

  async resetFormBetweenRows(recordingSteps: Step[], siteUrl: string, sessionId: string): Promise<void> {
    // 1. Wait briefly for any success modal/overlay or redirect to render
    await new Promise(r => setTimeout(r, POST_ROW_DELAY_MS));

    // 2. Check if current URL matches siteUrl (origin + pathname)
    let isSamePageUrl = true;
    if (siteUrl) {
      try {
        const currentUrlObj = new URL(window.location.href);
        const siteUrlObj = new URL(siteUrl);
        if (currentUrlObj.hostname !== siteUrlObj.hostname || currentUrlObj.pathname !== siteUrlObj.pathname) {
          isSamePageUrl = false;
        }
      } catch (e) {
        logger.warn('FormResetter', 'URL parsing failed during resetFormBetweenRows check:', e);
      }
    }

    // 3. If URL changed (e.g. redirected to /thank-you or /confirmation), skip in-page reset and navigate back immediately
    if (!isSamePageUrl) {
      logger.info('FormResetter', `Page navigated to ${window.location.pathname} after row completion. Redirecting back to start URL: ${siteUrl}`);
      return this.navigateToStartUrl(siteUrl, sessionId);
    }

    // 4. Try to dismiss success modals/overlays by clicking common buttons
    const dismissed = await this.dismissSuccessUI();

    if (dismissed) {
      // Wait for form to reset after dismissal and DOM to stabilize
      await new Promise(r => setTimeout(r, POST_DISMISS_RESET_WAIT_MS));
      await SmartWaitEngine.waitForDOMStability(WAIT_DOM_STABLE_TIMEOUT).catch((err) => {
        logger.debug('FormResetter', `Post-reset DOM stability wait timed out: ${err.message}`);
      });

      // Check if the first form element is now available — retry up to 3 times with increasing waits
      const firstStep = recordingSteps[0];
      if (firstStep) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const formReady = SelectorEngine.findElement(firstStep.selectorMeta, firstStep.selector);
          if (formReady) {
            // Also verify the element is actually visible (not hidden in an inactive section)
            const el = formReady.element as HTMLElement;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isBypass = el.tagName === "INPUT" &&
              ["checkbox", "radio", "file"].includes((el as HTMLInputElement).type?.toLowerCase());

            if (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              (isBypass || (rect.width > 0 && rect.height > 0))
            ) {
              // Verify no success overlay/modal is still active and blocking the screen
              const overlays = document.querySelectorAll(
                '.modal.show, .modal-backdrop, [class*="overlay"][class*="active"], #receipt-overlay.receipt-active'
              );
              const visibleOverlays = Array.from(overlays).filter(o => this.isElementVisible(o as HTMLElement));

              if (visibleOverlays.length > 0) {
                logger.debug('FormResetter', `Form element found, but success overlay/modal is still visible. Waiting...`);
              } else {
                logger.debug('FormResetter', `Form reset successful (attempt ${attempt + 1}), ready for next row.`);
                return;
              }
            }
          }
          // Wait progressively longer between checks (500ms, 1000ms, 1500ms)
          await new Promise(r => setTimeout(r, FORM_READY_RETRY_STEP_MS * (attempt + 1)));
        }
      } else {
        // No recorded steps to verify against, just proceed
        logger.debug('FormResetter', 'No first step to verify, proceeding.');
        return;
      }
    }

    // 5. Fallback: navigate to original siteUrl to get a clean form
    logger.info('FormResetter', 'In-page reset failed or form un-reset, navigating to start URL...');
    return this.navigateToStartUrl(siteUrl, sessionId);
  }

  private async navigateToStartUrl(siteUrl: string, sessionId: string): Promise<void> {
    const updatedState = await StateManager.updateState({ currentUrl: siteUrl });
    if (updatedState) {
      await this.sendMessage({
        type: MessageType.SET_EXECUTION_STATE,
        payload: { state: updatedState },
        sessionId,
        timestamp: Date.now()
      }, 5000).catch(() => {});
    }

    if (siteUrl && window.location.href !== siteUrl) {
      if (this.flushLogs) await this.flushLogs();
      window.location.href = siteUrl;
    } else {
      logger.info('FormResetter', 'Already at start URL, reloading the page to reset form...');
      if (this.flushLogs) await this.flushLogs();
      window.location.reload();
    }
  }

  isElementVisible(el: HTMLElement): boolean {
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Attempts to dismiss success modals, overlays, toasts, and alerts by
   * finding and clicking common dismiss/close/ok/complete buttons.
   * BUG-004: Scoped to detected modal/overlay containers only to avoid
   * clicking active form buttons like "Next" or "Continue".
   * Returns true if a dismiss button was found and clicked.
   */
  async dismissSuccessUI(): Promise<boolean> {
    // Strategy 1: Look for visible modal/overlay containers first
    const modalContainerSelectors = [
      '.modal.show', '.modal.active', '.modal[style*="display: block"]',
      '.modal-backdrop + .modal', '[role="dialog"]', '.overlay.active',
      '.toast.show', '.alert.show', '.alert-success',
      '#receipt-overlay', '#receipt-overlay.receipt-active', '[class*="overlay"][class*="active"]',
      '.success-modal', '.confirmation-modal'
    ];

    let modalContainer: Element | null = null;
    for (const selector of modalContainerSelectors) {
      const el = document.querySelector(selector);
      if (el && this.isElementVisible(el as HTMLElement)) {
        modalContainer = el;
        break;
      }
    }

    // Strategy 2: If a modal container was found, look for dismiss buttons INSIDE it
    if (modalContainer) {
      // Safe dismiss keywords — intentionally exclude 'next', 'continue' which are
      // form navigation buttons that would advance the form prematurely
      const dismissKeywords = ['complete', 'finish', 'done', 'close', 'ok', 'dismiss', 'got it'];
      const buttons = Array.from(modalContainer.querySelectorAll('button, a.btn, [role="button"], input[type="button"]'));

      for (const btn of buttons) {
        const text = (btn as HTMLElement).textContent?.trim().toLowerCase() || '';
        const isVisible = this.isElementVisible(btn as HTMLElement);

        // Prevent partial word matches on short keywords (e.g. 'ok' matching 'book now')
        const matchesKeyword = dismissKeywords.some(kw => {
          if (kw.length <= 4) {
            const regex = new RegExp(`\\b${kw}\\b`, 'i');
            return regex.test(text);
          }
          return text.includes(kw);
        });

        if (isVisible && matchesKeyword) {
          logger.debug('FormResetter', `Clicking dismiss button in modal: "${(btn as HTMLElement).textContent?.trim()}"`);
          (btn as HTMLElement).click();
          await new Promise(r => setTimeout(r, MODAL_DISMISS_CLICK_SETTLE_MS));
          return true;
        }
      }

      // Try close button selectors within modal
      const closeSelectors = [
        '.btn-close', '[data-dismiss="modal"]', '[data-bs-dismiss="modal"]',
        '[aria-label="Close"]', '.close', '.modal-close'
      ];
      for (const selector of closeSelectors) {
        const el = modalContainer.querySelector(selector);
        if (el && this.isElementVisible(el as HTMLElement)) {
          logger.debug('FormResetter', `Clicking close selector in modal: ${selector}`);
          (el as HTMLElement).click();
          await new Promise(r => setTimeout(r, MODAL_DISMISS_CLICK_SETTLE_MS));
          return true;
        }
      }

      // Strategy 3: Try pressing Escape key to close modals
      modalContainer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, MODAL_ESCAPE_SETTLE_MS));
    }

    // Check if any modal/overlay was dismissed
    const overlays = document.querySelectorAll(
      '.modal.show, .modal-backdrop, [class*="overlay"][class*="active"], #receipt-overlay.receipt-active'
    );
    const visibleOverlays = Array.from(overlays).filter(el => this.isElementVisible(el as HTMLElement));
    if (visibleOverlays.length === 0) {
      return true; // No visible overlays, consider it dismissed
    }

    return false;
  }
}
