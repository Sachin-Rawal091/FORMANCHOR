import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatePickerEngine } from "../src/content/datepickers/DatePickerEngine";
import { NativeDateStrategy } from "../src/content/datepickers/strategies/NativeDateStrategy";
import { FieldDetector } from "../src/content/datepickers/FieldDetector";
import { DateParser } from "../src/content/datepickers/DateParser";

function makeVisible(el: HTMLElement, width = 120, height = 40) {
  Object.defineProperty(el, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: height, configurable: true });
  el.getBoundingClientRect = () => ({
    x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height,
    toJSON: () => {},
  } as DOMRect);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

describe("Comprehensive Framework & Date-Range Diagnostic Matrix", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper to create mock popups for AntD
  function createAntDPopup(initialYear = 2026, initialMonth = 7) { // Aug 2026
    const container = document.createElement("div");
    container.className = "ant-picker";
    const input = document.createElement("input");
    input.className = "ant-picker-input";
    container.appendChild(input);
    document.body.appendChild(container);
    makeVisible(container);
    makeVisible(input);

    let curYear = initialYear;
    let curMonth = initialMonth;

    function renderPopup() {
      let popup = document.querySelector(".ant-picker-dropdown") as HTMLElement;
      if (!popup) {
        popup = document.createElement("div");
        popup.className = "ant-picker-dropdown";
        document.body.appendChild(popup);
      }
      makeVisible(popup);

      const mName = MONTH_NAMES[curMonth];
      popup.innerHTML = `
        <div class="ant-picker-header">
          <button class="ant-picker-header-super-prev-btn">&lt;&lt;</button>
          <button class="ant-picker-header-prev-btn">&lt;</button>
          <span class="ant-picker-header-view"><button class="ant-picker-year-btn">${curYear}</button> ${mName}</span>
          <button class="ant-picker-header-next-btn">&gt;</button>
          <button class="ant-picker-header-super-next-btn">&gt;&gt;</button>
        </div>
        <div class="ant-picker-body">
          ${Array.from({ length: 31 }, (_, i) => `<div class="ant-picker-cell ant-picker-cell-in-view"><div class="ant-picker-cell-inner">${i + 1}</div></div>`).join("")}
        </div>
      `;

      popup.querySelector(".ant-picker-header-view, .ant-picker-year-btn")?.addEventListener("click", () => {
        popup.innerHTML = `
          <div class="ant-picker-header-view">Year View</div>
          <div class="ant-picker-body">
            ${Array.from({ length: 250 }, (_, i) => `<div class="ant-picker-cell ant-picker-cell-in-view"><div class="ant-picker-cell-inner">${1926 + i}</div></div>`).join("")}
          </div>
        `;
        popup.querySelectorAll(".ant-picker-cell-inner").forEach((cell) => {
          cell.addEventListener("click", () => {
            curYear = parseInt(cell.textContent?.trim() || "2026", 10);
            renderPopup();
          });
        });
      });

      // Event handlers
      popup.querySelector(".ant-picker-header-prev-btn")?.addEventListener("click", () => {
        curMonth--;
        if (curMonth < 0) { curMonth = 11; curYear--; }
        renderPopup();
      });
      popup.querySelector(".ant-picker-header-next-btn")?.addEventListener("click", () => {
        curMonth++;
        if (curMonth > 11) { curMonth = 0; curYear++; }
        renderPopup();
      });
      popup.querySelector(".ant-picker-header-super-prev-btn")?.addEventListener("click", () => {
        curYear--;
        renderPopup();
      });
      popup.querySelector(".ant-picker-header-super-next-btn")?.addEventListener("click", () => {
        curYear++;
        renderPopup();
      });

      // Cell selection
      popup.querySelectorAll(".ant-picker-cell-inner").forEach((cell) => {
        cell.addEventListener("click", () => {
          const day = cell.textContent?.trim();
          input.value = `${String(day).padStart(2, '0')}/${String(curMonth + 1).padStart(2, '0')}/${curYear}`;
        });
      });
    }

    input.addEventListener("click", () => renderPopup());
    return input;
  }

  // Helper to create mock popups for MUI
  function createMuiPopup(initialYear = 2026, initialMonth = 7) {
    const container = document.createElement("div");
    container.className = "MuiFormControl-root";
    const input = document.createElement("input");
    input.className = "MuiInputBase-input";
    container.appendChild(input);
    document.body.appendChild(container);
    makeVisible(container);
    makeVisible(input);

    let curYear = initialYear;
    let curMonth = initialMonth;

    function renderPopup() {
      let popup = document.querySelector(".MuiPickersPopper-root") as HTMLElement;
      if (!popup) {
        popup = document.createElement("div");
        popup.className = "MuiPickersPopper-root";
        document.body.appendChild(popup);
      }
      makeVisible(popup);

      const mName = MONTH_NAMES[curMonth];
      popup.innerHTML = `
        <div class="MuiPickersCalendarHeader-label">${mName} ${curYear}</div>
        <button class="MuiPickersArrowSwitcher-button prev-btn">&lt;</button>
        <button class="MuiPickersArrowSwitcher-button next-btn">&gt;</button>
        <div class="MuiPickersDay-root-container">
          ${Array.from({ length: 31 }, (_, i) => `<div class="MuiPickersDay-root">${i + 1}</div>`).join("")}
        </div>
      `;

      popup.querySelector(".MuiPickersCalendarHeader-label")?.addEventListener("click", () => {
        popup.innerHTML = `
          <div class="MuiYearCalendar-root">
            ${Array.from({ length: 250 }, (_, i) => `<button class="MuiPickersYear-root">${1926 + i}</button>`).join("")}
          </div>
        `;
        popup.querySelectorAll(".MuiPickersYear-root").forEach((btn) => {
          btn.addEventListener("click", () => {
            curYear = parseInt(btn.textContent?.trim() || "2026", 10);
            renderPopup();
          });
        });
      });

      popup.querySelector(".prev-btn")?.addEventListener("click", () => {
        curMonth--;
        if (curMonth < 0) { curMonth = 11; curYear--; }
        renderPopup();
      });
      popup.querySelector(".next-btn")?.addEventListener("click", () => {
        curMonth++;
        if (curMonth > 11) { curMonth = 0; curYear++; }
        renderPopup();
      });

      popup.querySelectorAll(".MuiPickersDay-root").forEach((cell) => {
        cell.addEventListener("click", () => {
          const day = cell.textContent?.trim();
          input.value = `${String(curMonth + 1).padStart(2, '0')}/${String(day).padStart(2, '0')}/${curYear}`;
        });
      });
    }

    input.addEventListener("click", () => renderPopup());
    return input;
  }

  // Test matrix for AntD across gaps: 1, 2, 5, 10, 20, 30, 50, 100 years
  describe("AntD Framework Navigation Matrix across Gaps", () => {
    const yearGaps = [1, 2, 5, 10, 20, 30, 50, 100];

    yearGaps.forEach((gap) => {
      it(`AntD: should fill date with +${gap} year gap (Target Year: ${2026 + gap})`, async () => {
        const input = createAntDPopup(2026, 7);
        const targetYear = 2026 + gap;
        const dateStr = `15/08/${targetYear}`;

        const result = await DatePickerEngine.fill(input, dateStr);
        expect(result).toBe(true);
      });

      it(`AntD: should fill date with -${gap} year gap (Target Year: ${2026 - gap})`, async () => {
        const input = createAntDPopup(2026, 7);
        const targetYear = 2026 - gap;
        const dateStr = `15/08/${targetYear}`;

        const result = await DatePickerEngine.fill(input, dateStr);
        expect(result).toBe(true);
      });
    });
  });

  // Test matrix for MUI across gaps
  describe("MUI Framework Navigation Matrix across Gaps", () => {
    const yearGaps = [1, 2, 5, 10, 20, 30, 50, 100];

    yearGaps.forEach((gap) => {
      it(`MUI: should test fill date with +${gap} year gap (Target Year: ${2026 + gap})`, async () => {
        const input = createMuiPopup(2026, 7);
        const targetYear = 2026 + gap;
        const dateStr = `15/08/${targetYear}`;

        const result = await DatePickerEngine.fill(input, dateStr);
        expect(result).toBe(true);
      });
    });
  });

  // Test matrix for Date Types & Ambiguous Formats
  describe("Date Value Types & Format Parsing Matrix", () => {
    it("should correctly parse and differentiate ambiguous dates vs unambiguous dates", () => {
      // 08/24/2026 -> Unambiguous US (Month 8, Day 24)
      const res1 = DateParser.parse("08/24/2026");
      expect(res1.valid).toBe(true);
      expect(res1.month).toBe(8);
      expect(res1.day).toBe(24);

      // 24/08/2026 -> Unambiguous European (Day 24, Month 8)
      const res2 = DateParser.parse("24/08/2026");
      expect(res2.valid).toBe(true);
      expect(res2.month).toBe(8);
      expect(res2.day).toBe(24);

      // 08/04/2026 -> Ambiguous (both <= 12). Default behavior is Day-first (Day 8, Month 4 = April 8th)
      const res3 = DateParser.parse("08/04/2026");
      expect(res3.valid).toBe(true);
      expect(res3.day).toBe(8); // Parsed as Day 8!
      expect(res3.month).toBe(4); // Parsed as Month 4 (April)!
    });

    it("should handle Excel serial numbers cleanly without timezone corruption", () => {
      // 45127 corresponds to 2023-07-20
      const res = DateParser.parse(45127);
      expect(res.valid).toBe(true);
      expect(res.iso).toBe("2023-07-20");
      expect(res.year).toBe(2023);
      expect(res.month).toBe(7);
      expect(res.day).toBe(20);
    });

    it("should test Native HTML5 Date strategy with valid and invalid bounds", async () => {
      const input = document.createElement("input");
      input.type = "date";
      input.min = "2020-01-01";
      input.max = "2030-12-31";
      document.body.appendChild(input);

      const strategy = new NativeDateStrategy();
      const detection = FieldDetector.detect(input);

      const success = await strategy.execute(input, "2026-08-24", detection);
      expect(success).toBe(true);
      expect(input.value).toBe("2026-08-24");

      // Out of bounds test
      await expect(strategy.execute(input, "2035-01-01", detection)).rejects.toThrow();
    });
  });
});
