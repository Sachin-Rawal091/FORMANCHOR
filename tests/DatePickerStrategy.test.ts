import { describe, it, expect } from 'vitest';
import { DatePickerStrategy } from '../src/content/datepickers/strategies/DatePickerStrategy';
import { AntDAdapter } from '../src/content/datepickers/adapters/AntDAdapter';

describe('DatePickerStrategy & AntDAdapter Unit Tests', () => {
  it('Stage 2 keyboard direct commit sequence should execute focus -> open -> setInputValue -> Enter -> blur', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const events: string[] = [];
    ['focus', 'mousedown', 'click', 'input', 'change', 'keydown', 'keypress', 'keyup', 'blur'].forEach(type => {
      input.addEventListener(type, () => events.push(type));
    });

    const strategy = new DatePickerStrategy();
    const success = await strategy.execute(input, '15/08/1998', {
      isNativeDate: false,
      isCustomDatePicker: true,
      adapter: null,
      minDate: null,
      maxDate: null,
      score: 50,
    });

    expect(success).toBe(true);
    expect(input.value).toBe('15/08/1998');
    expect(events).toContain('focus');
    expect(events).toContain('input');
    expect(events).toContain('keydown');
    expect(events).toContain('blur');

    document.body.removeChild(input);
  });

  it('AntDAdapter.navigateToMonth should navigate from 2026 to 2020 using super-prev buttons', async () => {
    const popup = document.createElement('div');
    popup.className = 'ant-picker-dropdown';

    const headerView = document.createElement('div');
    headerView.className = 'ant-picker-header-view';
    headerView.textContent = 'August 2026';

    const superPrevBtn = document.createElement('button');
    superPrevBtn.className = 'ant-picker-header-super-prev-btn';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'ant-picker-header-prev-btn';

    popup.appendChild(headerView);
    popup.appendChild(superPrevBtn);
    popup.appendChild(prevBtn);
    document.body.appendChild(popup);

    let currentYear = 2026;
    let currentMonth = 7; // August
    let clicks = 0;

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    superPrevBtn.addEventListener('click', () => {
      clicks++;
      currentYear -= 1; // AntD super-prev steps 1 year on date panel
      headerView.textContent = `${monthNames[currentMonth]} ${currentYear}`;
    });

    prevBtn.addEventListener('click', () => {
      clicks++;
      currentMonth -= 1;
      if (currentMonth < 0) {
        currentMonth = 11;
        currentYear -= 1;
      }
      headerView.textContent = `${monthNames[currentMonth]} ${currentYear}`;
    });

    const adapter = new AntDAdapter();
    const targetDate = new Date(2020, 7, 15); // August 15, 2020 (6 years gap)
    const navSuccess = await adapter.navigateToMonth(targetDate);

    expect(navSuccess).toBe(true);
    expect(clicks).toBeLessThan(25); // 17 total clicks (super + month) vs 72 month clicks
    expect(currentYear).toBe(2020);

    document.body.removeChild(popup);
  });
});
