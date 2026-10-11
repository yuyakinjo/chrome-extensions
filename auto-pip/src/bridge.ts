// ISOLATED world: 設定は拡張の storage から読み、MAIN world には ON/OFF だけ渡す。
(() => {
  let currentEnabled = false;
  let revision = 0;
  function send(): void {
    window.dispatchEvent(new CustomEvent('chrome-auto-pip:configure-v1', { detail: currentEnabled }));
  }
  function apply(raw: unknown): void {
    const value = raw && typeof raw === 'object' ? raw as Partial<AutoPipSettings> : {};
    const disabled = Array.isArray(value.disabledOrigins) ? value.disabledOrigins : [];
    currentEnabled = value.enabled !== false && !disabled.includes(location.origin);
    send();
  }

  window.addEventListener('chrome-auto-pip:ready-v1', send);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.autoPipSettings) {
      revision++;
      apply(changes.autoPipSettings.newValue);
    }
  });
  const initialRevision = revision;
  void chrome.storage.local.get('autoPipSettings').then((stored) => {
    // 読み取り中に設定が変わった場合は古いスナップショットで上書きしない。
    if (revision === initialRevision) apply(stored.autoPipSettings);
  }).catch(() => {
    currentEnabled = false;
    send();
  });
})();
