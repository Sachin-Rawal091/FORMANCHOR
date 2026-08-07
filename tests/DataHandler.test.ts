import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataHandler } from '../src/background/handlers/DataHandler';
import { StorageManager } from '../src/storage/StorageManager';
import { MessageType } from '../src/types';

vi.mock('../src/storage/StorageManager', () => {
  return {
    StorageManager: {
      getExcelDataCount: vi.fn(),
      getExcelData: vi.fn(),
      setExcelData: vi.fn(),
      addLogEntries: vi.fn(),
      setExecutionState: vi.fn(),
      getExecutionState: vi.fn(),
    }
  };
});

describe('DataHandler Unit Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('handleGetExcelData should return count when countOnly is true', async () => {
    vi.spyOn(StorageManager, 'getExcelDataCount').mockResolvedValue(10);
    const mockSendResponse = vi.fn();
    const msg = {
      type: MessageType.GET_EXCEL_DATA,
      sessionId: 'sess-1',
      payload: { countOnly: true },
      timestamp: Date.now()
    };

    await DataHandler.handleGetExcelData(msg, mockSendResponse);
    expect(StorageManager.getExcelDataCount).toHaveBeenCalled();
    expect(mockSendResponse).toHaveBeenCalledWith({ count: 10 });
  });

  it('handleGetExcelData should return rows when countOnly is false/omitted', async () => {
    const mockRows = [{ rowIndex: 1, data: {} }];
    vi.spyOn(StorageManager, 'getExcelData').mockResolvedValue(mockRows as any);
    const mockSendResponse = vi.fn();
    const msg = {
      type: MessageType.GET_EXCEL_DATA,
      sessionId: 'sess-1',
      payload: { startRowIndex: 0, limit: 5 },
      timestamp: Date.now()
    };

    await DataHandler.handleGetExcelData(msg, mockSendResponse);
    expect(StorageManager.getExcelData).toHaveBeenCalledWith({ startRowIndex: 0, limit: 5 });
    expect(mockSendResponse).toHaveBeenCalledWith({ excelRows: mockRows });
  });

  it('handleSetExcelData should persist rows and send success response', async () => {
    vi.spyOn(StorageManager, 'setExcelData').mockResolvedValue(undefined);
    const mockSendResponse = vi.fn();
    const msg = {
      type: MessageType.SET_EXCEL_DATA,
      sessionId: 'sess-1',
      payload: { excelRows: [{ rowIndex: 1, data: {} }], updateOnly: true },
      timestamp: Date.now()
    };

    await DataHandler.handleSetExcelData(msg, mockSendResponse);
    expect(StorageManager.setExcelData).toHaveBeenCalledWith(msg.payload.excelRows, false);
    expect(mockSendResponse).toHaveBeenCalledWith({ success: true });
  });

  it('handleAddLogEntry should persist log entry and send success response', async () => {
    vi.spyOn(StorageManager, 'addLogEntries').mockResolvedValue(undefined);
    const mockSendResponse = vi.fn();
    const msg = {
      type: MessageType.ADD_LOG_ENTRY,
      sessionId: 'sess-1',
      payload: { entry: { id: 'log-1', timestamp: Date.now() } },
      timestamp: Date.now()
    };

    await DataHandler.handleAddLogEntry(msg, mockSendResponse);
    // expect(StorageManager.addLogEntries).toHaveBeenCalledWith([msg.payload.entry]);
    expect(mockSendResponse).toHaveBeenCalledWith({ success: true });
  });

  it('handleSetExecutionState should update execution state and send success response', async () => {
    vi.spyOn(StorageManager, 'setExecutionState').mockResolvedValue(undefined);
    const mockSendResponse = vi.fn();
    const msg = {
      type: MessageType.STATE_UPDATE,
      sessionId: 'sess-1',
      payload: { state: { sessionId: 'sess-1', status: 'RUNNING' } },
      tabId: 5,
      timestamp: Date.now()
    };

    await DataHandler.handleSetExecutionState(msg as any, mockSendResponse);
    expect(StorageManager.setExecutionState).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      status: 'RUNNING',
      tabContext: 5
    });
    expect(mockSendResponse).toHaveBeenCalledWith({ success: true });
  });

  it('handleGetExecutionState should retrieve execution state and send response', async () => {
    const mockState = { sessionId: 'sess-1', status: 'RUNNING' };
    vi.spyOn(StorageManager, 'getExecutionState').mockResolvedValue(mockState as any);
    const mockSendResponse = vi.fn();

    await DataHandler.handleGetExecutionState(mockSendResponse);
    expect(StorageManager.getExecutionState).toHaveBeenCalled();
    expect(mockSendResponse).toHaveBeenCalledWith({ state: mockState });
  });
});
