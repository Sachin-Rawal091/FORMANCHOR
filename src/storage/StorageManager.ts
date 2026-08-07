import { getDB } from './db';
import { LOG_RETENTION_DAYS } from '../shared/constants';
import { 
  ExecutionState, 
  Recording, 
  UserSettings, 
  ExcelRow, 
  LogEntry, 
  SessionMeta,
  FileBlob,
  RecordingState,
  MessageType
} from '../types';
import { sendToBackground } from '../shared/messages';
import { sanitizeLogText } from '../utils/sanitize';
import { logger } from '../utils/logger';
import { encryptValue, decryptValue, encryptBuffer, decryptBuffer } from '../utils/crypto';

export function isContentScript(): boolean {
  return typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime && !chrome.tabs;
}

class StorageManagerImpl {
  static sequenceCounter = Date.now();
  
  async initStorage(): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage?.session?.setAccessLevel) {
      try {
        await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
      } catch (err) {
        logger.debug('StorageManager', 'Failed to set session storage access level:', err);
      }
    }
  }

  // --- Session Storage (Volatile, per-session) ---
  async getExecutionState(): Promise<ExecutionState | null> {
    if (isContentScript()) {
      const response = await sendToBackground({
        type: MessageType.GET_EXECUTION_STATE,
        payload: {},
        sessionId: "",
        timestamp: Date.now()
      });
      return response ? (response as any).state : null;
    }
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      const data = await chrome.storage.session.get('executionState');
      return (data.executionState as ExecutionState) || null;
    }
    return null;
  }

  async setExecutionState(state: ExecutionState): Promise<void> {
    if (isContentScript()) {
      await sendToBackground({
        type: MessageType.SET_EXECUTION_STATE,
        payload: { state },
        sessionId: "",
        timestamp: Date.now()
      });
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      if (state === null) {
        await chrome.storage.session.remove('executionState');
      } else {
        await chrome.storage.session.set({ executionState: state });
      }
    }
  }

  async clearExecutionState(): Promise<void> {
    if (isContentScript()) {
      await sendToBackground({
        type: MessageType.SET_EXECUTION_STATE,
        payload: { state: null },
        sessionId: "",
        timestamp: Date.now()
      });
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      await chrome.storage.session.remove('executionState');
    }
  }

  async getRecordingState(): Promise<RecordingState | null> {
    if (isContentScript()) {
      const response = await sendToBackground({
        type: MessageType.GET_STATUS,
        payload: {},
        sessionId: "",
        timestamp: Date.now()
      });
      return response ? (response as any).recordingState : null;
    }
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      const data = await chrome.storage.session.get('recordingState');
      const state = (data.recordingState as RecordingState) || null;
      if (!state || !state.isRecording) {
        if (chrome.storage.local) {
          await chrome.storage.local.set({ isRecordingActive: false });
        }
      }
      return state;
    }
    return null;
  }

  async setRecordingState(state: RecordingState): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const isActive = !!(state && state.isRecording);
      await chrome.storage.local.set({ isRecordingActive: isActive });
    }
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      await chrome.storage.session.set({ recordingState: state });
    }
  }

  async clearRecordingState(): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ isRecordingActive: false });
    }
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      await chrome.storage.session.remove('recordingState');
    }
  }


  // --- Local Storage (Persistent, 10MB cap) ---
  async getUserSettings(): Promise<UserSettings | null> {
    const data = await chrome.storage.local.get('settings');
    return data.settings || null;
  }

  async setUserSettings(settings: UserSettings): Promise<void> {
    await chrome.storage.local.set({ settings });
  }
  
  // --- IndexedDB (Persistent, unlimited) ---
  
  async getRecordings(): Promise<Recording[]> {
    const db = await getDB();
    return db.getAll('recordings');
  }

  async setRecordings(recordings: Recording[]): Promise<void> {
    const db = await getDB();
    const tx = db.transaction('recordings', 'readwrite');
    await tx.objectStore('recordings').clear();
    for (const recording of recordings) {
      tx.objectStore('recordings').put(recording);
    }
    await tx.done;
  }

  async getExcelData(options?: { startRowIndex?: number; afterRowIndex?: number; limit?: number } | number, limitParam?: number): Promise<ExcelRow[]> {
    let startRowIndex: number | undefined;
    let limit: number | undefined;

    if (typeof options === "object" && options !== null) {
      startRowIndex = options.startRowIndex !== undefined ? options.startRowIndex : (options.afterRowIndex !== undefined ? options.afterRowIndex + 1 : undefined);
      limit = options.limit;
    } else {
      startRowIndex = options !== undefined ? options + 1 : undefined;
      limit = limitParam;
    }

    if (isContentScript()) {
      const response = await sendToBackground({
        type: MessageType.GET_EXCEL_DATA,
        payload: { startRowIndex, limit },
        sessionId: "",
        timestamp: Date.now()
      });
      return response ? (response as any).excelRows || [] : [];
    }
    const db = await getDB();
    const tx = db.transaction('excelData', 'readonly');
    const store = tx.objectStore('excelData');

    let encryptedRows: any[] = [];
    if (limit !== undefined) {
      const range = startRowIndex !== undefined ? IDBKeyRange.lowerBound(startRowIndex) : null;
      let cursor = await store.openCursor(range);

      while (cursor && encryptedRows.length < limit) {
        encryptedRows.push(cursor.value);
        cursor = await cursor.continue();
      }
    } else if (startRowIndex !== undefined) {
      const range = IDBKeyRange.lowerBound(startRowIndex);
      let cursor = await store.openCursor(range);

      while (cursor) {
        encryptedRows.push(cursor.value);
        cursor = await cursor.continue();
      }
    } else {
      encryptedRows = await store.getAll();
    }

    const decryptedRows: ExcelRow[] = [];
    for (const row of encryptedRows) {
      if (row.encryptedBlob) {
        try {
          const decrypted = await decryptValue(row.encryptedBlob);
          decryptedRows.push({
            rowIndex: row.rowIndex,
            data: decrypted.data || (row as any).data || decrypted,
            status: decrypted.status || row.status,
            isValid: decrypted.isValid !== undefined ? decrypted.isValid : true,
            validationErrors: decrypted.validationErrors || [],
            error: decrypted.error
          });
        } catch (err) {
          logger.warn('StorageManager', `Failed to decrypt excel row ${row.rowIndex}, using fallback row data:`, err);
          if ((row as any).data) {
            decryptedRows.push(row);
          } else {
            throw err;
          }
        }
      } else {
        // Fallback for unencrypted legacy rows
        decryptedRows.push(row);
      }
    }
    return decryptedRows;
  }

  async getExcelDataCount(): Promise<number> {
    const db = await getDB();
    const tx = db.transaction('excelData', 'readonly');
    const store = tx.objectStore('excelData');
    return store.count();
  }

  async setExcelData(rows: ExcelRow[], clearFirst = true): Promise<void> {
    // Encrypt all rows BEFORE opening the transaction.
    // IDB transactions auto-close when the event loop has no pending IDB requests.
    // Awaiting crypto (encryptValue) inside the transaction causes it to finish
    // before the subsequent .put() calls, resulting in:
    // "Failed to execute 'objectStore' on 'IDBTransaction': The transaction has finished."
    const encryptedRows = await Promise.all(
      rows.map(async (row) => {
        let encryptedBlob;
        try {
          encryptedBlob = await encryptValue({
            data: row.data,
            status: row.status,
            isValid: row.isValid,
            validationErrors: row.validationErrors,
            error: row.error
          });
        } catch (e) {}
        
        return {
          rowIndex: row.rowIndex,
          data: row.data,
          status: row.status,
          isValid: row.isValid,
          validationErrors: row.validationErrors,
          error: row.error,
          encryptedBlob
        };
      })
    );

    const db = await getDB();
    const tx = db.transaction('excelData', 'readwrite');
    if (clearFirst) {
      await tx.objectStore('excelData').clear();
    }
    for (const record of encryptedRows) {
      tx.objectStore('excelData').put(record);
    }
    await tx.done;
  }

  async addLogEntries(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const db = await getDB();
    
    const tx = db.transaction('logs', 'readwrite');
    const store = tx.store;
    
    // Sort by batchIndex to preserve intra-batch order
    entries.sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0));
    
    const putPromises = entries.map((entry) => {
      const sanitizedEntry: LogEntry = {
        ...entry,
        value: sanitizeLogText(entry.value),
        error: sanitizeLogText(entry.error),
        sequence: ++StorageManagerImpl.sequenceCounter
      };
      return store.put(sanitizedEntry);
    });
    
    await Promise.all(putPromises);
    await tx.done;
  }

  async sweepPendingFallbackLogs(): Promise<void> {
    if (isContentScript()) return;
    
    const allKeys = await chrome.storage.local.get(null);
    const fallbackKeys = Object.keys(allKeys).filter(k => k.startsWith('__fp_pending_logs_'));
    if (fallbackKeys.length === 0) return;
    
    let entriesToRecover: LogEntry[] = [];
    for (const key of fallbackKeys) {
      const batch = allKeys[key];
      if (Array.isArray(batch)) {
        entriesToRecover = entriesToRecover.concat(batch);
      }
    }
    
    if (entriesToRecover.length > 0) {
      // Group by session ID to process correctly
      const bySession = entriesToRecover.reduce((acc, entry) => {
        const sid = entry.sessionId;
        if (!acc[sid]) acc[sid] = [];
        acc[sid].push(entry);
        return acc;
      }, {} as Record<string, LogEntry[]>);
      
      for (const sid of Object.keys(bySession)) {
        const sessionEntries = bySession[sid];
        // Sort by timestamp then batch index to reconstruct best possible order
        sessionEntries.sort((a, b) => {
          if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
          return (a.batchIndex || 0) - (b.batchIndex || 0);
        });
        await this.addLogEntries(sessionEntries);
      }
    }
    
    await chrome.storage.local.remove(fallbackKeys);
    logger.info('StorageManager', `Swept and recovered ${entriesToRecover.length} fallback logs from local storage across ${fallbackKeys.length} batches.`);
  }

  async cleanupLogs(): Promise<void> {
    if (isContentScript()) {
      return; // Cleanup is managed by the background script side
    }
    const db = await getDB();
    
    // Read limits from settings OUTSIDE of the transaction
    const settings = await this.getUserSettings();
    const retentionDays = settings?.logRetentionDays ?? LOG_RETENTION_DAYS;
    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

    const tx = db.transaction('logs', 'readwrite');
    const index = tx.store.index('timestamp');
    let cursor = await index.openCursor();
    
    while (cursor) {
      const log = cursor.value;
      
      if (log.timestamp < cutoffTime) {
        await cursor.delete();
        cursor = await cursor.continue();
      } else {
        // Since the index is sorted by timestamp ascending, once we hit a log
        // that is newer than cutoffTime, all subsequent logs are also newer.
        break;
      }
    }
    await tx.done;
  }

  async getLogs(sessionId: string, offset = 0, limit = 0): Promise<LogEntry[]> {
    await this.sweepPendingFallbackLogs();
    
    const db = await getDB();
    // 1. Fetch all for session to correctly sort by sequence since we may not have a sessionSequence index
    const tx = db.transaction('logs', 'readonly');
    const index = tx.store.index('sessionId');
    const allSessionLogs: LogEntry[] = [];
    let cursor = await index.openCursor(IDBKeyRange.only(sessionId));
    
    while (cursor) {
      allSessionLogs.push(cursor.value);
      cursor = await cursor.continue();
    }
    
    // Sort primarily by timestamp (ascending), then by sequence as tie-breaker
    // This perfectly matches exact chronological order even if sequence is assigned later
    allSessionLogs.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return (a.sequence || 0) - (b.sequence || 0);
    });
    
    // We sort ascending but want descending (most recent first) for getLogs, actually wait!
    // The previous implementation did: cursor = await index.openCursor(range, 'prev');
    // So getLogs expects descending (most recent first)!
    allSessionLogs.reverse();
    
    if (limit && limit > 0) {
      return allSessionLogs.slice(offset, offset + limit);
    }
    return offset > 0 ? allSessionLogs.slice(offset) : allSessionLogs;
  }

  async hasSessionFailures(sessionId: string): Promise<boolean> {
    const db = await getDB();
    const tx = db.transaction('logs', 'readonly');
    const index = tx.store.index('sessionId');
    let cursor = await index.openCursor(IDBKeyRange.only(sessionId));

    while (cursor) {
      const status = cursor.value.status;
      if (status === 'FAILED' || status === 'ROW_SKIPPED' || status === 'CAPTCHA_DETECTED') {
        return true;
      }
      cursor = await cursor.continue();
    }

    return false;
  }

  async addSessionMeta(meta: SessionMeta): Promise<void> {
    if (isContentScript()) {
      await sendToBackground({
        type: MessageType.ADD_SESSION_META,
        payload: { meta },
        sessionId: meta.sessionId,
        timestamp: Date.now()
      });
      return;
    }
    const db = await getDB();
    await db.put('sessions', meta);
    this.cleanupSessions().catch(err => logger.error('StorageManager', 'Session cleanup failed:', err));
  }

  async cleanupSessions(): Promise<void> {
    if (isContentScript()) {
      return;
    }
    const settings = await this.getUserSettings();
    const retentionDays = settings?.logRetentionDays ?? LOG_RETENTION_DAYS;
    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const db = await getDB();
    const tx = db.transaction('sessions', 'readwrite');
    const index = tx.store.index('timestamp');
    let cursor = await index.openCursor();
    while (cursor) {
      if (cursor.value.timestamp < cutoffTime) {
        await cursor.delete();
        cursor = await cursor.continue();
      } else {
        break;
      }
    }
    await tx.done;
  }

  async getSessionMetas(): Promise<SessionMeta[]> {
    if (isContentScript()) {
      const response = await sendToBackground({
        type: MessageType.GET_SESSION_METAS,
        payload: {},
        sessionId: "",
        timestamp: Date.now()
      });
      return response ? (response as any).sessions || [] : [];
    }
    const db = await getDB();
    return db.getAll('sessions');
  }

  async getFileBlob(alias: string): Promise<FileBlob | undefined> {
    if (isContentScript()) {
      const response = await sendToBackground({
        type: MessageType.GET_FILE_BLOB,
        payload: { alias },
        sessionId: "",
        timestamp: Date.now()
      });
      return response ? (response as any).fileBlob : undefined;
    }
    const db = await getDB();
    const encryptedRecord = await db.get('files', alias);
    if (!encryptedRecord) return undefined;

    try {
      const decryptedMeta = await decryptValue(encryptedRecord.encryptedMeta);
      const decryptedBuffer = await decryptBuffer(encryptedRecord.encryptedData);
      const blob = new Blob([decryptedBuffer], { type: decryptedMeta.type });
      return {
        alias: encryptedRecord.alias,
        data: blob,
        name: decryptedMeta.name,
        type: decryptedMeta.type
      };
    } catch (err) {
      logger.error('StorageManager', `Failed to decrypt file blob for alias ${alias}:`, err);
      throw err;
    }
  }

  async addFileBlob(fileBlob: FileBlob): Promise<void> {
    if (isContentScript()) {
      return;
    }
    const db = await getDB();
    
    // Encrypt the blob data and metadata
    const arrayBuffer = await fileBlob.data.arrayBuffer();
    const encryptedData = await encryptBuffer(arrayBuffer);
    const encryptedMeta = await encryptValue({
      name: fileBlob.name,
      type: fileBlob.type
    });

    await db.put('files', {
      alias: fileBlob.alias,
      encryptedData,
      encryptedMeta
    });
  }

  async getHistoricLogs(offset = 0, limit = 500): Promise<LogEntry[]> {
    const db = await getDB();
    const tx = db.transaction('logs', 'readonly');
    const index = tx.store.index('timestamp');
    const rows: LogEntry[] = [];
    let skipped = 0;
    let cursor = await index.openCursor(null, 'prev');

    while (cursor && rows.length < limit) {
      if (skipped < offset) {
        skipped++;
      } else {
        rows.push(cursor.value);
      }
      cursor = await cursor.continue();
    }

    return rows;
  }
}

export const StorageManager = new StorageManagerImpl();
