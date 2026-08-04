import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SelectorEngine } from '../src/content/engines/SelectorEngine';
import { SelectorStrategy } from '../src/types';

// Mock global XPathResult for tests
(globalThis as any).XPathResult = {
  FIRST_ORDERED_NODE_TYPE: 9,
};

describe('SelectorEngine', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('should find element by ID', () => {
    const input = document.createElement('input');
    input.id = 'test-id';
    document.body.appendChild(input);

    const result = SelectorEngine.findElement({ id: 'test-id' }, '');
    expect(result).not.toBeNull();
    expect(result!.element).toBe(input);
    expect(result!.strategy).toBe(SelectorStrategy.ID);
    expect(result!.confidence).toBe(1.0);
    expect(result!.shadow).toBe(false);
  });

  it('should find element by primary selector string', () => {
    const input = document.createElement('input');
    input.className = 'primary-class';
    document.body.appendChild(input);

    const result = SelectorEngine.findElement({}, '.primary-class');
    expect(result).not.toBeNull();
    expect(result!.element).toBe(input);
    expect(result!.strategy).toBe(SelectorStrategy.CSS_PATH);
    expect(result!.confidence).toBe(0.7);
  });

  it('should find element by Name attribute', () => {
    const input = document.createElement('input');
    input.setAttribute('name', 'test-name');
    document.body.appendChild(input);

    const result = SelectorEngine.findElement({ name: 'test-name' }, '');
    expect(result).not.toBeNull();
    expect(result!.element).toBe(input);
    expect(result!.strategy).toBe(SelectorStrategy.NAME);
    expect(result!.confidence).toBe(0.95);
  });

  it('should find element by ARIA label', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Submit Form');
    document.body.appendChild(button);

    const result = SelectorEngine.findElement({ ariaLabel: 'Submit Form' }, '');
    expect(result).not.toBeNull();
    expect(result!.element).toBe(button);
    expect(result!.strategy).toBe(SelectorStrategy.ARIA_LABEL);
    expect(result!.confidence).toBe(0.9);
  });

  it('should find element by Label linked via labelText text content', () => {
    const label = document.createElement('label');
    label.setAttribute('for', 'linked-id');
    label.textContent = 'Linked Input';
    const input = document.createElement('input');
    input.id = 'linked-id';
    document.body.appendChild(label);
    document.body.appendChild(input);

    const result = SelectorEngine.findElement({ labelText: 'Linked Input' }, '');
    expect(result).not.toBeNull();
    expect(result!.element).toBe(input);
    expect(result!.strategy).toBe(SelectorStrategy.LABEL_LINKED);
    expect(result!.confidence).toBe(0.85);
  });

  it('should find nested input inside Label matched by labelText', () => {
    const label = document.createElement('label');
    label.textContent = 'Nested Label';
    const input = document.createElement('input');
    label.appendChild(input);
    document.body.appendChild(label);

    const result = SelectorEngine.findElement({ labelText: 'Nested Label' }, '');
    expect(result).not.toBeNull();
    expect(result!.element).toBe(input);
    expect(result!.strategy).toBe(SelectorStrategy.LABEL_LINKED);
    expect(result!.confidence).toBe(0.85);
  });

  it('should find sibling/proximity input inside the same parent or container group by labelText', () => {
    const formGroup = document.createElement('div');
    formGroup.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = 'Proximity Label';
    const input = document.createElement('input');
    formGroup.appendChild(label);
    formGroup.appendChild(input);
    document.body.appendChild(formGroup);

    const result = SelectorEngine.findElement({ labelText: 'Proximity Label' }, '');
    expect(result).not.toBeNull();
    expect(result!.element).toBe(input);
    expect(result!.strategy).toBe(SelectorStrategy.LABEL_LINKED);
    expect(result!.confidence).toBe(0.80);
  });

  it('should find element by placeholder', () => {
    const input = document.createElement('input');
    input.setAttribute('placeholder', 'Enter email...');
    document.body.appendChild(input);

    const result = SelectorEngine.findElement({ placeholder: 'Enter email...' }, '');
    expect(result).not.toBeNull();
    expect(result!.element).toBe(input);
    expect(result!.strategy).toBe(SelectorStrategy.PLACEHOLDER);
    expect(result!.confidence).toBe(0.8);
  });

  it('should return null for CSS Path when selector is empty (redundant 0.5 layer removed)', () => {
    const div = document.createElement('div');
    div.className = 'container';
    const input = document.createElement('input');
    div.appendChild(input);
    document.body.appendChild(div);

    // CSS Path (0.5) fallback layer is removed, so it should return null when the primary selector is empty
    const result = SelectorEngine.findElement({ cssPath: '.container > input' }, '');
    expect(result).toBeNull();
  });

  it('should find element by XPath fallback (confidence 0.4 >= MIN_SELECTOR_CONFIDENCE)', () => {
    const input = document.createElement('input');
    input.setAttribute('id', 'xpath-id');
    document.body.appendChild(input);

    const mockEvaluate = vi.fn().mockReturnValue({
      singleNodeValue: input,
    });
    const originalEvaluate = document.evaluate;
    document.evaluate = mockEvaluate as any;

    try {
      const result = SelectorEngine.findElement({ xpath: '//input[@id="xpath-id"]' }, '');
      expect(result).not.toBeNull();
      expect(result!.element).toBe(input);
      expect(result!.strategy).toBe(SelectorStrategy.XPATH);
      expect(result!.confidence).toBe(0.4);
    } finally {
      document.evaluate = originalEvaluate;
    }
  });

  it('should pierce and find elements inside Shadow DOM recursively', () => {
    // Setup nested Shadow DOM structure
    const hostEl = document.createElement('div');
    document.body.appendChild(hostEl);

    const shadowRoot = hostEl.attachShadow({ mode: 'open' });
    const nestedInput = document.createElement('input');
    nestedInput.setAttribute('id', 'shadow-input-id');
    nestedInput.setAttribute('name', 'shadow-input-name');
    shadowRoot.appendChild(nestedInput);

    const result = SelectorEngine.findElement({ id: 'shadow-input-id', name: 'shadow-input-name' }, 'input');
    expect(result).not.toBeNull();
    expect(result!.element).toBe(nestedInput);
    expect(result!.strategy).toBe(SelectorStrategy.SHADOW_DOM);
    expect(result!.confidence).toBe(1.0);
    expect(result!.shadow).toBe(true);
  });

  it('should respect priority order fallback when multiple strategies match', () => {
    const input = document.createElement('input');
    input.id = 'priority-id';
    input.setAttribute('name', 'priority-name');
    document.body.appendChild(input);

    // ID should win over Name because it is processed first
    const result = SelectorEngine.findElement({ id: 'priority-id', name: 'priority-name' }, '');
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe(SelectorStrategy.ID);
  });
});
