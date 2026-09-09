/** Palette and brightness are independent, browser-local preferences. */
export const THEMES = [
  { id: 'classic', label: 'Classic' },
  { id: 'slate', label: 'Slate' },
  { id: 'paper', label: 'Paper' },
  { id: 'contrast', label: 'High contrast' },
];
export function currentTheme() { return document.documentElement.dataset.theme || 'classic'; }
export function currentMode() { return document.documentElement.dataset.mode || 'light'; }
export function applyTheme(id = currentTheme(), mode = currentMode()) {
  const chosen = THEMES.some(t => t.id === id) ? id : 'classic';
  const brightness = mode === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  root.dataset.theme = chosen;
  root.dataset.mode = brightness;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
  document.querySelectorAll('[data-theme-choice]').forEach(button => {
    const selected = button.dataset.themeChoice === chosen;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('[data-mode-choice]').forEach(button => {
    const selected = button.dataset.modeChoice === brightness;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  return chosen;
}
export function setTheme(id) {
  applyTheme(id);
  try { localStorage.setItem('hive-theme', currentTheme()); localStorage.setItem('hive-mode', currentMode()); } catch { /* Session-only preference. */ }
}
export function setMode(mode) {
  applyTheme(currentTheme(), mode);
  try { localStorage.setItem('hive-theme', currentTheme()); localStorage.setItem('hive-mode', currentMode()); } catch { /* Session-only preference. */ }
}
