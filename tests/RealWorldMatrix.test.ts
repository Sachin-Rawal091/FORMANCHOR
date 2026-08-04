import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 1. Setup global chrome mock BEFORE importing any scripts so they register correctly
const listeners: Array<(message: any, sender: any, sendResponse: any) => void> = [];

const mockChrome = {
  runtime: {
    onMessage: {
      addListener: (fn: any) => {
        listeners.push(fn);
      },
      removeListener: (fn: any) => {
        const index = listeners.indexOf(fn);
        if (index > -1) listeners.splice(index, 1);
      }
    },
    sendMessage: vi.fn().mockResolvedValue(undefined),
  }
};

(globalThis as any).chrome = mockChrome;

// Mock global XPathResult for tests
(globalThis as any).XPathResult = {
  FIRST_ORDERED_NODE_TYPE: 9,
};

describe('Real-World Matrix Test Suite', () => {
  let executionStateStore: any = null;

  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();

    const { SmartWaitEngine } = await import('../src/content/engines/SmartWaitEngine');
    const { MessageType } = await import('../src/types');
    vi.spyOn(SmartWaitEngine, 'waitForURLChange').mockResolvedValue(true);

    mockChrome.runtime.sendMessage.mockReset();
    mockChrome.runtime.sendMessage.mockImplementation((msg: any, callback?: any) => {
      if (callback) {
        if (msg.type === MessageType.GET_RECORDING_DATA) { // GET_RECORDING_DATA
          import('../src/storage/StorageManager').then(({ StorageManager }) => {
            StorageManager.getRecordings().then(recs => {
              callback({ recording: recs.find(r => r.id === msg.payload.recordingId) });
            });
          });
          return true;
        }
        if (msg.type === MessageType.GET_EXCEL_DATA) { // GET_EXCEL_DATA
          import('../src/storage/StorageManager').then(({ StorageManager }) => {
            if (msg.payload?.countOnly) {
              StorageManager.getExcelData().then(rows => {
                callback({ count: rows.length });
              });
            } else {
              StorageManager.getExcelData().then(rows => {
                callback({ excelRows: rows });
              });
            }
          });
          return true;
        }
        callback({ received: true });
        return true;
      }
      return Promise.resolve(undefined);
    });

    // Mock layout globally since Happy DOM doesn't compute actual layouts
    (globalThis as any).Element.prototype.getBoundingClientRect = () => ({
      width: 100,
      height: 25,
      top: 0,
      left: 0,
      bottom: 25,
      right: 100,
    } as any);

    // Dynamic style mock to support display: none checks in multi-step tests
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: any) => {
      return {
        display: el.style.display || 'block',
        visibility: el.style.visibility || 'visible',
        opacity: el.style.opacity || '1',
        pointerEvents: el.style.pointerEvents || 'auto',
      } as any;
    });

    // Setup in-memory mock for execution state
    executionStateStore = null;

    // Dynamically import StorageManager to mock it cleanly
    const { StorageManager } = await import('../src/storage/StorageManager');
    vi.spyOn(StorageManager, 'getExecutionState').mockImplementation(async () => executionStateStore);
    vi.spyOn(StorageManager, 'setExecutionState').mockImplementation(async (state) => {
      executionStateStore = state;
    });
    vi.spyOn(StorageManager, 'clearExecutionState').mockImplementation(async () => {
      executionStateStore = null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper to run executor loop for a given recording and excel row
  async function runExecutorFlow(recording: any, excelRows: any[]) {
    const { StorageManager } = await import('../src/storage/StorageManager');
    const { Executor } = await import('../src/content/executor');

    vi.spyOn(StorageManager, 'getRecordings').mockResolvedValue([recording]);
    vi.spyOn(StorageManager, 'getExcelData').mockResolvedValue(excelRows);
    vi.spyOn(StorageManager, 'setExcelData').mockResolvedValue(undefined);
    vi.spyOn(StorageManager, 'addLogEntries').mockResolvedValue(undefined);

    const executor = (globalThis as any).__FP_EXECUTOR_INSTANCE__ || new Executor();
    sessionStorage.setItem('__fp_reset_done_session-matrix', 'true');
    executor.start(recording.id, 'session-matrix');
  }

  it('Scenario 1: Login Flow - Should fill credentials and submit successfully', async () => {
    const { Action, RowStatus, ExecutionStatus } = await import('../src/types');

    // 1. Build DOM
    const form = document.createElement('form');
    form.id = 'login-form';
    
    const userInp = document.createElement('input');
    userInp.id = 'username';
    form.appendChild(userInp);

    const passInp = document.createElement('input');
    passInp.type = 'password';
    passInp.id = 'password';
    form.appendChild(passInp);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.id = 'submit-btn';
    form.appendChild(submitBtn);

    document.body.appendChild(form);

    let submitFired = false;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitFired = true;
    });

    // 2. Define Recording
    const mockRecording = {
      id: 'flow-login',
      name: 'Login Flow',
      steps: [
        {
          id: 'step-u',
          action: Action.FILL,
          selector: 'input#username',
          selectorMeta: { id: 'username', cssPath: 'input#username' },
          value: '{{User}}',
          columnName: 'User',
          required: true
        },
        {
          id: 'step-p',
          action: Action.FILL,
          selector: 'input#password',
          selectorMeta: { id: 'password', cssPath: 'input#password' },
          value: '{{Pass}}',
          columnName: 'Pass',
          required: true
        },
        {
          id: 'step-s',
          action: Action.CLICK,
          selector: 'button#submit-btn',
          selectorMeta: { id: 'submit-btn', cssPath: 'button#submit-btn' }
        }
      ],
      createdAt: Date.now()
    };

    // 3. Define Excel Data
    const mockExcelRows = [
      {
        rowIndex: 2,
        data: { User: 'sachin_admin', Pass: 'supersecret' },
        status: RowStatus.PENDING,
        isValid: true,
        validationErrors: []
      }
    ];

    // 4. Run Execution
    await runExecutorFlow(mockRecording, mockExcelRows);

    // 5. Wait & Verify
    await vi.waitFor(() => {
      expect(userInp.value).toBe('sachin_admin');
      expect(passInp.value).toBe('supersecret');
      expect(submitFired).toBe(true);
      expect(executionStateStore.status).toBe(ExecutionStatus.COMPLETE);
    }, { timeout: 5000 });
  });

  it('Scenario 2: Multi-step SaaS Signup - Should complete page-to-page transitions', async () => {
    const { Action, RowStatus, ExecutionStatus } = await import('../src/types');

    // 1. Build DOM
    const step1Panel = document.createElement('div');
    step1Panel.id = 'step-1';
    step1Panel.style.display = 'block';

    const companyInp = document.createElement('input');
    companyInp.id = 'company-name';
    step1Panel.appendChild(companyInp);

    const sizeInp = document.createElement('input');
    sizeInp.type = 'number';
    sizeInp.id = 'company-size';
    step1Panel.appendChild(sizeInp);

    const dobInput = document.createElement('input');
    dobInput.id = 'company-dob';
    const pickerContainer = document.createElement('div');
    pickerContainer.className = 'ant-picker';
    const pickerInputContainer = document.createElement('div');
    pickerInputContainer.className = 'ant-picker-input';
    pickerInputContainer.appendChild(dobInput);
    pickerContainer.appendChild(pickerInputContainer);
    step1Panel.appendChild(pickerContainer);

    pickerContainer.addEventListener('click', () => {
      if (!document.querySelector('.ant-picker-dropdown')) {
        const popup = document.createElement('div');
        popup.className = 'ant-picker-dropdown';

        const headerView = document.createElement('div');
        headerView.className = 'ant-picker-header-view';
        headerView.textContent = 'August 1998';
        popup.appendChild(headerView);

        const cell = document.createElement('div');
        cell.className = 'ant-picker-cell ant-picker-cell-in-view';
        const cellInner = document.createElement('div');
        cellInner.className = 'ant-picker-cell-inner';
        cellInner.textContent = '15';
        cellInner.addEventListener('click', () => {
          dobInput.value = '15/08/1998';
        });
        cell.appendChild(cellInner);
        popup.appendChild(cell);

        document.body.appendChild(popup);
      }
    });

    const nextBtn = document.createElement('button');
    nextBtn.id = 'next-step';
    step1Panel.appendChild(nextBtn);

    document.body.appendChild(step1Panel);

    const step2Panel = document.createElement('div');
    step2Panel.id = 'step-2';
    step2Panel.style.display = 'none';

    const planRadio = document.createElement('input');
    planRadio.setAttribute('type', 'radio');
    planRadio.setAttribute('name', 'plan');
    planRadio.id = 'plan-premium';
    planRadio.setAttribute('value', 'premium');
    step2Panel.appendChild(planRadio);

    const termsCheckbox = document.createElement('input');
    termsCheckbox.setAttribute('type', 'checkbox');
    termsCheckbox.type = 'checkbox';
    termsCheckbox.id = 'terms-accept';
    termsCheckbox.dispatchEvent = vi.fn();
    step2Panel.appendChild(termsCheckbox);

    const submitBtn = document.createElement('button');
    submitBtn.id = 'submit-signup';
    step2Panel.appendChild(submitBtn);

    document.body.appendChild(step2Panel);

    // Simulate multi-step panel transitions on click
    nextBtn.addEventListener('click', () => {
      step1Panel.style.display = 'none';
      step2Panel.style.display = 'block';
    });

    let submitFired = false;
    submitBtn.addEventListener('click', () => {
      submitFired = true;
    });

    // 2. Define Recording
    const mockRecording = {
      id: 'flow-saas',
      name: 'SaaS Signup Flow',
      steps: [
        {
          id: 'step-comp',
          action: Action.FILL,
          selector: '#company-name',
          selectorMeta: { id: 'company-name' },
          value: '{{Company}}',
          columnName: 'Company',
          required: true
        },
        {
          id: 'step-size',
          action: Action.FILL,
          selector: '#company-size',
          selectorMeta: { id: 'company-size' },
          value: '{{Size}}',
          columnName: 'Size',
          expectedType: 'number',
          required: true
        },
        {
          id: 'step-dob',
          action: Action.DATEPICKER,
          selector: '#company-dob',
          selectorMeta: { id: 'company-dob' },
          value: '{{DOB}}',
          columnName: 'DOB',
          required: true
        },
        {
          id: 'step-next',
          action: Action.NAVIGATE_NEXT,
          selector: '#next-step',
          selectorMeta: { id: 'next-step' }
        },
        {
          id: 'step-plan',
          action: Action.SELECT_RADIO,
          selector: '#plan-premium',
          selectorMeta: { id: 'plan-premium' },
          value: '{{Plan}}',
          columnName: 'Plan',
          required: true
        },
        {
          id: 'step-terms',
          action: Action.TOGGLE_CHECKBOX,
          selector: '#terms-accept',
          selectorMeta: { id: 'terms-accept' },
          checked: true
        },
        {
          id: 'step-submit',
          action: Action.CLICK,
          selector: '#submit-signup',
          selectorMeta: { id: 'submit-signup' }
        }
      ],
      createdAt: Date.now()
    };

    // 3. Define Excel Data
    const mockExcelRows = [
      {
        rowIndex: 2,
        data: { Company: 'FormPilot Inc', Size: '25', DOB: '15/08/1998', Plan: 'premium' },
        status: RowStatus.PENDING,
        isValid: true,
        validationErrors: []
      }
    ];

    // 4. Run Execution
    await runExecutorFlow(mockRecording, mockExcelRows);

    // 5. Wait & Verify Dual Assertions (DOB persistence + Step 2 active)
    await vi.waitFor(() => {
      expect(companyInp.value).toBe('FormPilot Inc');
      expect(sizeInp.value).toBe('25');
      expect(dobInput.value).toBe('15/08/1998'); // Assertion 1: DOB persisted
      expect(step1Panel.style.display).toBe('none');
      expect(step2Panel.style.display).toBe('block'); // Assertion 2: Step 2 active
      expect(planRadio.checked).toBe(true);
      expect(termsCheckbox.checked).toBe(true);
      expect(submitFired).toBe(true);
      expect(executionStateStore.status).toBe(ExecutionStatus.COMPLETE);
    }, { timeout: 10000 });
  }, 15000);

  it('Scenario 3: Government Static HTML Form - Should fill 15+ native inputs perfectly', async () => {
    const { Action, RowStatus, ExecutionStatus } = await import('../src/types');

    // 1. Build Massive DOM
    const fields = [
      'first-name', 'last-name', 'street', 'city', 'zip-code', 'comments', 'bio', 'age', 'dob'
    ];
    
    const elements: Record<string, HTMLElement> = {};

    fields.forEach(f => {
      let el;
      if (f === 'comments' || f === 'bio') {
        el = document.createElement('textarea');
      } else {
        el = document.createElement('input');
        if (f === 'age') el.type = 'number';
        if (f === 'dob') el.type = 'date';
      }
      el.id = f;
      document.body.appendChild(el);
      elements[f] = el;
    });

    const selectFields = ['state', 'country', 'gender'];
    selectFields.forEach(sf => {
      const select = document.createElement('select');
      select.id = sf;
      const opt1 = document.createElement('option');
      opt1.value = 'val-1';
      const opt2 = document.createElement('option');
      opt2.value = sf === 'gender' ? 'female' : 'IN';
      select.appendChild(opt1);
      select.appendChild(opt2);
      document.body.appendChild(select);
      elements[sf] = select;
    });

    const checkFields = ['agree-1', 'agree-2', 'agree-3'];
    checkFields.forEach(cf => {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = cf;
      checkbox.dispatchEvent = vi.fn();
      document.body.appendChild(checkbox);
      elements[cf] = checkbox;
    });

    // 2. Define Recording containing 15 steps
    const steps = [
      ...fields.map(f => ({
        id: `step-${f}`,
        action: Action.FILL,
        selector: `#${f}`,
        selectorMeta: { id: f },
        value: `{{${f.toUpperCase().replace('-', '_')}}}`,
        columnName: f.toUpperCase().replace('-', '_'),
        expectedType: f === 'age' ? 'number' : f === 'dob' ? 'date' : 'text',
        required: true
      })),
      ...selectFields.map(sf => ({
        id: `step-${sf}`,
        action: Action.SELECT,
        selector: `#${sf}`,
        selectorMeta: { id: sf },
        value: `{{${sf.toUpperCase()}}}`,
        columnName: sf.toUpperCase(),
        required: true
      })),
      ...checkFields.map(cf => ({
        id: `step-${cf}`,
        action: Action.TOGGLE_CHECKBOX,
        selector: `#${cf}`,
        selectorMeta: { id: cf },
        checked: true
      }))
    ];

    const mockRecording = {
      id: 'flow-gov',
      name: 'Gov Flow',
      steps,
      createdAt: Date.now()
    };

    // 3. Define Excel Data
    const mockExcelRows = [
      {
        rowIndex: 2,
        data: {
          FIRST_NAME: 'Sachin',
          LAST_NAME: 'Rawal',
          STREET: '123 Pilot St',
          CITY: 'Vite City',
          ZIP_CODE: '110001',
          COMMENTS: 'Fine form',
          BIO: 'Developer of FormPilot',
          AGE: 28,
          DOB: '1998-05-20',
          STATE: 'val-1',
          COUNTRY: 'IN',
          GENDER: 'female'
        },
        status: RowStatus.PENDING,
        isValid: true,
        validationErrors: []
      }
    ];

    // 4. Run Execution
    await runExecutorFlow(mockRecording, mockExcelRows);

    // 5. Wait & Verify
    await vi.waitFor(() => {
      expect((elements['first-name'] as HTMLInputElement).value).toBe('Sachin');
      expect((elements['last-name'] as HTMLInputElement).value).toBe('Rawal');
      expect((elements['street'] as HTMLInputElement).value).toBe('123 Pilot St');
      expect((elements['city'] as HTMLInputElement).value).toBe('Vite City');
      expect((elements['zip-code'] as HTMLInputElement).value).toBe('110001');
      expect((elements['comments'] as HTMLTextAreaElement).value).toBe('Fine form');
      expect((elements['bio'] as HTMLTextAreaElement).value).toBe('Developer of FormPilot');
      expect((elements['age'] as HTMLInputElement).value).toBe('28');
      expect((elements['dob'] as HTMLInputElement).value).toBe('1998-05-20');
      expect((elements['state'] as HTMLSelectElement).value).toBe('val-1');
      expect((elements['country'] as HTMLSelectElement).value).toBe('IN');
      expect((elements['gender'] as HTMLSelectElement).value).toBe('female');
      expect((elements['agree-1'] as HTMLInputElement).checked).toBe(true);
      expect((elements['agree-2'] as HTMLInputElement).checked).toBe(true);
      expect((elements['agree-3'] as HTMLInputElement).checked).toBe(true);
      expect(executionStateStore.status).toBe(ExecutionStatus.COMPLETE);
    }, { timeout: 10000 });
  }, 20000);

  it('Scenario 4: Job Application (Workday style) - Should handle fields and stub file upload gracefully', async () => {
    const { Action, RowStatus, ExecutionStatus } = await import('../src/types');

    // 1. Build DOM
    const fileInp = document.createElement('input');
    fileInp.type = 'file';
    fileInp.id = 'resume-upload';
    document.body.appendChild(fileInp);

    const nameInp = document.createElement('input');
    nameInp.id = 'candidate-name';
    document.body.appendChild(nameInp);

    const coverLetter = document.createElement('textarea');
    coverLetter.id = 'cover-letter';
    document.body.appendChild(coverLetter);

    // 2. Define Recording
    const mockRecording = {
      id: 'flow-job',
      name: 'Job App Flow',
      steps: [
        {
          id: 'step-upload',
          action: Action.FILE_UPLOAD,
          selector: '#resume-upload',
          selectorMeta: { id: 'resume-upload' },
          value: '{{ResumeFile}}',
          columnName: 'ResumeFile',
          required: true
        },
        {
          id: 'step-name',
          action: Action.FILL,
          selector: '#candidate-name',
          selectorMeta: { id: 'candidate-name' },
          value: '{{Name}}',
          columnName: 'Name',
          required: true
        },
        {
          id: 'step-cover',
          action: Action.FILL,
          selector: '#cover-letter',
          selectorMeta: { id: 'cover-letter' },
          value: '{{CoverLetter}}',
          columnName: 'CoverLetter'
        }
      ],
      createdAt: Date.now()
    };

    // 3. Define Excel Data
    const mockExcelRows = [
      {
        rowIndex: 2,
        data: { ResumeFile: 'my_resume.pdf', Name: 'Sachin Rawal', CoverLetter: 'I am highly interested in the role.' },
        status: RowStatus.PENDING,
        isValid: true,
        validationErrors: []
      }
    ];

    // 4. Run Execution
    await runExecutorFlow(mockRecording, mockExcelRows);

    // 5. Wait & Verify
    await vi.waitFor(() => {
      expect(nameInp.value).toBe('Sachin Rawal');
      expect(coverLetter.value).toBe('I am highly interested in the role.');
      expect(executionStateStore.status).toBe(ExecutionStatus.COMPLETE);
    }, { timeout: 5000 });
  });

  it('Scenario 5: E-commerce Checkout (Shopify style) - Should verify dropdown selects and radio values', async () => {
    const { Action, RowStatus, ExecutionStatus } = await import('../src/types');

    // 1. Build DOM
    const select = document.createElement('select');
    select.id = 'country-select';
    
    const optUS = document.createElement('option');
    optUS.value = 'US';
    select.appendChild(optUS);

    const optIN = document.createElement('option');
    optIN.value = 'IN';
    select.appendChild(optIN);

    document.body.appendChild(select);

    const shipStd = document.createElement('input');
    shipStd.type = 'radio';
    shipStd.name = 'shipping';
    shipStd.value = 'standard';
    document.body.appendChild(shipStd);

    const shipExp = document.createElement('input');
    shipExp.type = 'radio';
    shipExp.name = 'shipping';
    shipExp.value = 'express';
    document.body.appendChild(shipExp);

    const ccInp = document.createElement('input');
    ccInp.id = 'cc-number';
    document.body.appendChild(ccInp);

    const placeBtn = document.createElement('button');
    placeBtn.id = 'place-order';
    document.body.appendChild(placeBtn);

    let clickFired = false;
    placeBtn.addEventListener('click', () => {
      clickFired = true;
    });

    // 2. Define Recording
    const mockRecording = {
      id: 'flow-ecommerce',
      name: 'Checkout Flow',
      steps: [
        {
          id: 'step-country',
          action: Action.SELECT,
          selector: '#country-select',
          selectorMeta: { id: 'country-select' },
          value: '{{Country}}',
          columnName: 'Country'
        },
        {
          id: 'step-shipping',
          action: Action.SELECT_RADIO,
          selector: 'input[type="radio"][name="shipping"]',
          selectorMeta: { id: 'shipping' },
          value: '{{Shipping}}',
          columnName: 'Shipping'
        },
        {
          id: 'step-cc',
          action: Action.FILL,
          selector: '#cc-number',
          selectorMeta: { id: 'cc-number' },
          value: '{{CCNumber}}',
          columnName: 'CCNumber'
        },
        {
          id: 'step-place',
          action: Action.CLICK,
          selector: '#place-order',
          selectorMeta: { id: 'place-order' }
        }
      ],
      createdAt: Date.now()
    };

    // 3. Define Excel Data
    const mockExcelRows = [
      {
        rowIndex: 2,
        data: { Country: 'IN', Shipping: 'express', CCNumber: '1111-2222-3333-4444' },
        status: RowStatus.PENDING,
        isValid: true,
        validationErrors: []
      }
    ];

    // 4. Run Execution
    await runExecutorFlow(mockRecording, mockExcelRows);

    // 5. Wait & Verify
    await vi.waitFor(() => {
      expect(select.value).toBe('IN');
      expect(shipExp.checked).toBe(true);
      expect(shipStd.checked).toBe(false);
      expect(ccInp.value).toBe('1111-2222-3333-4444');
      expect(clickFired).toBe(true);
      expect(executionStateStore.status).toBe(ExecutionStatus.COMPLETE);
    }, { timeout: 5000 });
  });

  it('Scenario 6: React SPA Form - Should trigger react state sync triggers successfully', async () => {
    const { Action, RowStatus, ExecutionStatus } = await import('../src/types');

    // 1. Build DOM and simulate controlled React input behavior
    const reactInp = document.createElement('input');
    reactInp.id = 'react-controlled-input';
    document.body.appendChild(reactInp);

    // Setup React-like state tracker
    const reactInternalState = { value: '' };

    reactInp.addEventListener('input', (e: any) => {
      reactInternalState.value = e.target.value;
    });

    // Let happy-dom use its native prototype value setter and getter so that e.target.value works perfectly in listener

    // 2. Define Recording
    const mockRecording = {
      id: 'flow-react',
      name: 'React SPA Flow',
      steps: [
        {
          id: 'step-react',
          action: Action.FILL,
          selector: '#react-controlled-input',
          selectorMeta: { id: 'react-controlled-input' },
          value: '{{ReactVal}}',
          columnName: 'ReactVal',
          required: true
        }
      ],
      createdAt: Date.now()
    };

    // 3. Define Excel Data
    const mockExcelRows = [
      {
        rowIndex: 2,
        data: { ReactVal: 'Hello React state!' },
        status: RowStatus.PENDING,
        isValid: true,
        validationErrors: []
      }
    ];

    // 4. Run Execution
    await runExecutorFlow(mockRecording, mockExcelRows);

    // 5. Wait & Verify React controlled elements updated and events fired
    await vi.waitFor(() => {
      expect(reactInp.value).toBe('Hello React state!');
      expect(reactInternalState.value).toBe('Hello React state!');
      expect(executionStateStore.status).toBe(ExecutionStatus.COMPLETE);
    }, { timeout: 5000 });
  });
});
