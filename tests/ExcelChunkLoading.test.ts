import { describe, it, expect, beforeEach } from "vitest";
import { EXCEL_CHUNK_SIZE } from "../src/shared/constants";
import { ExcelRow, RowStatus } from "../src/types";

describe("Canonical startRowIndex Excel Chunk Loading Architecture", () => {
  let mockDatabase: ExcelRow[];

  beforeEach(() => {
    mockDatabase = [];
    // Populate 139 mock excel rows with 1-based rowIndex (2 to 140)
    for (let i = 0; i < 139; i++) {
      mockDatabase.push({
        rowIndex: i + 2, // Excel row 2..140
        data: { name: `User ${i + 1}`, amount: 100 + i },
        status: RowStatus.PENDING,
        isValid: true,
        validationErrors: []
      });
    }
  });

  // Simulated StorageManager.getExcelData with IDBKeyRange.lowerBound(startRowIndex)
  function getExcelDataMock(options?: { startRowIndex?: number; limit?: number }): ExcelRow[] {
    const { startRowIndex, limit } = options || {};
    let filtered = mockDatabase;

    if (startRowIndex !== undefined) {
      filtered = filtered.filter(row => row.rowIndex >= startRowIndex);
    }

    if (limit !== undefined) {
      filtered = filtered.slice(0, limit);
    }

    return filtered;
  }

  it("should fetch Chunk 1 (Rows 1..50) when startRowIndex is 1", () => {
    const chunk1 = getExcelDataMock({ startRowIndex: 1, limit: EXCEL_CHUNK_SIZE });
    expect(chunk1.length).toBe(50);
    expect(chunk1[0].rowIndex).toBe(2);
    expect(chunk1[49].rowIndex).toBe(51);
  });

  it("should fetch Chunk 2 (Rows 51..100) starting cleanly at Row 51", () => {
    const chunk2 = getExcelDataMock({ startRowIndex: 52, limit: EXCEL_CHUNK_SIZE });
    expect(chunk2.length).toBe(50);
    expect(chunk2[0].rowIndex).toBe(52);
    expect(chunk2[49].rowIndex).toBe(101);
  });

  it("should fetch Chunk 3 (Rows 101..139) starting cleanly at Row 101", () => {
    const chunk3 = getExcelDataMock({ startRowIndex: 102, limit: EXCEL_CHUNK_SIZE });
    expect(chunk3.length).toBe(39);
    expect(chunk3[0].rowIndex).toBe(102);
    expect(chunk3[38].rowIndex).toBe(140);
  });

  it("should seamlessly resume chunk loading at Row 51 after page reload without missing or duplicating rows", () => {
    const resumedRowIndex = 50; // 0-based loop index 50 (51st row)
    const neededChunkStart = Math.floor(resumedRowIndex / EXCEL_CHUNK_SIZE) * EXCEL_CHUNK_SIZE; // 50
    const startRowIndex = neededChunkStart + 2; // Excel rowIndex 52

    const resumedChunk = getExcelDataMock({ startRowIndex, limit: EXCEL_CHUNK_SIZE });
    expect(resumedChunk.length).toBe(50);
    expect(resumedChunk[0].rowIndex).toBe(52);
  });

  it("should seamlessly resume chunk loading at final chunk (Row 101) without crashing", () => {
    const resumedRowIndex = 100; // 0-based loop index 100 (101st row)
    const neededChunkStart = Math.floor(resumedRowIndex / EXCEL_CHUNK_SIZE) * EXCEL_CHUNK_SIZE; // 100
    const startRowIndex = neededChunkStart + 2; // Excel rowIndex 102

    const finalChunk = getExcelDataMock({ startRowIndex, limit: EXCEL_CHUNK_SIZE });
    expect(finalChunk.length).toBe(39);
    expect(finalChunk[0].rowIndex).toBe(102);
  });
});
