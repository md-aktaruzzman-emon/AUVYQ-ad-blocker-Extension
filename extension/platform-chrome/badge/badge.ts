/*
 * AUVYQ browser action badge & tooltip status manager.
 */
import type { Settings, RiskResult } from '../../types/schemas.js';

export async function updateBadge(settings: Settings, threat?: RiskResult): Promise<void> {
  try {
    if (!chrome.action?.setBadgeText) return;

    if (!settings.masterEnabled) {
      await chrome.action.setBadgeText({ text: '×' });
      await chrome.action.setBadgeBackgroundColor({ color: '#77738F' });
      await chrome.action.setTitle({ title: 'AUVYQ — Protection disabled' });
      return;
    }

    if (threat !== undefined && (threat.severity === 'high' || threat.severity === 'malicious')) {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
      await chrome.action.setTitle({ title: 'AUVYQ — Threat detected' });
      return;
    }

    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#22C55E' });
    await chrome.action.setTitle({ title: 'AUVYQ — Protected' });
  } catch {
    // non-fatal in mock/test contexts
  }
}
