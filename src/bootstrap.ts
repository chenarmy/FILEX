const storageKey = 'filex.safe-settings.v1';
const stored = localStorage.getItem(storageKey);

if (stored) {
  try {
    const settings = JSON.parse(stored) as Record<string, unknown>;
    if (settings.theme === 'light' || settings.theme === 'dark') {
      document.documentElement.classList.add(settings.theme);
    }
    if (settings.locale === 'zh-CN' || settings.locale === 'en-US') {
      document.documentElement.lang = settings.locale;
    }
    if (typeof settings.uiFontSize === 'number' && Number.isFinite(settings.uiFontSize)) {
      document.documentElement.style.fontSize = `${Math.min(20, Math.max(11, settings.uiFontSize))}px`;
    }
  } catch {
    localStorage.removeItem(storageKey);
  }
}
