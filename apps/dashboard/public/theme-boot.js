/* Set both preferences before first paint, including migration from old themes. */
(function () {
  var theme, mode;
  try { theme = localStorage.getItem('hive-theme'); mode = localStorage.getItem('hive-mode'); } catch (e) { /* Storage unavailable. */ }
  if (mode !== 'light' && mode !== 'dark') {
    mode = ['dark', 'slate', 'contrast'].includes(theme) ? 'dark'
      : ['light', 'paper'].includes(theme) ? 'light'
      : 'light';
  }
  if (!['classic', 'slate', 'paper', 'contrast'].includes(theme)) theme = 'slate';
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.mode = mode;
  try { localStorage.setItem('hive-theme', theme); localStorage.setItem('hive-mode', mode); } catch (e) { /* Session-only preference. */ }
})();
