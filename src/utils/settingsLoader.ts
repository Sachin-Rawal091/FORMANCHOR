import { UserSettings } from "../types";
import { RetryEngine } from "../content/engines/RetryEngine";
import { STEP_DELAY } from "../shared/constants";
import { logger } from "./logger";

/**
 * Loads custom user settings overrides from extension local storage
 * and updates RetryEngine parameters and step delay.
 */
export async function loadAndApplyUserSettings(): Promise<number> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const localData = await chrome.storage.local.get('settings');
      const settings = (localData.settings || {}) as UserSettings;
      
      RetryEngine.customSettings = {
        waitElementTimeout: settings.waitElementTimeout,
        maxStepRetries: settings.maxStepRetries
      };
      
      const stepDelay = settings.stepDelay ?? STEP_DELAY;
      logger.info('SettingsLoader', 'Custom settings loaded:', {
        stepDelay,
        waitElementTimeout: RetryEngine.customSettings.waitElementTimeout,
        maxStepRetries: RetryEngine.customSettings.maxStepRetries
      });
      return stepDelay;
    }
  } catch (err) {
    logger.error('SettingsLoader', 'Failed to load custom settings:', err);
  }
  return STEP_DELAY;
}
