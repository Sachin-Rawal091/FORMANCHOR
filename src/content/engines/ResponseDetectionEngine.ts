import { MessageType, ExecutionStatus } from "../../types";
import { CAPTCHA_SOLVE_TIMEOUT, SHADOW_TRAVERSAL_LIMIT } from "../../shared/constants";
import { StateManager } from "./StateManager";

export class ResponseDetectionEngine {
  private static activeOverlay: HTMLDivElement | null = null;
  private static activeStyleEl: HTMLStyleElement | null = null;
  private static captchaTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private static countdownIntervalId: ReturnType<typeof setInterval> | null = null;

  private static activeCaptchaResolver: (() => void) | null = null;
  private static captchaResolutionPending = false;

  /**
   * Checks the DOM for CAPTCHA elements.
   */
  static detectCaptcha(): boolean {
    const captchaSelectors = [
      "#g-recaptcha",
      ".g-recaptcha",
      "iframe[src*='recaptcha']",
      "iframe[src*='hcaptcha']",
      "#hcaptcha-container",
      ".h-captcha",
      "iframe[src*='challenges.cloudflare']",
      "#cf-turnstile",
      ".cf-turnstile",
      "iframe[src*='arkoselabs']",
      ".geetest_wind"
    ];

    for (const selector of captchaSelectors) {
      if (document.querySelector(selector)) {
        return true;
      }
    }

    // Piercing shadow DOM to find CAPTCHA — only check inside actual shadow roots
    // (direct DOM was already checked above via document.querySelector)
    let shadowFound = false;
    let checkedCount = 0;
    const matchesCaptcha = (el: Element): boolean => {
      for (const selector of captchaSelectors) {
        try {
          if (el.matches(selector)) {
            return true;
          }
        } catch {
          // Ignore selector incompatibilities in unusual embedded contexts.
        }
      }
      return false;
    };

    const walkTree = (root: Node): void => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let current = walker.nextNode();

      while (current && checkedCount < SHADOW_TRAVERSAL_LIMIT && !shadowFound) {
        const el = current as Element;
        checkedCount++;

        if (matchesCaptcha(el)) {
          shadowFound = true;
          break;
        }

        if (el.shadowRoot) {
          walkTree(el.shadowRoot);
        }

        current = walker.nextNode();
      }
    };

    walkTree(document.body || document.documentElement);
    return shadowFound;
  }

  /**
   * Evaluates if a page submission was successful based on URL and page content.
   */
  static detectSuccess(currentUrl: string): boolean {
    const lowerUrl = currentUrl.toLowerCase();
    const successKeywords = ["success", "confirm", "thank", "done", "complete", "submitted", "received", "checkout/order", "receipt", "invoice"];
    
    // 1. URL pattern match
    const matchesUrl = successKeywords.some(kw => lowerUrl.includes(kw));
    if (matchesUrl) return true;

    // 2. DOM success elements — covers CSS class patterns, modals, overlays, toast UIs
    const successSelectors = [
      ".success",
      ".confirmation",
      "[data-success]",
      ".thank-you",
      "#thank-you",
      ".alert-success",
      ".alert-confirm",
      ".success-message",
      "h1.success-title",
      "div.success-banner",
      ".receipt-active",
      ".modal.show .success",
      "[data-status='success']",
      ".order-confirmation",
      ".submission-success",
      ".receipt-overlay",
      "#receipt-overlay",
      "#receipt",
      ".receipt"
    ];

    for (const selector of successSelectors) {
      if (document.querySelector(selector)) {
        return true;
      }
    }

    // 3. Text content scans (headings, overlays, modals, alerts)
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, .alert, .receipt-title, .modal-title, .toast-body"));
    const successTextRegex = /thank\s*you|submitted\s*successfully|order\s*complete|payment\s*received|confirmed|clearance\s*approved|approved|verification\s*complete|registered\s*successfully|receipt\s*generated/i;
    for (const heading of headings) {
      if (heading.textContent && successTextRegex.test(heading.textContent)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Checks for error validation summaries or toast errors.
   */
  static detectFailure(): boolean {
    const errorSelectors = [
      ".alert-danger",
      ".alert-error",
      ".validation-summary-errors",
      ".field-validation-error",
      ".invalid-feedback",
      ".error-message",
      "#error-summary"
    ];

    for (const selector of errorSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        // Only count as failure if the element is visible and has text content
        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && htmlEl.textContent?.trim()) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check for inline errors directly on or near the targeted element.
   */
  static detectInlineError(el: HTMLElement): string | null {
    // 1. Direct invalid states
    if (el.getAttribute("aria-invalid") === "true" || el.classList.contains("error") || el.classList.contains("invalid")) {
      return "Direct field error detected.";
    }

    // 2. Scan parent container and adjacent siblings (up to 2 levels)
    let container: HTMLElement | null = el;
    for (let depth = 0; depth < 2; depth++) {
      if (!container) break;
      
      const errors = container.querySelectorAll(".error, .invalid, .invalid-feedback, .error-message, [aria-invalid='true']");
      for (let i = 0; i < errors.length; i++) {
        const errorEl = errors[i] as HTMLElement;
        if (errorEl !== el && errorEl.textContent?.trim()) {
          return errorEl.textContent.trim();
        }
      }

      container = container.parentElement;
    }

    return null;
  }

  /**
   * Injects a floating Glassmorphic UI alerting user to solve CAPTCHA.
   */
  static injectCaptchaOverlay(
    onResume: () => void,
    onTimeout: () => void,
    initialRemainingTime = CAPTCHA_SOLVE_TIMEOUT
  ): void {
    if (this.activeOverlay || this.captchaResolutionPending) {
      return; // Already waiting for user
    }
    this.captchaResolutionPending = true;

    const wrappedOnResume = () => {
      this.captchaResolutionPending = false;
      onResume();
    };

    const wrappedOnTimeout = () => {
      this.captchaResolutionPending = false;
      onTimeout();
    };

    // Create container
    const container = document.createElement("div");
    container.id = "formpilot-captcha-overlay";
    container.style.position = "fixed";
    container.style.top = "20px";
    container.style.right = "20px";
    container.style.width = "340px";
    container.style.zIndex = "2147483647"; // Topmost
    container.style.fontFamily = "'Outfit', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
    container.style.backgroundColor = "rgba(17, 24, 39, 0.85)";
    container.style.backdropFilter = "blur(12px) saturate(180%)";
    (container.style as any).webkitBackdropFilter = "blur(12px) saturate(180%)";
    container.style.border = "1px solid rgba(255, 255, 255, 0.12)";
    container.style.borderRadius = "16px";
    container.style.boxShadow = "0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2)";
    container.style.padding = "20px";
    container.style.color = "#F9FAFB";
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "14px";
    container.style.animation = "fpSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1)";
    
    // Inject animation styles
    if (this.activeStyleEl) {
      this.activeStyleEl.remove();
    }
    const styleEl = document.createElement("style");
    styleEl.textContent = `
      @keyframes fpSlideIn {
        from { transform: translateY(-20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .fp-btn {
        background: linear-gradient(135deg, #10B981 0%, #059669 100%);
        color: white;
        border: none;
        padding: 10px 16px;
        border-radius: 8px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.1s ease, filter 0.2s ease;
        box-shadow: 0 4px 6px -1px rgba(16, 185, 129, 0.2);
      }
      .fp-btn:hover {
        filter: brightness(1.08);
      }
      .fp-btn:active {
        transform: scale(0.97);
      }
    `;
    document.head.appendChild(styleEl);
    this.activeStyleEl = styleEl;

    // Title
    const titleRow = document.createElement("div");
    titleRow.style.display = "flex";
    titleRow.style.alignItems = "center";
    titleRow.style.gap = "10px";
    
    const icon = document.createElement("div");
    icon.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 9V14M12 17.01L12.01 16.998M3.07 19H20.93C22.47 19 23.43 17.33 22.66 16L13.73 4C12.96 2.67 11.04 2.67 10.27 4L1.34 16C0.57 17.33 1.53 19 3.07 19Z" stroke="#EF4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    
    const titleText = document.createElement("span");
    titleText.innerText = "CAPTCHA Paused";
    titleText.style.fontWeight = "700";
    titleText.style.fontSize = "18px";
    titleText.style.color = "#EF4444";
    
    titleRow.appendChild(icon);
    titleRow.appendChild(titleText);
    container.appendChild(titleRow);

    // Description
    const desc = document.createElement("p");
    desc.innerText = "FormAnchor detected a CAPTCHA. Please solve it on the page and click 'Resume' below.";
    desc.style.fontSize = "13px";
    desc.style.lineHeight = "1.5";
    desc.style.margin = "0";
    desc.style.color = "#D1D5DB";
    container.appendChild(desc);

    // Timer UI
    const timerRow = document.createElement("div");
    timerRow.style.display = "flex";
    timerRow.style.justifyContent = "space-between";
    timerRow.style.alignItems = "center";
    timerRow.style.fontSize = "12px";
    timerRow.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
    timerRow.style.padding = "6px 12px";
    timerRow.style.borderRadius = "6px";
    
    const timerLabel = document.createElement("span");
    timerLabel.innerText = "Time to Solve:";
    timerLabel.style.color = "#9CA3AF";
    
    const timerVal = document.createElement("span");
    timerVal.id = "formpilot-captcha-timer";
    timerVal.innerText = "03:00";
    timerVal.style.fontWeight = "700";
    timerVal.style.color = "#FBBF24";

    timerRow.appendChild(timerLabel);
    timerRow.appendChild(timerVal);
    container.appendChild(timerRow);

    // Resume Button
    const btn = document.createElement("button");
    btn.className = "fp-btn";
    btn.innerText = "Resume Execution";
    
    btn.onclick = () => {
      this.removeCaptchaOverlay();
      wrappedOnResume();
    };
    container.appendChild(btn);

    document.body.appendChild(container);
    this.activeOverlay = container;

    // Time Management
    const startTime = Date.now();
    
    this.countdownIntervalId = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, initialRemainingTime - elapsed);
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      
      const timerValEl = document.getElementById("formpilot-captcha-timer");
      if (timerValEl) {
        timerValEl.innerText = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      }

      if (remaining <= 0) {
        this.removeCaptchaOverlay();
        wrappedOnTimeout();
      }
    }, 1000);
  }

  /**
   * Dismisses the CAPTCHA overlay and cleans up timers.
   */
  static removeCaptchaOverlay(): void {
    this.captchaResolutionPending = false;
    if (this.countdownIntervalId) {
      clearInterval(this.countdownIntervalId);
      this.countdownIntervalId = null;
    }
    if (this.captchaTimeoutId) {
      clearTimeout(this.captchaTimeoutId);
      this.captchaTimeoutId = null;
    }
    if (this.activeOverlay) {
      this.activeOverlay.remove();
      this.activeOverlay = null;
    }
    if (this.activeStyleEl) {
      this.activeStyleEl.remove();
      this.activeStyleEl = null;
    }
  }

  /**
   * Run full submission checks, handles CAPTCHA UX pausing if triggered.
   */
  static async runSubmissionDetection(
    currentUrl: string,
    sessionId: string
  ): Promise<"SUCCESS" | "FAILED" | "UNKNOWN"> {
    // 1. Detect CAPTCHA first
    const captchaResult = await this.handleCaptchaIfPresent(sessionId);
    if (captchaResult === "TIMEOUT") {
      return "FAILED";
    }

    if (this.detectSuccess(currentUrl)) {
      return "SUCCESS";
    }

    if (this.detectFailure()) {
      return "FAILED";
    }

    return "UNKNOWN";
  }

  /**
   * Pauses execution if a CAPTCHA is detected, waits for user to solve it.
   * Returns "SOLVED" if solved (or none found), "TIMEOUT" if user failed to solve it.
   */
  static async handleCaptchaIfPresent(sessionId: string): Promise<"SOLVED" | "TIMEOUT"> {
    if (!this.detectCaptcha()) {
      return "SOLVED";
    }

    // Pause state and trigger notification loop
    const state = await StateManager.getState();
    let remainingTime = CAPTCHA_SOLVE_TIMEOUT;
    let captchaStartTime = Date.now();

    if (state) {
      if (state.captchaPending && state.captchaStartTime) {
        // Resume/reload case: keep original start time
        captchaStartTime = state.captchaStartTime;
        const elapsed = Date.now() - captchaStartTime;
        remainingTime = Math.max(0, CAPTCHA_SOLVE_TIMEOUT - elapsed);
      }

      await StateManager.updateState({
        status: ExecutionStatus.CAPTCHA_PAUSED,
        captchaPending: true,
        captchaStartTime
      });

      // Send message to Service Worker for dynamic notification/badge updates
      chrome.runtime.sendMessage({
        type: MessageType.CAPTCHA_DETECTED,
        sessionId,
        payload: { timeLeft: Math.floor(remainingTime / 1000) },
        tabId: state.tabContext,
        timestamp: Date.now()
      });
    }

    return new Promise<"SOLVED" | "TIMEOUT">((resolve) => {
      const onResumeCallback = async () => {
        // User Resumed
        const stateAfter = await StateManager.getState();
        if (stateAfter) {
          await StateManager.updateState({
            status: ExecutionStatus.RUNNING,
            captchaPending: false
          });
        }
        this.activeCaptchaResolver = null;
        resolve("SOLVED");
      };

      this.activeCaptchaResolver = () => {
        this.removeCaptchaOverlay();
        onResumeCallback();
      };

      this.injectCaptchaOverlay(
        onResumeCallback,
        async () => {
          // Timeout reached
          const stateAfter = await StateManager.getState();
          if (stateAfter) {
            await StateManager.updateState({
              status: ExecutionStatus.RUNNING, // resume runner so it can record row failure
              captchaPending: false
            });
          }
          this.activeCaptchaResolver = null;
          resolve("TIMEOUT");
        },
        remainingTime
      );
    });
  }

  /**
   * Programmatically resolves the pending CAPTCHA promise, typically called via background message.
   */
  static forceResolveCaptcha(): void {
    if (this.activeCaptchaResolver) {
      this.activeCaptchaResolver();
    }
  }
}
