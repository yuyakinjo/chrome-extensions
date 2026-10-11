export const SETTINGS_KEY = 'autoPipSettings';

export async function readSettings(): Promise<AutoPipSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<AutoPipSettings> | undefined;
  return {
    enabled: raw?.enabled !== false,
    disabledOrigins: Array.isArray(raw?.disabledOrigins)
      ? raw.disabledOrigins.filter((origin): origin is string => typeof origin === 'string') : [],
  };
}

export async function writeSettings(value: AutoPipSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: value });
}
