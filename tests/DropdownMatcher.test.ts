import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DropdownMatcher } from '../src/content/engines/DropdownMatcher';
import { logger } from '../src/utils/logger';

// Mock DOM environment for HTMLSelectElement
describe('DropdownMatcher', () => {
  let select: HTMLSelectElement;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Create a mock select element
    select = document.createElement('select');
  });

  const addOptions = (options: { value: string; text: string }[]) => {
    options.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.text;
      select.appendChild(opt);
    });
  };

  describe('Stage 1: Exact Match', () => {
    it('matches exact value with 100% confidence', () => {
      addOptions([{ value: 'us', text: 'United States' }]);
      const result = DropdownMatcher.match(select, 'us');
      expect(result.strategy).toBe('EXACT');
      expect(result.confidence).toBe(100);
      expect(result.option?.value).toBe('us');
    });

    it('matches exact text with 100% confidence (case insensitive)', () => {
      addOptions([{ value: 'us', text: 'United States' }]);
      const result = DropdownMatcher.match(select, 'UNITED states');
      expect(result.strategy).toBe('EXACT');
      expect(result.confidence).toBe(100);
      expect(result.option?.value).toBe('us');
    });
  });

  describe('Stage 2: Prefix Match', () => {
    it('matches prefix with 95% confidence', () => {
      addOptions([{ value: 'QA', text: 'QA & Automation Testing' }]);
      // "QA" matches prefix of both value ("qa") and text ("qa & automation testing")
      // Actually it's an exact match on value! Let's use something else.
      const result2 = DropdownMatcher.match(select, 'QA & Automation');
      expect(result2.strategy).toBe('PREFIX');
      expect(result2.confidence).toBe(95);
      expect(result2.option?.value).toBe('QA');
    });

    it('matches prefix on text when value is different', () => {
      addOptions([{ value: 'us', text: 'United States' }]);
      const result = DropdownMatcher.match(select, 'United');
      expect(result.strategy).toBe('PREFIX');
      expect(result.confidence).toBe(95);
      expect(result.option?.value).toBe('us');
    });
  });

  describe('Stage 3: Whole Word Match', () => {
    it('matches whole word token with 90% confidence', () => {
      addOptions([{ value: 'qa', text: 'QA & Automation Testing' }]);
      const result = DropdownMatcher.match(select, 'Automation');
      expect(result.strategy).toBe('WHOLE_WORD');
      expect(result.confidence).toBe(90);
      expect(result.option?.value).toBe('qa');
    });

    it('handles punctuation correctly as word boundaries', () => {
      addOptions([{ value: 'ny', text: 'New York City,' }]);
      // "York" is bounded by space and space
      const result = DropdownMatcher.match(select, 'York');
      expect(result.strategy).toBe('WHOLE_WORD');
      expect(result.option?.value).toBe('ny');
    });

    it('handles start/end of string bounds correctly', () => {
      addOptions([{ value: 'ny', text: 'New York City' }]);
      const result = DropdownMatcher.match(select, 'New');
      expect(result.strategy).toBe('PREFIX'); // "New" is a prefix, wait!
      // Let's test "City" which is at the end
      const result2 = DropdownMatcher.match(select, 'City');
      expect(result2.strategy).toBe('WHOLE_WORD');
      expect(result2.option?.value).toBe('ny');
    });
  });

  describe('Safety / Rejections', () => {
    it('rejects substring match (e.g. Male in Female)', () => {
      addOptions([
        { value: 'F', text: 'Female' }
      ]);
      const result = DropdownMatcher.match(select, 'Male');
      expect(result.strategy).toBe('NONE');
      expect(result.option).toBeNull();
    });

    it('rejects partial token match (e.g. Yor in York)', () => {
      addOptions([{ value: 'ny', text: 'New York City' }]);
      const result = DropdownMatcher.match(select, 'Yor');
      expect(result.strategy).toBe('NONE');
      expect(result.option).toBeNull();
    });
    
    it('rejects prefix match inside a word', () => {
      addOptions([{ value: 'us', text: 'United States' }]);
      const result = DropdownMatcher.match(select, 'ted');
      expect(result.strategy).toBe('NONE');
      expect(result.option).toBeNull();
    });
  });

  describe('Ambiguity Checks', () => {
    it('logs warning and rejects if prefix matches multiple options', () => {
      addOptions([
        { value: 'ca', text: 'California' },
        { value: 'can', text: 'Canada' }
      ]);
      DropdownMatcher.match(select, 'CA');
      DropdownMatcher.match(select, 'Cali');
      const result3 = DropdownMatcher.match(select, 'C');
      expect(result3.strategy).toBe('NONE');
      expect(result3.option).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'DropdownMatcher',
        expect.stringContaining('Ambiguous dropdown match for "C" at PREFIX stage (candidates: California, Canada)')
      );
    });

    it('logs warning and rejects if whole word matches multiple options', () => {
      addOptions([
        { value: '1', text: 'New York' },
        { value: '2', text: 'New Jersey' }
      ]);
      DropdownMatcher.match(select, 'New');
      
      addOptions([
        { value: '3', text: 'North York' },
        { value: '4', text: 'South York' }
      ]);
      const result2 = DropdownMatcher.match(select, 'York');
      expect(result2.strategy).toBe('NONE');
      expect(result2.option).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'DropdownMatcher',
        expect.stringContaining('Ambiguous dropdown match for "York" at WHOLE_WORD stage')
      );
    });
  });
});
