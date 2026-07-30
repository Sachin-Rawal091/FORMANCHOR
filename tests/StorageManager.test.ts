import 'fake-indexeddb/auto';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupChromeMocks, resetChromeMocks } from './helpers/chromeMock';
import { StorageManager } from '../src/storage/StorageManager';
import { RowStatus } from '../src/types';

describe('StorageManager', () => {
  beforeEach(() => {
    setupChromeMocks();
  });
  afterEach(() => {
    resetChromeMocks();
  });

  describe('excelData encryption + chunked pagination', () => {
    it('should round-trip rows through encryption transparently via get/setExcelData', async () => {
      const rows = Array.from({ length: 5 }, (_, i) => ({
        rowIndex: i + 2,
        data: { Name: `Row ${i}`, Email: `row${i}@test.com` },
        status: RowStatus.PENDING,
        isValid: true,
        validationErrors: []
      }));

      await StorageManager.setExcelData(rows, true);
      const fetched = await StorageManager.getExcelData();

      expect(fetched).toHaveLength(5);
      expect(fetched[0].data.Name).toBe('Row 0');
      expect(fetched[4].data.Email).toBe('row4@test.com');
    });

    it('should paginate via afterRowIndex + limit using the real IDB rowIndex, not loop position', async () => {
      const rows = Array.from({ length: 12 }, (_, i) => ({
        rowIndex: i + 2, // Excel-row-number-based key, mirrors ExcelDataEngine's i+2 convention
        data: { n: i },
        status: RowStatus.PENDING,
        isValid: true,
        validationErrors: []
      }));
      await StorageManager.setExcelData(rows, true);

      const firstPage = await StorageManager.getExcelData(undefined, 5);
      expect(firstPage).toHaveLength(5);
      expect(firstPage[0].rowIndex).toBe(2);
      expect(firstPage[4].rowIndex).toBe(6);

      const lastRowIndexOfPage1 = firstPage[firstPage.length - 1].rowIndex;
      const secondPage = await StorageManager.getExcelData(lastRowIndexOfPage1, 5);
      expect(secondPage).toHaveLength(5);
      expect(secondPage[0].rowIndex).toBe(7);
    });

    it('should update a single row in place with updateOnly=true without clearing the rest', async () => {
      const rows = [
        { rowIndex: 2, data: { n: 0 }, status: RowStatus.PENDING, isValid: true, validationErrors: [] },
        { rowIndex: 3, data: { n: 1 }, status: RowStatus.PENDING, isValid: true, validationErrors: [] }
      ];
      await StorageManager.setExcelData(rows, true);

      await StorageManager.setExcelData(
        [{ rowIndex: 2, data: { n: 0 }, status: RowStatus.SUCCESS, isValid: true, validationErrors: [] }],
        false // clearFirst=false → merge, don't wipe
      );

      const fetched = await StorageManager.getExcelData();
      expect(fetched).toHaveLength(2);
      expect(fetched.find(r => r.rowIndex === 2)?.status).toBe(RowStatus.SUCCESS);
      expect(fetched.find(r => r.rowIndex === 3)?.status).toBe(RowStatus.PENDING);
    });

    it('getExcelDataCount should reflect the stored row count', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        rowIndex: i + 2, data: {}, status: RowStatus.PENDING, isValid: true, validationErrors: []
      }));
      await StorageManager.setExcelData(rows, true);
      expect(await StorageManager.getExcelDataCount()).toBe(3);
    });
  });

  describe('file blob encryption', () => {
    it('should round-trip a file blob through encryptBuffer/decryptBuffer', async () => {
      const content = new Blob(['%PDF-fake-content'], { type: 'application/pdf' });
      await StorageManager.addFileBlob({ alias: 'passport-scan', data: content, name: 'passport.pdf', type: 'application/pdf' });

      const fetched = await StorageManager.getFileBlob('passport-scan');
      expect(fetched).toBeDefined();
      expect(fetched?.name).toBe('passport.pdf');
      expect(fetched?.type).toBe('application/pdf');
      const text = await fetched?.data.text();
      expect(text).toBe('%PDF-fake-content');
    });

    it('should return undefined for an unknown alias rather than throwing', async () => {
      const fetched = await StorageManager.getFileBlob('does-not-exist');
      expect(fetched).toBeUndefined();
    });
  });

  describe('log retention', () => {
    it('cleanupLogs should delete entries older than logRetentionDays', async () => {
      await StorageManager.setUserSettings({ logRetentionDays: 30 } as any);
      
      const oldTime = Date.now() - (35 * 24 * 60 * 60 * 1000); // 35 days old
      const newTime = Date.now() - (5 * 24 * 60 * 60 * 1000);  // 5 days old

      await StorageManager.addLogEntries([
        { id: 'log-old', sessionId: 'sess-1', rowIndex: 0, stepId: 's', action: 0 as any, selector: 'x', result: 0 as any, status: 'FILLED', retryCount: 0, duration: 0, timestamp: oldTime } as any,
        { id: 'log-new', sessionId: 'sess-1', rowIndex: 1, stepId: 's', action: 0 as any, selector: 'x', result: 0 as any, status: 'FILLED', retryCount: 0, duration: 0, timestamp: newTime } as any
      ]);

      await StorageManager.cleanupLogs();
      const remaining = await StorageManager.getLogs('sess-1', 0, 100);
      
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe('log-new');
    });
  });
});
