/**
 * Decoupled, pure date parsing, validation, formatting, and normalization utilities.
 */

export interface ParsedDate {
  valid: boolean;
  iso: string | null;            // "2026-07-14"
  day: number | null;            // 14
  month: number | null;          // 7 (1-indexed)
  year: number | null;           // 2026
  original: string;
  sourceFormat: string;          // "ISO" | "EXCEL_SERIAL" | "DD/MM/YYYY" | "MM/DD/YYYY" | "TEXT_LOCALIZED" | "UNKNOWN"
  isExcelSerial: boolean;
  error?: string;
}

const MONTH_NAME_MAP: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

export class DateParser {
  /**
   * Parses raw input string or Excel serial number into a structured ParsedDate object.
   */
  static parse(value: string | number | null | undefined, formatHint?: string): ParsedDate {
    const originalStr = value !== null && value !== undefined ? String(value).trim() : "";
    
    if (!originalStr) {
      return {
        valid: false,
        iso: null,
        day: null,
        month: null,
        year: null,
        original: "",
        sourceFormat: "UNKNOWN",
        isExcelSerial: false,
        error: "Empty date value",
      };
    }

    // 1. Excel Serial Number (e.g. 45127)
    if (typeof value === "number" || (/^\d{4,5}(\.\d+)?$/.test(originalStr) && !originalStr.includes("-") && !originalStr.includes("/")) ) {
      const serialNum = typeof value === "number" ? value : parseFloat(originalStr);
      if (!isNaN(serialNum) && serialNum > 0 && serialNum < 2958466) { // ~year 9999
        return this.parseExcelSerial(serialNum, originalStr);
      }
    }

    // 2. Standard ISO 8601 String (e.g. "2026-07-14" or "2026-07-14T10:30:00Z")
    const isoMatch = originalStr.match(/^(\d{4})[-/\.](0?[1-9]|1[0-2])[-/\.](0?[1-9]|[12]\d|3[01])(?:T|\s|$)/);
    if (isoMatch) {
      const year = parseInt(isoMatch[1], 10);
      const month = parseInt(isoMatch[2], 10);
      const day = parseInt(isoMatch[3], 10);
      return this.buildValidatedDate(year, month, day, originalStr, "ISO", false);
    }

    // 3. Localized Month Names (e.g. "14 Jul 2026", "July 14, 2026", "14-July-2026")
    const localizedResult = this.parseLocalizedName(originalStr);
    if (localizedResult) {
      return localizedResult;
    }

    // 4. Separator-based numeric format (DD/MM/YYYY or MM/DD/YYYY or YYYY/MM/DD)
    const cleanStr = originalStr.replace(/[^0-9\-/\.]/g, '').trim();
    let separator = '';
    if (cleanStr.includes('/')) separator = '/';
    else if (cleanStr.includes('-')) separator = '-';
    else if (cleanStr.includes('.')) separator = '.';

    if (separator) {
      const parts = cleanStr.split(separator).filter(Boolean);
      if (parts.length === 3) {
        const [p1, p2, p3] = parts.map(n => parseInt(n, 10));

        if (!isNaN(p1) && !isNaN(p2) && !isNaN(p3)) {
          // Case A: Year First (YYYY/MM/DD)
          if (parts[0].length === 4) {
            return this.buildValidatedDate(p1, p2, p3, originalStr, "YYYY/MM/DD", false);
          }

          // Case B: Year Last (DD/MM/YYYY or MM/DD/YYYY)
          if (parts[2].length === 4 || parts[2].length === 2) {
            const fullYear = parts[2].length === 2 ? 2000 + p3 : p3;

            if (p1 > 12) {
              // Unambiguous: p1 is Day (>12), p2 is Month
              return this.buildValidatedDate(fullYear, p2, p1, originalStr, "DD/MM/YYYY", false);
            } else if (p2 > 12) {
              // Unambiguous: p2 is Day (>12), p1 is Month
              return this.buildValidatedDate(fullYear, p1, p2, originalStr, "MM/DD/YYYY", false);
            } else {
              // Ambiguous (both <= 12, e.g. 03/04/2026): Check formatHint first
              if (formatHint && (formatHint.toUpperCase().startsWith("MM") || formatHint.toUpperCase().includes("MM/DD"))) {
                return this.buildValidatedDate(fullYear, p1, p2, originalStr, "MM/DD/YYYY", false);
              }
              // Default to DD/MM/YYYY (Day-first)
              return this.buildValidatedDate(fullYear, p2, p1, originalStr, "DD/MM/YYYY", false);
            }
          }
        }
      }
    }

    return {
      valid: false,
      iso: null,
      day: null,
      month: null,
      year: null,
      original: originalStr,
      sourceFormat: "UNKNOWN",
      isExcelSerial: false,
      error: `Unable to parse date string: "${originalStr}"`,
    };
  }

  /**
   * Excel serial date parser using Lotus 1-2-3 epoch (1899-12-30 UTC).
   */
  private static parseExcelSerial(serial: number, originalStr: string): ParsedDate {
    // Excel base date is Dec 30, 1899 due to 1900 leap year bug
    const excelEpoch = Date.UTC(1899, 11, 30);
    const msInDay = 24 * 60 * 60 * 1000;
    const targetMs = excelEpoch + Math.floor(serial) * msInDay;
    const dateObj = new Date(targetMs);

    if (isNaN(dateObj.getTime())) {
      return {
        valid: false,
        iso: null,
        day: null,
        month: null,
        year: null,
        original: originalStr,
        sourceFormat: "EXCEL_SERIAL",
        isExcelSerial: true,
        error: `Invalid Excel serial number: ${serial}`,
      };
    }

    const year = dateObj.getUTCFullYear();
    const month = dateObj.getUTCMonth() + 1;
    const day = dateObj.getUTCDate();

    return this.buildValidatedDate(year, month, day, originalStr, "EXCEL_SERIAL", true);
  }

  /**
   * Parses localized date strings like "14 Jul 2026", "July 14, 2026", "14-July-2026".
   */
  private static parseLocalizedName(originalStr: string): ParsedDate | null {
    const tokens = originalStr.toLowerCase().replace(/,/g, '').split(/[\s\-\/\.]+/).filter(Boolean);
    if (tokens.length !== 3) return null;

    let day: number | null = null;
    let month: number | null = null;
    let year: number | null = null;

    for (const token of tokens) {
      if (MONTH_NAME_MAP[token]) {
        month = MONTH_NAME_MAP[token];
      } else if (/^\d{4}$/.test(token)) {
        year = parseInt(token, 10);
      } else if (/^\d{1,2}$/.test(token)) {
        day = parseInt(token, 10);
      }
    }

    if (day !== null && month !== null && year !== null) {
      return this.buildValidatedDate(year, month, day, originalStr, "TEXT_LOCALIZED", false);
    }

    return null;
  }

  /**
   * Constructs a ParsedDate with strict calendar day bounds checking (e.g. rejecting 31/02/2026).
   */
  private static buildValidatedDate(
    year: number,
    month: number,
    day: number,
    originalStr: string,
    formatStr: string,
    isExcel: boolean
  ): ParsedDate {
    if (month < 1 || month > 12) {
      return {
        valid: false,
        iso: null,
        day,
        month,
        year,
        original: originalStr,
        sourceFormat: formatStr,
        isExcelSerial: isExcel,
        error: `Invalid month: ${month}`,
      };
    }

    const daysInMonth = this.getDaysInMonth(year, month);
    if (day < 1 || day > daysInMonth) {
      return {
        valid: false,
        iso: null,
        day,
        month,
        year,
        original: originalStr,
        sourceFormat: formatStr,
        isExcelSerial: isExcel,
        error: `Invalid day ${day} for month ${month} in year ${year} (max days: ${daysInMonth})`,
      };
    }

    const mmStr = String(month).padStart(2, '0');
    const ddStr = String(day).padStart(2, '0');
    const iso = `${year}-${mmStr}-${ddStr}`;

    return {
      valid: true,
      iso,
      day,
      month,
      year,
      original: originalStr,
      sourceFormat: formatStr,
      isExcelSerial: isExcel,
    };
  }

  /**
   * Returns the maximum days in a month, taking leap years into account.
   */
  private static getDaysInMonth(year: number, month: number): number {
    // Months 1, 3, 5, 7, 8, 10, 12 have 31 days
    if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31;
    // Months 4, 6, 9, 11 have 30 days
    if ([4, 6, 9, 11].includes(month)) return 30;
    // February
    if (month === 2) {
      const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
      return isLeapYear ? 29 : 28;
    }
    return 0;
  }

  /**
   * Checks whether a parsed date satisfies optional HTML min and max date constraints (ISO YYYY-MM-DD).
   */
  static validate(parsed: ParsedDate, minDate?: string | null, maxDate?: string | null): boolean {
    if (!parsed.valid || !parsed.iso) return false;

    if (minDate) {
      const parsedMin = this.parse(minDate);
      if (parsedMin.valid && parsedMin.iso && parsed.iso < parsedMin.iso) {
        return false;
      }
    }

    if (maxDate) {
      const parsedMax = this.parse(maxDate);
      if (parsedMax.valid && parsedMax.iso && parsed.iso > parsedMax.iso) {
        return false;
      }
    }

    return true;
  }

  /**
   * Formats a ParsedDate or JavaScript Date object to a target format string (e.g. "YYYY-MM-DD" or "DD/MM/YYYY" or sample format).
   */
  static format(input: ParsedDate | Date, targetFormat?: string): string {
    let year: number;
    let month: number;
    let day: number;

    if (input instanceof Date) {
      if (isNaN(input.getTime())) return "";
      const isUTC = input.getUTCHours() === 0 && input.getUTCMinutes() === 0 && input.getUTCMilliseconds() === 0;
      year = isUTC ? input.getUTCFullYear() : input.getFullYear();
      month = (isUTC ? input.getUTCMonth() : input.getMonth()) + 1;
      day = isUTC ? input.getUTCDate() : input.getDate();
    } else {
      if (!input.valid || input.day === null || input.month === null || input.year === null) {
        return input.original || "";
      }
      year = input.year;
      month = input.month;
      day = input.day;
    }

    const yyyy = String(year);
    const mm = String(month).padStart(2, '0');
    const m = String(month);
    const dd = String(day).padStart(2, '0');
    const d = String(day);

    if (!targetFormat || typeof targetFormat !== 'string') {
      return `${yyyy}-${mm}-${dd}`;
    }

    const formatUpper = targetFormat.toUpperCase();
    if (formatUpper === "YYYY-MM-DD" || formatUpper === "ISO") {
      return `${yyyy}-${mm}-${dd}`;
    }

    const sampleClean = targetFormat.replace(/[{}]/g, '').trim();
    if (/[a-zA-Z]/.test(sampleClean) && !sampleClean.includes('/') && !sampleClean.includes('-') && !sampleClean.includes('.')) {
      return `${yyyy}-${mm}-${dd}`;
    }

    let separator = '';
    if (sampleClean.includes('/')) separator = '/';
    else if (sampleClean.includes('-')) separator = '-';
    else if (sampleClean.includes('.')) separator = '.';

    if (!separator) {
      return `${yyyy}-${mm}-${dd}`;
    }

    const parts = sampleClean.split(separator);
    if (parts.length !== 3) {
      return `${yyyy}-${mm}-${dd}`;
    }

    // Year first: YYYY/MM/DD
    if (parts[0].length === 4) {
      const padMonth = parts[1].length === 2 || parts[1].toUpperCase() === "MM";
      const padDay = parts[2].length === 2 || parts[2].toUpperCase() === "DD";
      return `${yyyy}${separator}${padMonth ? mm : m}${separator}${padDay ? dd : d}`;
    }

    // Year last: DD/MM/YYYY or MM/DD/YYYY
    if (parts[2].length === 4) {
      const pad1 = parts[0].length === 2 || parts[0].toUpperCase().includes("D") || parts[0].toUpperCase().includes("M");
      const pad2 = parts[1].length === 2 || parts[1].toUpperCase().includes("D") || parts[1].toUpperCase().includes("M");
      const val1 = Number(parts[0]);
      const val2 = Number(parts[1]);

      if (!isNaN(val1) && val1 > 12) {
        return `${pad1 ? dd : d}${separator}${pad2 ? mm : m}${separator}${yyyy}`;
      } else if (!isNaN(val2) && val2 > 12) {
        return `${pad1 ? mm : m}${separator}${pad2 ? dd : d}${separator}${yyyy}`;
      }
      if (parts[0].toUpperCase().includes("M") || parts[1].toUpperCase().includes("D")) {
        return `${pad1 ? mm : m}${separator}${pad2 ? dd : d}${separator}${yyyy}`;
      }
      return `${pad1 ? dd : d}${separator}${pad2 ? mm : m}${separator}${yyyy}`;
    }

    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * Detects the date format template of a DOM input element by checking its value, placeholder, sibling inputs, or class fallbacks.
   */
  static detectElementDateFormat(el: HTMLElement): string | null {
    const targetInput = el instanceof HTMLInputElement ? el : el.querySelector("input");
    if (!(targetInput instanceof HTMLInputElement)) return null;

    const getFormatFromInput = (input: HTMLInputElement): string | null => {
      const attrValue = input.getAttribute('value') || input.value;
      if (attrValue && attrValue.trim() && !/[a-zA-Z]/.test(attrValue)) {
        const cleanVal = attrValue.trim();
        if (cleanVal.split(/[-/\.]/).length === 3) {
          return cleanVal;
        }
      }
      const placeholder = input.getAttribute('placeholder') || input.placeholder;
      if (placeholder && placeholder.trim()) {
        const cleanPlac = placeholder.replace(/[{}]/g, '').trim();
        if (cleanPlac.split(/[-/\.]/).length === 3) {
          return cleanPlac;
        }
      }
      return null;
    };

    const selfFormat = getFormatFromInput(targetInput);
    if (selfFormat) return selfFormat;

    const otherInputs = document.querySelectorAll('input.ant-picker-input, input.MuiInputBase-input, input.rmdp-input, input.datepicker, input.flatpickr-input, input[type="date"]') as NodeListOf<HTMLInputElement>;
    const limit = Math.min(otherInputs.length, 20);
    for (let i = 0; i < limit; i++) {
      const format = getFormatFromInput(otherInputs[i]);
      if (format) return format;
    }

    if (targetInput.classList.contains('rmdp-input') || targetInput.closest('.ant-picker')) {
      return "DD/MM/YYYY";
    }

    return null;
  }

  /**
   * Convenience helper to convert any valid date value into an ISO string ("YYYY-MM-DD").
   */
  static normalize(value: string | number | null | undefined): string | null {
    const parsed = this.parse(value);
    return parsed.valid ? parsed.iso : null;
  }

  /**
   * Pre-scans dataset column values across rows to infer whether the column uses DD/MM/YYYY or MM/DD/YYYY based on unambiguous entries (>12).
   */
  static inferColumnDateFormat(rows: Record<string, any>[], columnName: string): string | null {
    if (!rows || !rows.length || !columnName) return null;
    const targetCol = columnName.trim().toLowerCase();

    for (const row of rows) {
      const key = Object.keys(row).find(k => k.trim().toLowerCase() === targetCol);
      if (!key) continue;
      const raw = String(row[key] || '').trim();
      const parts = raw.split(/[-/\.]/).filter(Boolean).map(Number);
      if (parts.length === 3 && parts[2] > 1000) {
        if (parts[0] > 12 && parts[1] <= 12) {
          return "DD/MM/YYYY";
        }
        if (parts[1] > 12 && parts[0] <= 12) {
          return "MM/DD/YYYY";
        }
      }
    }
    return null;
  }
}

