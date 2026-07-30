import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupChromeMocks } from './helpers/chromeMock';
import { FormResetter } from '../src/content/FormResetter';
import { StateManager } from '../src/content/engines/StateManager';
import { Step, Action } from '../src/types';

describe('Pre-Row Navigation & Starting URL Verification Tests', () => {
  let sendMessageMock: any;
  let formResetter: FormResetter;

  beforeEach(async () => {
    setupChromeMocks();
    document.body.innerHTML = '';
    sendMessageMock = vi.fn().mockResolvedValue({ received: true });
    formResetter = new FormResetter(sendMessageMock);

    // Initialize an active session state so StateManager.updateState succeeds
    await StateManager.initializeSession(
      'session-test',
      2,
      'rec-1',
      'http://localhost/form-start-page',
      -1
    );
  });

  it('resetFormBetweenRows — when on same siteUrl and form element is ready, proceeds in-page without navigation', async () => {
    const siteUrl = window.location.href;
    const input = document.createElement('input');
    input.id = 'first-name';
    document.body.appendChild(input);

    // Mock dismissSuccessUI to return true
    vi.spyOn(formResetter, 'dismissSuccessUI').mockResolvedValue(true);

    const recordingSteps: Step[] = [
      {
        id: 'step-1',
        action: Action.FILL,
        selector: 'input#first-name',
        selectorMeta: { id: 'first-name', cssPath: 'input#first-name' },
        value: 'John',
        pageId: 'page-1'
      }
    ];

    await expect(formResetter.resetFormBetweenRows(recordingSteps, siteUrl, 'session-test')).resolves.toBeUndefined();
    expect(formResetter.dismissSuccessUI).toHaveBeenCalled();
  }, 10000);

  it('resetFormBetweenRows — when URL differs from siteUrl (e.g. redirected to /thank-you), triggers state update and navigation', async () => {
    const siteUrl = 'http://localhost/form-start-page';
    const recordingSteps: Step[] = [
      {
        id: 'step-1',
        action: Action.FILL,
        selector: 'input#first-name',
        selectorMeta: { id: 'first-name', cssPath: 'input#first-name' },
        value: 'John',
        pageId: 'page-1'
      }
    ];

    // Spy on dismissSuccessUI — should NOT be called if URL is different
    const dismissSpy = vi.spyOn(formResetter, 'dismissSuccessUI');

    // Execute resetFormBetweenRows
    await formResetter.resetFormBetweenRows(recordingSteps, siteUrl, 'session-test');

    // Verify dismissSuccessUI was skipped due to URL mismatch
    expect(dismissSpy).not.toHaveBeenCalled();
    // Verify state message was sent with updated currentUrl
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: expect.anything(),
        payload: expect.objectContaining({
          state: expect.objectContaining({ currentUrl: siteUrl })
        })
      }),
      5000
    );
  }, 10000);

  it('isElementVisible — correctly identifies hidden vs visible DOM elements', () => {
    const visibleEl = document.createElement('div');
    visibleEl.style.display = 'block';
    visibleEl.style.width = '100px';
    visibleEl.style.height = '50px';
    document.body.appendChild(visibleEl);

    // JS-DOM getBoundingClientRect mock for width/height
    vi.spyOn(visibleEl, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 50,
      top: 0,
      left: 0,
      bottom: 50,
      right: 100,
      x: 0,
      y: 0,
      toJSON: () => {}
    });

    expect(formResetter.isElementVisible(visibleEl)).toBe(true);

    const hiddenEl = document.createElement('div');
    hiddenEl.style.display = 'none';
    document.body.appendChild(hiddenEl);
    expect(formResetter.isElementVisible(hiddenEl)).toBe(false);
  });
});
