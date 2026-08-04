export enum Action {
  FILL,
  CLICK,
  SELECT,
  SELECT_RADIO,
  TOGGLE_CHECKBOX,
  WAIT,
  SCROLL,
  SUBMIT,
  FILE_UPLOAD,
  RICH_TEXT,
  NAVIGATE_NEXT,
  MANUAL_IFRAME,
  DATEPICKER,
}

export interface Step {
  id: string;
  action: Action;
  selector: string;
  selectorMeta: SelectorMeta;
  value?: string;
  options?: StepOptions;
  pageId: string;
  columnName?: string;
  required?: boolean;
  defaultValue?: string;
  expectedType?: "text" | "number" | "date" | "boolean";
  skipOnEmpty?: boolean;
  frameId?: number;
  checked?: boolean;
  retryable?: boolean;
  maxRetries?: number;
}

export interface StepOptions {
  /** Override the default step timeout (ms) */
  timeoutOverride?: number;
  /** Wait strategy to use before executing this step */
  waitStrategy?: 'domStability' | 'networkIdle' | 'urlChange' | 'none';
}

export interface SelectorMeta {
  id?: string;
  name?: string;
  ariaLabel?: string;
  placeholder?: string;
  labelText?: string;
  /** BUG-NEW-6: data-testid or data-test-id attribute value */
  testId?: string;
  /** BUG-NEW-6: ARIA role attribute value */
  role?: string;
  cssPath?: string;
  xpath?: string;
  metadata?: Record<string, unknown>;
}

export interface SelectorResult {
  element: Element;
  strategy: SelectorStrategy;
  confidence: number;
  shadow: boolean;
}

export enum SelectorStrategy {
  ID,
  NAME,
  ARIA_LABEL,
  LABEL_LINKED,
  PLACEHOLDER,
  CSS_PATH,
  XPATH,
  SHADOW_DOM,
}

export interface ExecutionState {
  sessionId: string;
  currentRowIndex: number;
  currentStepIndex: number;
  currentPageId: string;
  status: ExecutionStatus;
  totalRows: number;
  completedRows: number;
  failedRows: number;
  skippedRows: number;
  pageRetryCount: number;
  mutexLock: string | null;
  captchaPending: boolean;
  captchaStartTime?: number;
  captchaTimeLeft?: number;
  tabContext: number;
  lastStepResult: string;
  recordingId?: string;
  siteUrl?: string;
  currentUrl?: string;
}

export enum ExecutionStatus {
  IDLE = 0,
  RUNNING = 1,
  PAUSED = 2,
  CAPTCHA_PAUSED = 3,
  COMPLETE = 4,
  FAILED = 5,
  STARTING = 6,
}

export interface PageDef {
  id: string;
  urlPattern: string;
}

export interface Recording {
  id: string;
  name: string;
  siteUrl: string;
  siteId: string;
  steps: Step[];
  pages: PageDef[];
  pageCount: number;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface ExcelRow {
  rowIndex: number;
  data: Record<string, string | number | boolean | null>;
  status: RowStatus;
  isValid: boolean;
  validationErrors: string[];
  error?: string;
}

export enum RowStatus {
  PENDING,
  SUCCESS,
  FAILED,
  SKIPPED,
}

export interface LogEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  rowIndex: number;
  stepId: string;
  action: Action;
  selector: string;
  value?: string;
  result: StepResult;
  status: LogStatus;
  error?: string;
  retryCount: number;
  duration: number;
  selectorStrategy?: SelectorStrategy;
  sequence?: number;
  batchIndex?: number;
}

export enum StepResult {
  SUCCESS,
  FAILED,
  SKIPPED,
}

export type LogStatus =
  | "FILLED"
  | "FILLED_DEFAULT"
  | "FILLED_COERCED"
  | "FILLED_READONLY"
  | "STEP_SKIPPED"
  | "WARN"
  | "ROW_SKIPPED"
  | "RETRIED"
  | "CAPTCHA_DETECTED"
  | "SUCCESS"
  | "FAILED";

export interface FormPilotMessage<T = unknown> {
  type: MessageType;
  payload: T;
  sessionId: string;
  tabId?: number;
  timestamp: number;
}

export enum MessageType {
  START_RECORDING,
  STOP_RECORDING,
  START_EXECUTION,
  PAUSE_EXECUTION,
  RESUME_EXECUTION,
  ABORT_EXECUTION,
  RECORDING_EVENT,
  EXECUTION_COMPLETE,
  STATE_UPDATE,
  CAPTCHA_DETECTED,
  PAGE_NAVIGATED,
  GET_STATUS,
  GET_RECORDING_DATA,
  GET_EXCEL_DATA,
  SET_EXCEL_DATA,
  ADD_LOG_ENTRY,
  SET_EXECUTION_STATE,
  GET_EXECUTION_STATE,
  CLEAR_BADGE,
  GET_FILE_BLOB,
  GET_SESSION_METAS,
  EXECUTION_CONFIRMED,
  ADD_SESSION_META,
  ADD_LOG_BATCH,
  LOGS_UPDATED,
  INJECT_NETWORK_PROXY,
}

export interface RecordingState {
  isRecording: boolean;
  activeRecordingSteps: Step[];
  activeRecordingUrl: string;
  recordingId?: string;
}

export interface UserSettings {
  stepDelay?: number;
  maxStepRetries?: number;
  waitElementTimeout?: number;
  logRetentionDays?: number;
  theme?: 'light' | 'dark';
}


export interface SessionMeta {
  sessionId: string;
  timestamp: number;
  recordingId: string;
  totalRows?: number;
}

export interface FileBlob {
  alias: string;
  data: Blob;
  name: string;
  type: string;
}
