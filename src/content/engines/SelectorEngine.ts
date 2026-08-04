import { SelectorMeta, SelectorResult, SelectorStrategy } from "../../types";
import { SHADOW_TRAVERSAL_LIMIT, MIN_SELECTOR_CONFIDENCE } from "../../shared/constants";

/**
 * 8-strategy fallback Selector Engine
 */
export class SelectorEngine {
  /**
   * Tries to find an element using the 8-strategy fallback pipeline.
   * Returns the best match that exceeds the confidence threshold, or null if none found.
   */
  static findElement(meta: SelectorMeta, selector: string): SelectorResult | null {
    let bestResult: SelectorResult | null = null;

    const evaluateResult = (result: SelectorResult | null) => {
      if (result && result.confidence >= MIN_SELECTOR_CONFIDENCE) {
        if (!bestResult || result.confidence > bestResult.confidence) {
          bestResult = result;
        }
      }
    };

    // 1. ID (1.0 confidence — but only if truly unique on the page)
    if (meta.id) {
      const el = document.getElementById(meta.id);
      if (el) {
        // BUG-AUDIT-FIX-1: Verify the ID is truly unique before assigning 1.0 confidence.
        // Duplicate IDs are surprisingly common on dynamic sites (e.g. list item templates).
        let idIsUnique = true;
        try {
          idIsUnique = document.querySelectorAll(`#${CSS.escape(meta.id)}`).length === 1;
        } catch {
          // Malformed ID that CSS.escape can't handle — treat as non-unique
          idIsUnique = false;
        }
        const confidence = idIsUnique ? 1.0 : 0.5;
        evaluateResult({ element: el, strategy: SelectorStrategy.ID, confidence, shadow: false });
      }
    }

    // 2. Name (0.95 confidence) - only use if unique to prevent false matches in checkbox/radio groups
    if (meta.name) {
      const elements = Array.from(document.querySelectorAll(`[name="${CSS.escape(meta.name)}"]`));
      if (elements.length === 1) {
        evaluateResult({ element: elements[0], strategy: SelectorStrategy.NAME, confidence: 0.95, shadow: false });
      }
    }

    // 3. Aria-label (0.9 confidence)
    if (meta.ariaLabel) {
      const el = document.querySelector(`[aria-label="${CSS.escape(meta.ariaLabel)}"]`);
      if (el) evaluateResult({ element: el, strategy: SelectorStrategy.ARIA_LABEL, confidence: 0.9, shadow: false });
    }

    // 4. Label-linked (0.85 confidence for explicit/nested, 0.80 for proximity/sibling)
    if (meta.labelText) {
      const labels = Array.from(document.querySelectorAll("label, .form-label, .control-label, strong, b"));
      const matchingLabel = labels.find((l) => l.textContent?.trim() === meta.labelText);
      if (matchingLabel) {
        // 4a. Explicit 'for' link
        const targetId = matchingLabel.getAttribute("for");
        if (targetId) {
          const el = document.getElementById(targetId);
          if (el) evaluateResult({ element: el, strategy: SelectorStrategy.LABEL_LINKED, confidence: 0.85, shadow: false });
        }
        
        // 4b. Nested input inside label
        const nestedInput = matchingLabel.querySelector("input, select, textarea");
        if (nestedInput) {
          evaluateResult({ element: nestedInput, strategy: SelectorStrategy.LABEL_LINKED, confidence: 0.85, shadow: false });
        }

        // 4c. Sibling/proximity input inside the same parent or container group
        let siblingInput = matchingLabel.parentElement?.querySelector("input, select, textarea") as HTMLElement | null;
        if (!siblingInput) {
          const container = matchingLabel.closest(".form-group, .col-md-6, .col-sm-6, .form-row, td, tr") || matchingLabel.parentElement?.parentElement;
          if (container) {
            siblingInput = container.querySelector("input, select, textarea") as HTMLElement | null;
          }
        }
        if (siblingInput) {
          evaluateResult({ element: siblingInput, strategy: SelectorStrategy.LABEL_LINKED, confidence: 0.80, shadow: false });
        }
      }
    }

    // 4.5. Button & Control Text Matching (0.88 confidence)
    if (meta.labelText || meta.ariaLabel) {
      const targetText = (meta.labelText || meta.ariaLabel || "").trim().toLowerCase();
      if (targetText && targetText.length < 50) {
        const candidateButtons = Array.from(
          document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit'], .btn")
        ) as HTMLElement[];

        const match = candidateButtons.find((btn) => {
          const btnText = (btn.textContent || btn.getAttribute("aria-label") || (btn as HTMLInputElement).value || "").trim().toLowerCase();
          return btnText === targetText;
        });

        if (match) {
          evaluateResult({ element: match, strategy: SelectorStrategy.LABEL_LINKED, confidence: 0.88, shadow: false });
        }
      }
    }

    // 5. Placeholder (0.8 confidence)
    if (meta.placeholder) {
      const el = document.querySelector(`[placeholder="${CSS.escape(meta.placeholder)}"]`);
      if (el) evaluateResult({ element: el, strategy: SelectorStrategy.PLACEHOLDER, confidence: 0.8, shadow: false });
    }

    // 6. Primary CSS selector (0.7 confidence) - dynamic index paths are treated as fallback
    if (selector) {
      try {
        const el = document.querySelector(selector);
        if (el) evaluateResult({ element: el, strategy: SelectorStrategy.CSS_PATH, confidence: 0.7, shadow: false });
      } catch (e) {
        // ignore invalid selector
      }
    }

    // 7. XPath (0.4 confidence) - fragile path fallback
    if (meta.xpath) {
      try {
        const result = document.evaluate(
          meta.xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        if (result.singleNodeValue) {
          evaluateResult({
            element: result.singleNodeValue as Element,
            strategy: SelectorStrategy.XPATH,
            confidence: 0.4,
            shadow: false,
          });
        }
      } catch (e) {
        // ignore invalid xpath
      }
    }

    // 8. Shadow DOM (0.6 confidence)
    const shadowMatch = this.findInShadowDOM(meta, selector);
    if (shadowMatch) {
      evaluateResult(shadowMatch);
    }

    return bestResult;
  }

  private static findInShadowDOM(
    meta: SelectorMeta,
    primarySelector: string
  ): SelectorResult | null {
    let elementsChecked = 0;
    let foundElement: Element | null = null;
    let bestShadowConfidence = 0;

    // Evaluate match confidence for Shadow DOM elements
    const evaluateShadowMatch = (el: Element): number => {
      if (meta.id && el.id === meta.id) {
        return 1.0;
      }
      if (meta.name && el.getAttribute("name") === meta.name) {
        return 0.95;
      }
      if (meta.ariaLabel && el.getAttribute("aria-label") === meta.ariaLabel) {
        return 0.9;
      }
      if (meta.placeholder && el.getAttribute("placeholder") === meta.placeholder) {
        return 0.8;
      }
      if (primarySelector) {
        try {
          if (el.matches(primarySelector)) {
            return 0.75;
          }
        } catch {
          // Invalid primary selectors are ignored
        }
      }
      return 0;
    };

    const walkTree = (root: Node): void => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let current = walker.nextNode();

      while (current && elementsChecked < SHADOW_TRAVERSAL_LIMIT && !foundElement) {
        const el = current as Element;
        elementsChecked++;

        if (el.shadowRoot) {
          const shadowWalker = document.createTreeWalker(el.shadowRoot, NodeFilter.SHOW_ELEMENT);
          let sCurrent = shadowWalker.nextNode();
          while (sCurrent && !foundElement) {
            const sEl = sCurrent as Element;
            const conf = evaluateShadowMatch(sEl);
            if (conf > 0) {
              foundElement = sEl;
              bestShadowConfidence = conf;
              break;
            }
            if (sEl.shadowRoot) {
              walkTree(sEl.shadowRoot);
            }
            sCurrent = shadowWalker.nextNode();
          }
        }

        current = walker.nextNode();
      }
    };

    walkTree(document.body || document.documentElement);

    if (foundElement) {
      return {
        element: foundElement,
        strategy: SelectorStrategy.SHADOW_DOM,
        confidence: bestShadowConfidence || 0.6,
        shadow: true,
      };
    }

    return null;
  }
}
