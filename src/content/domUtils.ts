import { InputNormalizer } from "./datepickers/InputNormalizer";

/**
 * Utility functions for DOM manipulation, focusing on React-safe event dispatching.
 */

/**
 * Dispatches a sequence of events to simulate a user action.
 */
export function dispatchEvents(
  element: Element,
  eventTypes: string[],
  eventInit?: EventInit | KeyboardEventInit | MouseEventInit
): void {
  eventTypes.forEach((type) => {
    let event;
    if (type.startsWith("mouse") || type === "click") {
      event = new MouseEvent(type, {
        view: window,
        bubbles: true,
        cancelable: true,
        buttons: 1,
        ...(eventInit as MouseEventInit),
      });
    } else if (type.startsWith("key")) {
      event = new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        ...(eventInit as KeyboardEventInit),
      });
    } else if (type === "input") {
      // React 16/17/18 requires InputEvent (not generic Event) to trigger
      // its synthetic onChange handler via delegated event listeners.
      if (typeof InputEvent === "function") {
        event = new InputEvent(type, {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
        });
      } else {
        // Fallback for environments where InputEvent is unavailable (e.g., minimal JSDOM)
        event = new Event(type, {
          bubbles: true,
          cancelable: true,
        });
      }
    } else {
      event = new Event(type, {
        bubbles: true,
        cancelable: true,
      });
    }
    element.dispatchEvent(event);
  });
}

/**
 * Sets the value of a checkbox element, bypassing React's value setter overloads.
 */
export function setCheckboxValue(input: HTMLInputElement, checked: boolean): void {
  const nativeCheckboxValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "checked"
  )?.set;

  const setVal = (val: boolean) => {
    if (nativeCheckboxValueSetter) {
      nativeCheckboxValueSetter.call(input, val);
    } else {
      input.checked = val;
    }
  };

  setVal(checked);
  dispatchEvents(input, ["change", "input"]);
}

/**
 * Sets the value of an input element, bypassing React's value setter overloads.
 * This is crucial for filling out React/Vue controlled forms.
 */
export function setInputValue(input: HTMLInputElement, value: string): void {
  const finalValue = InputNormalizer.normalizeForInput(input, value);

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, finalValue);
  } else {
    input.value = finalValue;
  }
  dispatchEvents(input, ["input", "change"]);
}
import { DropdownMatcher, MatchResult } from "./engines/DropdownMatcher";

/**
 * Sets the value of a select element using the DropdownMatcher pipeline, bypassing React's value setter overloads.
 * Returns the MatchResult for logging by the execution engine, or null if no selection was made.
 */
export function setSelectValue(select: HTMLSelectElement, value: string): MatchResult | null {
  const matchResult = DropdownMatcher.match(select, value);
  
  if (!matchResult.option) {
    return null; // Ambiguous or no match found
  }

  const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value"
  )?.set;

  if (nativeSelectValueSetter) {
    nativeSelectValueSetter.call(select, matchResult.option.value);
  } else {
    select.value = matchResult.option.value;
  }
  dispatchEvents(select, ["input", "change"]);
  
  return matchResult;
}

/**
 * Sets the value of a textarea element, bypassing React's value setter overloads.
 */
export function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;

  if (nativeTextareaValueSetter) {
    nativeTextareaValueSetter.call(textarea, value);
  } else {
    textarea.value = value;
  }
  dispatchEvents(textarea, ["input", "change"]);
}
