import { SelectStrategy } from "./SelectStrategy";
import { dispatchEvents, setInputValue } from "../../domUtils";
import { SmartWaitEngine } from "../SmartWaitEngine";
import { logger } from "../../../utils/logger";

export class AntDSelectStrategy implements SelectStrategy {
  readonly name = "AntDSelectStrategy";

  matches(el: HTMLElement): boolean {
    return (
      el.closest(".ant-select") !== null ||
      (el.getAttribute("role") === "combobox" && el.getAttribute("aria-haspopup") === "listbox")
    );
  }

  async execute(el: HTMLElement, value: string): Promise<void> {
    const selectContainer = el.closest(".ant-select") as HTMLElement;
    const searchInput = (
      selectContainer?.querySelector(".ant-select-selection-search-input") || el
    ) as HTMLInputElement;

    // 1. Focus & click search input to open dropdown
    searchInput.focus();
    dispatchEvents(searchInput, ["focus", "focusin", "mousedown", "mouseup", "click"]);

    // 2. Type search filter text if input is typeable
    if (searchInput.tagName.toLowerCase() === "input") {
      setInputValue(searchInput, value);
      await new Promise((r) => setTimeout(r, 100)); // Allow React to digest keystrokes
    }

    // 3. Wait for AntD dropdown portal with options to appear
    const dropdown = await SmartWaitEngine.waitForCondition(() => {
      const dd = document.querySelector(
        ".ant-select-dropdown:not(.ant-select-dropdown-hidden)"
      );
      if (dd && dd.querySelector(".ant-select-item-option")) return dd as HTMLElement;
      return null;
    }, 3000).catch(() => null);

    if (!dropdown) {
      throw new Error(`AntD Select dropdown did not appear for value "${value}".`);
    }

    // 4. Match target option by text content: exact -> startsWith -> includes
    const options = Array.from(
      dropdown.querySelectorAll(".ant-select-item-option:not(.ant-select-item-option-disabled)")
    ) as HTMLElement[];

    const norm = value.trim().toLowerCase();
    const getText = (o: HTMLElement) =>
      (
        o.querySelector(".ant-select-item-option-content")?.textContent ||
        o.textContent ||
        ""
      )
        .trim()
        .toLowerCase();

    let matched =
      options.find((o) => getText(o) === norm) ||
      options.find((o) => getText(o).startsWith(norm)) ||
      options.find((o) => getText(o).includes(norm));

    if (!matched) {
      const available = options.map((o) => `"${getText(o)}"`).join(", ");
      throw new Error(
        `No matching option in AntD Select for "${value}". Available options: [${available}]`
      );
    }

    // 5. Click the matched option
    const matchedText = (
      matched.querySelector(".ant-select-item-option-content")?.textContent ||
      matched.textContent ||
      ""
    ).trim();
    logger.info("AntDSelectStrategy", `Clicking matched option: "${matchedText}"`);
    dispatchEvents(matched, ["mousedown", "mouseup", "click"]);

    // 6. Wait for DOM stability
    await SmartWaitEngine.waitForDOMStability(1000).catch(() => {});

    // 7. Verification: check displayed value in .ant-select-selection-item
    const selectionItem = selectContainer?.querySelector(".ant-select-selection-item");
    const displayedValue = selectionItem?.textContent?.trim() || "";

    if (displayedValue.toLowerCase() !== norm && !displayedValue.toLowerCase().includes(norm)) {
      logger.warn(
        "AntDSelectStrategy",
        `Selection verification warning. Expected: "${value}", Displayed: "${displayedValue}"`
      );
    } else {
      logger.info("AntDSelectStrategy", `Verified AntD Select selection: "${displayedValue}"`);
    }

    // 8. Blur input to release focus and clear .ant-select-focused blue outline
    try {
      searchInput.blur();
      dispatchEvents(searchInput, ["blur", "focusout"]);
    } catch (e) {
      // Ignore blur error
    }
  }
}
