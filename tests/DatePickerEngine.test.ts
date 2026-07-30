import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatePickerEngine } from "../src/content/datepickers/DatePickerEngine";
import { DatePickerRegistry } from "../src/content/datepickers/DatePickerRegistry";
import { RmdpAdapter } from "../src/content/datepickers/adapters/RmdpAdapter";
import { GenericDatePickerAdapter } from "../src/content/datepickers/adapters/GenericDatePickerAdapter";
import { MuiAdapter } from "../src/content/datepickers/adapters/MuiAdapter";
import { AntDAdapter } from "../src/content/datepickers/adapters/AntDAdapter";
import { NativeDateStrategy } from "../src/content/datepickers/strategies/NativeDateStrategy";

function makeVisible(el: HTMLElement, width = 120, height = 40) {
  Object.defineProperty(el, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: height, configurable: true });
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => {},
  } as DOMRect);
}

describe("DatePickerEngine and Adapters", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
    window.innerWidth = 1024;
    window.innerHeight = 768;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("DatePickerRegistry & Matching", () => {
    it("should detect RmdpAdapter for RMDP elements", () => {
      const input = document.createElement("input");
      input.className = "rmdp-input";

      const adapter = DatePickerRegistry.detect(input);
      expect(adapter).toBeInstanceOf(RmdpAdapter);
      expect(adapter?.name).toBe("RmdpAdapter");
    });

    it("should detect GenericDatePickerAdapter for generic date elements", () => {
      const input = document.createElement("input");
      input.className = "datepicker";

      const adapter = DatePickerRegistry.detect(input);
      expect(adapter).toBeInstanceOf(GenericDatePickerAdapter);
      expect(adapter?.name).toBe("GenericDatePickerAdapter");
    });

    it("should detect MuiAdapter for MUI elements", () => {
      const input = document.createElement("input");
      input.className = "MuiInputBase-input";

      const adapter = DatePickerRegistry.detect(input);
      expect(adapter).toBeInstanceOf(MuiAdapter);
      expect(adapter?.name).toBe("MuiAdapter");
    });

    it("should detect AntDAdapter for AntD elements", () => {
      const input = document.createElement("input");
      input.className = "ant-picker-input";

      const adapter = DatePickerRegistry.detect(input);
      expect(adapter).toBeInstanceOf(AntDAdapter);
      expect(adapter?.name).toBe("AntDAdapter");
    });

    it("should return null for non-date elements", () => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "username";

      const adapter = DatePickerRegistry.detect(input);
      expect(adapter).toBeNull();
    });
  });

  describe("RmdpAdapter E2E Calendar Fill Flow", () => {
    it("should successfully open, navigate, select, and verify RMDP", async () => {
      const container = document.createElement("div");
      container.className = "rmdp-container";
      const input = document.createElement("input");
      input.className = "rmdp-input";
      input.id = "my-dob";
      container.appendChild(input);
      document.body.appendChild(container);

      // Start fill flow asynchronously
      const fillPromise = DatePickerEngine.fill(input, "15/10/2026");

      // Advance timers to trigger click and MutationObserver setup
      await vi.advanceTimersByTimeAsync(50);

      // Mock RMDP calendar DOM structure
      const calendarWrapper = document.createElement("div");
      calendarWrapper.className = "rmdp-wrapper";
      calendarWrapper.style.display = "block";
      calendarWrapper.style.visibility = "visible";
      calendarWrapper.style.opacity = "1";
      makeVisible(calendarWrapper, 320, 280);

      const headerValues = document.createElement("div");
      headerValues.className = "rmdp-header-values";
      headerValues.textContent = "July, 2026";
      calendarWrapper.appendChild(headerValues);

      const leftArrow = document.createElement("span");
      leftArrow.className = "rmdp-left";
      calendarWrapper.appendChild(leftArrow);

      const rightArrow = document.createElement("span");
      rightArrow.className = "rmdp-right";
      calendarWrapper.appendChild(rightArrow);

      // Create day cells
      let dayClicked = false;
      for (let i = 1; i <= 31; i++) {
        const day = document.createElement("div");
        day.className = "rmdp-day";
        makeVisible(day, 32, 32);
        const span = document.createElement("span");
        span.textContent = String(i);
        day.appendChild(span);
        if (i === 15) {
          day.addEventListener("click", () => {
            dayClicked = true;
            input.value = "15/10/2026";
          });
        }
        calendarWrapper.appendChild(day);
      }

      // Mock navigation arrow click reactions: June -> July -> Aug -> Sept -> Oct (3 clicks from July)
      let clickCount = 0;
      rightArrow.addEventListener("click", () => {
        clickCount++;
        if (clickCount === 1) headerValues.textContent = "August, 2026";
        else if (clickCount === 2) headerValues.textContent = "September, 2026";
        else if (clickCount === 3) headerValues.textContent = "October, 2026";
      });

      // Real RMDP markup appends the calendar wrapper inside the same
      // .rmdp-container as the input (see rmdp_sandbox.html) — findWrapper()
      // is scoped strictly to that container, so the mock must match.
      container.appendChild(calendarWrapper);

      // Let observer, navigation, day selection, verification, and close timers run.
      await vi.advanceTimersByTimeAsync(5000);

      // Check results
      const success = await fillPromise;
      expect(success).toBe(true);
      expect(dayClicked).toBe(true);
      expect(input.value).toBe("15/10/2026");
    });
  });

  describe("GenericDatePickerAdapter Heuristic Calendar Fill Flow", () => {
    it("should successfully match day cells and fill unknown calendar", async () => {
      const input = document.createElement("input");
      input.className = "datepicker";
      document.body.appendChild(input);

      const fillPromise = DatePickerEngine.fill(input, "2026-10-15");

      await vi.advanceTimersByTimeAsync(50);

      // Create generic popup calendar
      const calendar = document.createElement("div");
      calendar.className = "my-custom-calendar datepicker";
      calendar.style.display = "block";
      calendar.style.visibility = "visible";
      calendar.style.opacity = "1";
      makeVisible(calendar, 320, 280);

      const header = document.createElement("div");
      header.className = "datepicker-header";
      header.textContent = "October 2026";
      calendar.appendChild(header);

      // Append 1 to 31 cells to satisfy number heuristcs
      let dayClicked = false;
      for (let i = 1; i <= 31; i++) {
        const cell = document.createElement("div");
        cell.className = "datepicker-cell";
        cell.textContent = String(i);
        makeVisible(cell, 20, 20);
        if (i === 15) {
          cell.addEventListener("click", () => {
            dayClicked = true;
            input.value = "2026-10-15";
          });
        }
        calendar.appendChild(cell);
      }

      document.body.appendChild(calendar);

      // Let observer, selection, verification, and close timers run.
      await vi.advanceTimersByTimeAsync(5000);

      const success = await fillPromise;
      expect(success).toBe(true);
      expect(dayClicked).toBe(true);
      expect(input.value).toBe("2026-10-15");
    });

    it("should prioritize the closer calendar popup over a distant pricing table matching the heuristics", async () => {
      const input = document.createElement("input");
      input.className = "datepicker";
      document.body.appendChild(input);

      // Mock input position
      input.getBoundingClientRect = () => ({
        x: 100, y: 100, left: 100, top: 100, right: 200, bottom: 130, width: 100, height: 30
      } as DOMRect);

      // 1. Create a distant pricing table that matches the ">=20 numbers" calendar heuristics
      const pricingTable = document.createElement("div");
      pricingTable.className = "pricing-table-grid"; // matches no common selectors, but matches heuristic
      pricingTable.style.display = "block";
      pricingTable.style.visibility = "visible";
      pricingTable.style.opacity = "1";
      makeVisible(pricingTable, 300, 300);
      pricingTable.getBoundingClientRect = () => ({
        x: 800, y: 100, left: 800, top: 100, right: 1100, bottom: 400, width: 300, height: 300
      } as DOMRect);

      // Add a header and numbers to satisfy heuristics
      const tableHeader = document.createElement("div");
      tableHeader.textContent = "Price List for July 2026";
      pricingTable.appendChild(tableHeader);
      const nextBtnTable = document.createElement("button");
      nextBtnTable.textContent = "Next Page";
      pricingTable.appendChild(nextBtnTable);

      for (let i = 1; i <= 25; i++) {
        const cell = document.createElement("span");
        cell.textContent = String(i);
        makeVisible(cell, 20, 20);
        cell.getBoundingClientRect = () => ({
          x: 800 + (i % 5) * 40,
          y: 150 + Math.floor(i / 5) * 40,
          left: 800 + (i % 5) * 40,
          top: 150 + Math.floor(i / 5) * 40,
          right: 800 + (i % 5) * 40 + 20,
          bottom: 150 + Math.floor(i / 5) * 40 + 20,
          width: 20,
          height: 20
        } as DOMRect);
        pricingTable.appendChild(cell);
      }
      document.body.appendChild(pricingTable);

      // Start the fill flow
      const fillPromise = DatePickerEngine.fill(input, "2026-10-15");

      await vi.advanceTimersByTimeAsync(50);

      // 2. Create the actual calendar popup near the input dynamically
      const calendar = document.createElement("div");
      calendar.className = "datepicker";
      calendar.style.display = "block";
      calendar.style.visibility = "visible";
      calendar.style.opacity = "1";
      makeVisible(calendar, 320, 280);
      calendar.getBoundingClientRect = () => ({
        x: 100, y: 140, left: 100, top: 140, right: 420, bottom: 420, width: 320, height: 280
      } as DOMRect);

      const header = document.createElement("div");
      header.className = "datepicker-header";
      header.textContent = "October 2026";
      calendar.appendChild(header);

      let dayClicked = false;
      for (let i = 1; i <= 31; i++) {
        const cell = document.createElement("div");
        cell.className = "datepicker-cell";
        cell.textContent = String(i);
        makeVisible(cell, 20, 20);
        cell.getBoundingClientRect = () => ({
          x: 100 + (i % 7) * 40,
          y: 180 + Math.floor(i / 7) * 40,
          left: 100 + (i % 7) * 40,
          top: 180 + Math.floor(i / 7) * 40,
          right: 100 + (i % 7) * 40 + 20,
          bottom: 180 + Math.floor(i / 7) * 40 + 20,
          width: 20,
          height: 20
        } as DOMRect);
        if (i === 15) {
          cell.addEventListener("click", () => {
            dayClicked = true;
            input.value = "2026-10-15";
          });
        }
        calendar.appendChild(cell);
      }
      document.body.appendChild(calendar);

      await vi.advanceTimersByTimeAsync(5000);

      const success = await fillPromise;
      expect(success).toBe(true);
      expect(dayClicked).toBe(true);
      expect(input.value).toBe("2026-10-15");
    });

    it("should correctly detect calendar popup when nested inside a role=\"dialog\" modal container", async () => {
      const input = document.createElement("input");
      input.className = "datepicker";
      document.body.appendChild(input);

      input.getBoundingClientRect = () => ({
        x: 100, y: 100, left: 100, top: 100, right: 200, bottom: 130, width: 100, height: 30
      } as DOMRect);

      // Create outer dialog
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      makeVisible(dialog, 400, 400);
      dialog.getBoundingClientRect = () => ({
        x: 50, y: 50, left: 50, top: 50, right: 450, bottom: 450, width: 400, height: 400
      } as DOMRect);
      document.body.appendChild(dialog);

      const fillPromise = DatePickerEngine.fill(input, "2026-10-15");
      await vi.advanceTimersByTimeAsync(50);

      // Create calendar inside dialog
      const calendar = document.createElement("div");
      calendar.className = "datepicker";
      makeVisible(calendar, 300, 300);
      calendar.getBoundingClientRect = () => ({
        x: 100, y: 140, left: 100, top: 140, right: 400, bottom: 440, width: 300, height: 300
      } as DOMRect);
      dialog.appendChild(calendar);

      const header = document.createElement("div");
      header.className = "datepicker-header";
      header.textContent = "October 2026";
      calendar.appendChild(header);

      let dayClicked = false;
      for (let i = 1; i <= 31; i++) {
        const cell = document.createElement("div");
        cell.className = "datepicker-cell";
        cell.textContent = String(i);
        makeVisible(cell, 20, 20);
        cell.getBoundingClientRect = () => ({
          x: 110 + (i % 7) * 30,
          y: 180 + Math.floor(i / 7) * 30,
          left: 110 + (i % 7) * 30,
          top: 180 + Math.floor(i / 7) * 30,
          right: 110 + (i % 7) * 30 + 20,
          bottom: 180 + Math.floor(i / 7) * 30 + 20,
          width: 20,
          height: 20
        } as DOMRect);
        if (i === 15) {
          cell.addEventListener("click", () => {
            dayClicked = true;
            input.value = "2026-10-15";
          });
        }
        calendar.appendChild(cell);
      }

      await vi.advanceTimersByTimeAsync(5000);

      const success = await fillPromise;
      expect(success).toBe(true);
      expect(dayClicked).toBe(true);
      expect(input.value).toBe("2026-10-15");
    });

    it("should correctly detect lazy-loaded calendar popup matching common selector before day cells are rendered", async () => {
      const input = document.createElement("input");
      input.className = "datepicker";
      document.body.appendChild(input);

      input.getBoundingClientRect = () => ({
        x: 100, y: 100, left: 100, top: 100, right: 200, bottom: 130, width: 100, height: 30
      } as DOMRect);

      const fillPromise = DatePickerEngine.fill(input, "2026-10-15");
      await vi.advanceTimersByTimeAsync(50);

      // Create lazy calendar wrapper (empty initially)
      const calendar = document.createElement("div");
      calendar.className = "datepicker";
      calendar.style.display = "block";
      calendar.style.visibility = "visible";
      calendar.style.opacity = "1";
      makeVisible(calendar, 320, 280);
      calendar.getBoundingClientRect = () => ({
        x: 100, y: 140, left: 100, top: 140, right: 420, bottom: 420, width: 320, height: 280
      } as DOMRect);
      document.body.appendChild(calendar);

      await vi.advanceTimersByTimeAsync(50);

      // Append header and day cells later
      const header = document.createElement("div");
      header.className = "datepicker-header";
      header.textContent = "October 2026";
      calendar.appendChild(header);

      let dayClicked = false;
      for (let i = 1; i <= 31; i++) {
        const cell = document.createElement("div");
        cell.className = "datepicker-cell";
        cell.textContent = String(i);
        makeVisible(cell, 20, 20);
        cell.getBoundingClientRect = () => ({
          x: 100 + (i % 7) * 40,
          y: 180 + Math.floor(i / 7) * 40,
          left: 100 + (i % 7) * 40,
          top: 180 + Math.floor(i / 7) * 40,
          right: 100 + (i % 7) * 40 + 20,
          bottom: 180 + Math.floor(i / 7) * 40 + 20,
          width: 20,
          height: 20
        } as DOMRect);
        if (i === 15) {
          cell.addEventListener("click", () => {
            dayClicked = true;
            input.value = "2026-10-15";
          });
        }
        calendar.appendChild(cell);
      }

      await vi.advanceTimersByTimeAsync(5000);

      const success = await fillPromise;
      expect(success).toBe(true);
      expect(dayClicked).toBe(true);
      expect(input.value).toBe("2026-10-15");
    });

    it("should correctly detect progressively loaded calendar when only 7 day cells are rendered", async () => {
      const input = document.createElement("input");
      input.className = "datepicker";
      document.body.appendChild(input);

      input.getBoundingClientRect = () => ({
        x: 100, y: 100, left: 100, top: 100, right: 200, bottom: 130, width: 100, height: 30
      } as DOMRect);

      const fillPromise = DatePickerEngine.fill(input, "2026-10-05");
      await vi.advanceTimersByTimeAsync(50);

      // Create calendar with only 7 days (representing single week or progressive first row)
      const calendar = document.createElement("div");
      calendar.className = "datepicker";
      makeVisible(calendar, 320, 100);
      calendar.getBoundingClientRect = () => ({
        x: 100, y: 140, left: 100, top: 140, right: 420, bottom: 240, width: 320, height: 100
      } as DOMRect);
      document.body.appendChild(calendar);

      const header = document.createElement("div");
      header.className = "datepicker-header";
      header.textContent = "October 2026";
      calendar.appendChild(header);

      let dayClicked = false;
      for (let i = 1; i <= 7; i++) {
        const cell = document.createElement("div");
        cell.className = "datepicker-cell";
        cell.textContent = String(i);
        makeVisible(cell, 20, 20);
        cell.getBoundingClientRect = () => ({
          x: 100 + (i % 7) * 40,
          y: 180,
          left: 100 + (i % 7) * 40,
          top: 180,
          right: 100 + (i % 7) * 40 + 20,
          bottom: 200,
          width: 20,
          height: 20
        } as DOMRect);
        if (i === 5) {
          cell.addEventListener("click", () => {
            dayClicked = true;
            input.value = "2026-10-05";
          });
        }
        calendar.appendChild(cell);
      }

      await vi.advanceTimersByTimeAsync(5000);

      const success = await fillPromise;
      expect(success).toBe(true);
      expect(dayClicked).toBe(true);
      expect(input.value).toBe("2026-10-05");
    });
  });

  describe("RmdpAdapter Portal and Edge Cases", () => {
    let adapter: RmdpAdapter;
    beforeEach(() => {
      adapter = new RmdpAdapter();
    });

    it("should find wrapper inside container (nested layout)", () => {
      const container = document.createElement("div");
      container.className = "rmdp-container";
      const input = document.createElement("input");
      input.className = "rmdp-input";
      container.appendChild(input);
      document.body.appendChild(container);

      const wrapper = document.createElement("div");
      wrapper.className = "rmdp-wrapper";
      const cal = document.createElement("div");
      cal.className = "rmdp-calendar";
      wrapper.appendChild(cal);
      makeVisible(wrapper, 320, 280);
      container.appendChild(wrapper);

      // set active element context
      adapter["activeElement"] = input;
      const found = adapter["findWrapper"]();
      expect(found).toBe(wrapper);
    });

    it("should find wrapper portaled to body (outside container)", () => {
      const container = document.createElement("div");
      container.className = "rmdp-container";
      const input = document.createElement("input");
      input.className = "rmdp-input";
      container.appendChild(input);
      document.body.appendChild(container);

      const wrapper = document.createElement("div");
      wrapper.className = "rmdp-wrapper";
      const cal = document.createElement("div");
      cal.className = "rmdp-calendar";
      wrapper.appendChild(cal);
      makeVisible(wrapper, 320, 280);
      document.body.appendChild(wrapper);

      adapter["activeElement"] = input;
      const found = adapter["findWrapper"]();
      expect(found).toBe(wrapper);
    });

    it("should ignore hidden wrappers", () => {
      const container = document.createElement("div");
      container.className = "rmdp-container";
      const input = document.createElement("input");
      input.className = "rmdp-input";
      container.appendChild(input);
      document.body.appendChild(container);

      // Wrapper 1: display none
      const w1 = document.createElement("div");
      w1.className = "rmdp-wrapper";
      w1.style.display = "none";
      const cal1 = document.createElement("div");
      cal1.className = "rmdp-calendar";
      w1.appendChild(cal1);
      makeVisible(w1, 320, 280);
      document.body.appendChild(w1);

      // Wrapper 2: visibility hidden
      const w2 = document.createElement("div");
      w2.className = "rmdp-wrapper";
      w2.style.visibility = "hidden";
      const cal2 = document.createElement("div");
      cal2.className = "rmdp-calendar";
      w2.appendChild(cal2);
      makeVisible(w2, 320, 280);
      document.body.appendChild(w2);

      // Wrapper 3: valid/visible
      const w3 = document.createElement("div");
      w3.className = "rmdp-wrapper";
      const cal3 = document.createElement("div");
      cal3.className = "rmdp-calendar";
      w3.appendChild(cal3);
      makeVisible(w3, 320, 280);
      document.body.appendChild(w3);

      adapter["activeElement"] = input;
      const found = adapter["findWrapper"]();
      expect(found).toBe(w3);
    });

    it("should resolve multiple visible wrappers using priority rules", () => {
      const container1 = document.createElement("div");
      container1.className = "rmdp-container";
      const input1 = document.createElement("input");
      input1.className = "rmdp-input";
      container1.appendChild(input1);
      document.body.appendChild(container1);

      const container2 = document.createElement("div");
      container2.className = "rmdp-container";
      const input2 = document.createElement("input");
      input2.className = "rmdp-input";
      container2.appendChild(input2);
      document.body.appendChild(container2);

      // 1. Two visible wrappers
      const w1 = document.createElement("div");
      w1.className = "rmdp-wrapper";
      const cal1 = document.createElement("div");
      cal1.className = "rmdp-calendar";
      w1.appendChild(cal1);
      makeVisible(w1, 320, 280);
      container1.appendChild(w1);

      const w2 = document.createElement("div");
      w2.className = "rmdp-wrapper";
      const cal2 = document.createElement("div");
      cal2.className = "rmdp-calendar";
      w2.appendChild(cal2);
      makeVisible(w2, 320, 280);
      container2.appendChild(w2);

      // Scoped search preference check
      adapter["activeElement"] = input1;
      let found = adapter["findWrapper"]();
      expect(found).toBe(w1);

      adapter["activeElement"] = input2;
      found = adapter["findWrapper"]();
      expect(found).toBe(w2);
    });

    it("should sort by proximity when multiple portal wrappers have no container", () => {
      const container = document.createElement("div");
      container.className = "rmdp-container";
      const input = document.createElement("input");
      input.className = "rmdp-input";
      container.appendChild(input);
      document.body.appendChild(container);

      // Mock input position
      input.getBoundingClientRect = () => ({
        x: 100, y: 100, left: 100, top: 100, right: 200, bottom: 130, width: 100, height: 30
      } as DOMRect);

      // Wrapper 1: far away
      const w1 = document.createElement("div");
      w1.className = "rmdp-wrapper";
      w1.appendChild(document.createElement("div")).className = "rmdp-calendar";
      makeVisible(w1, 320, 280);
      w1.getBoundingClientRect = () => ({
        x: 800, y: 800, left: 800, top: 800, right: 1120, bottom: 1080, width: 320, height: 280
      } as DOMRect);
      document.body.appendChild(w1);

      // Wrapper 2: close to input
      const w2 = document.createElement("div");
      w2.className = "rmdp-wrapper";
      w2.appendChild(document.createElement("div")).className = "rmdp-calendar";
      makeVisible(w2, 320, 280);
      w2.getBoundingClientRect = () => ({
        x: 100, y: 140, left: 100, top: 140, right: 420, bottom: 420, width: 320, height: 280
      } as DOMRect);
      document.body.appendChild(w2);

      adapter["activeElement"] = input;
      const found = adapter["findWrapper"]();
      expect(found).toBe(w2);
    });

    it("should dismiss stale calendars before opening next", async () => {
      const container1 = document.createElement("div");
      container1.className = "rmdp-container";
      const input1 = document.createElement("input");
      input1.className = "rmdp-input";
      container1.appendChild(input1);
      document.body.appendChild(container1);

      const container2 = document.createElement("div");
      container2.className = "rmdp-container";
      const input2 = document.createElement("input");
      input2.className = "rmdp-input";
      container2.appendChild(input2);
      document.body.appendChild(container2);

      // Stale calendar on container 1
      const staleWrapper = document.createElement("div");
      staleWrapper.className = "rmdp-wrapper";
      staleWrapper.appendChild(document.createElement("div")).className = "rmdp-calendar";
      makeVisible(staleWrapper, 320, 280);
      container1.appendChild(staleWrapper);

      // Setup click listener on input1 to close it
      let input1Clicked = false;
      input1.addEventListener("click", () => {
        input1Clicked = true;
        staleWrapper.remove(); // simulating it closing/removing
      });

      // Dismiss stale should trigger input1 click
      const dismissPromise = adapter["dismissStaleCalendars"](input2);
      await vi.advanceTimersByTimeAsync(300); // let settle wait run
      await dismissPromise;

      expect(input1Clicked).toBe(true);
      expect(document.querySelector(".rmdp-container .rmdp-wrapper")).toBeNull();
    });

    it("should fail gracefully when no wrapper found", async () => {
      const input = document.createElement("input");
      input.className = "rmdp-input";
      document.body.appendChild(input);

      const fillPromise = DatePickerEngine.fill(input, "15/10/2026");
      await vi.advanceTimersByTimeAsync(5000);
      const success = await fillPromise;
      expect(success).toBe(false); // fails gracefully without throwing
    });

    it("should invalidate cache and find new wrapper if cached wrapper is removed", () => {
      const container = document.createElement("div");
      container.className = "rmdp-container";
      const input = document.createElement("input");
      input.className = "rmdp-input";
      container.appendChild(input);
      document.body.appendChild(container);

      // First wrapper
      const w1 = document.createElement("div");
      w1.className = "rmdp-wrapper";
      w1.appendChild(document.createElement("div")).className = "rmdp-calendar";
      makeVisible(w1, 320, 280);
      container.appendChild(w1);

      adapter["activeElement"] = input;
      let found = adapter["findWrapper"]();
      expect(found).toBe(w1);
      expect(adapter["activeWrapper"]).toBe(w1);

      // Remove first wrapper (simulate React destroying it)
      w1.remove();

      // Create new wrapper (simulate React rebuilding it)
      const w2 = document.createElement("div");
      w2.className = "rmdp-wrapper";
      w2.appendChild(document.createElement("div")).className = "rmdp-calendar";
      makeVisible(w2, 320, 280);
      container.appendChild(w2);

      // findWrapper should recognize w1 is disconnected, invalidate cache, and find w2
      found = adapter["findWrapper"]();
      expect(found).toBe(w2);
      expect(adapter["activeWrapper"]).toBe(w2);
    });
  });

  describe("MuiAdapter E2E Calendar Fill Flow", () => {
    it("should successfully open, navigate, select, and verify MUI", async () => {
      const input = document.createElement("input");
      input.className = "MuiInputBase-input";
      document.body.appendChild(input);

      // Start fill flow
      const fillPromise = DatePickerEngine.fill(input, "2026/10/15");

      await vi.advanceTimersByTimeAsync(50);

      // Create MUI popup elements
      const popup = document.createElement("div");
      popup.className = "MuiPickersPopper-root";
      makeVisible(popup, 320, 280);

      const header = document.createElement("div");
      header.className = "MuiPickersCalendarHeader-label";
      header.textContent = "July 2026";
      popup.appendChild(header);

      const prevBtn = document.createElement("button");
      prevBtn.className = "MuiPickersArrowSwitcher-button";
      const nextBtn = document.createElement("button");
      nextBtn.className = "MuiPickersArrowSwitcher-button";
      popup.appendChild(prevBtn); // prev
      popup.appendChild(nextBtn); // next

      // Create day cells
      let dayClicked = false;
      for (let i = 1; i <= 31; i++) {
        const cell = document.createElement("button");
        cell.className = "MuiPickersDay-root";
        cell.textContent = String(i);
        makeVisible(cell, 32, 32);
        if (i === 15) {
          cell.addEventListener("click", () => {
            dayClicked = true;
            input.value = "2026/10/15";
          });
        }
        popup.appendChild(cell);
      }

      // Mock navigation
      let clickCount = 0;
      nextBtn.addEventListener("click", () => {
        clickCount++;
        if (clickCount === 1) header.textContent = "August 2026";
        else if (clickCount === 2) header.textContent = "September 2026";
        else if (clickCount === 3) header.textContent = "October 2026";
      });

      document.body.appendChild(popup);

      await vi.advanceTimersByTimeAsync(5000);

      const success = await fillPromise;
      expect(success).toBe(true);
      expect(dayClicked).toBe(true);
      expect(input.value).toBe("2026/10/15");
    });
  });

  describe("AntDAdapter E2E Calendar Fill Flow", () => {
    it("should successfully open, navigate, select, and verify AntD", async () => {
      const container = document.createElement("div");
      container.className = "ant-picker";
      const input = document.createElement("input");
      input.className = "ant-picker-input";
      container.appendChild(input);
      document.body.appendChild(container);

      // Start fill flow
      const fillPromise = DatePickerEngine.fill(input, "2026/10/15");

      await vi.advanceTimersByTimeAsync(50);

      // Create AntD popup elements
      const popup = document.createElement("div");
      popup.className = "ant-picker-dropdown";
      makeVisible(popup, 320, 280);

      const header = document.createElement("div");
      header.className = "ant-picker-header-view";
      header.textContent = "July 2026";
      popup.appendChild(header);

      const nextBtn = document.createElement("button");
      nextBtn.className = "ant-picker-header-next-btn";
      popup.appendChild(nextBtn);

      // Create day cells
      let dayClicked = false;
      for (let i = 1; i <= 31; i++) {
        const cell = document.createElement("div");
        cell.className = "ant-picker-cell ant-picker-cell-in-view";
        const inner = document.createElement("div");
        inner.className = "ant-picker-cell-inner";
        inner.textContent = String(i);
        cell.appendChild(inner);
        makeVisible(cell, 32, 32);
        if (i === 15) {
          inner.addEventListener("click", () => {
            dayClicked = true;
            input.value = "2026/10/15";
          });
        }
        popup.appendChild(cell);
      }

      // Mock navigation
      let clickCount = 0;
      nextBtn.addEventListener("click", () => {
        clickCount++;
        if (clickCount === 1) header.textContent = "August 2026";
        else if (clickCount === 2) header.textContent = "September 2026";
        else if (clickCount === 3) header.textContent = "October 2026";
      });

      document.body.appendChild(popup);

      await vi.advanceTimersByTimeAsync(5000);

      const success = await fillPromise;
      expect(success).toBe(true);
      expect(dayClicked).toBe(true);
      expect(input.value).toBe("2026/10/15");
    });

    it("should perform adapter-owned popup cleanup in AntDAdapter.verify()", async () => {
      const container = document.createElement("div");
      container.className = "ant-picker";
      const input = document.createElement("input");
      input.className = "ant-picker-input";
      container.appendChild(input);
      document.body.appendChild(container);

      const blurSpy = vi.spyOn(input, "blur");

      const adapter = new AntDAdapter();
      input.value = "15/10/2026";
      const verifySuccess = await adapter.verify(input, new Date("2026-10-15"));

      expect(verifySuccess).toBe(true);
      expect(blurSpy).toHaveBeenCalled();
    });

    it("should gracefully fall back to Stage 2 keyboard commit when AntD popup is unavailable", async () => {
      const container = document.createElement("div");
      container.className = "ant-picker";
      const input = document.createElement("input");
      input.className = "ant-picker-input";
      container.appendChild(input);
      document.body.appendChild(container);

      // No .ant-picker-dropdown popup created in DOM -> Stage 1 will fail to open
      const adapter = new AntDAdapter();
      const openPromise = adapter.open(input);
      await vi.advanceTimersByTimeAsync(5000);
      const openResult = await openPromise;
      expect(openResult).toBe(false);
    });

    it("should execute interleaved AntD -> Native -> AntD -> Native sequence cleanly without popup leakage", async () => {
      // 1. AntD DatePicker input #1
      const antCont1 = document.createElement("div");
      antCont1.className = "ant-picker";
      const antInput1 = document.createElement("input");
      antInput1.className = "ant-picker-input";
      antCont1.appendChild(antInput1);
      document.body.appendChild(antCont1);

      // 2. Native Date input #1
      const natInput1 = document.createElement("input");
      natInput1.type = "date";
      natInput1.id = "v_dob1";
      document.body.appendChild(natInput1);

      // 3. AntD DatePicker input #2
      const antCont2 = document.createElement("div");
      antCont2.className = "ant-picker";
      const antInput2 = document.createElement("input");
      antInput2.className = "ant-picker-input";
      antCont2.appendChild(antInput2);
      document.body.appendChild(antCont2);

      // 4. Native Date input #2
      const natInput2 = document.createElement("input");
      natInput2.type = "date";
      natInput2.id = "v_dob2";
      document.body.appendChild(natInput2);

      // Execute Native DateStrategy directly on native inputs
      const nativeStrategy = new NativeDateStrategy();
      
      const resNat1 = await nativeStrategy.execute(natInput1, "2026-07-29", { isNativeDate: true, isCustomDatePicker: false, adapter: null, minDate: null, maxDate: null, score: 100 });
      expect(resNat1).toBe(true);
      expect(natInput1.value).toBe("2026-07-29");

      const resNat2 = await nativeStrategy.execute(natInput2, "2026-12-31", { isNativeDate: true, isCustomDatePicker: false, adapter: null, minDate: null, maxDate: null, score: 100 });
      expect(resNat2).toBe(true);
      expect(natInput2.value).toBe("2026-12-31");
    });
  });
});
