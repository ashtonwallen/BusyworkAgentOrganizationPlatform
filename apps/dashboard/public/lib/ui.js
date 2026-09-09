import { icon } from './icons.js';
import { esc } from './format.js';

export function pageTitle(title, subtitle, actions = '') {
  return `<div class="page-title"><div><h1>${esc(title)} ${helpTip(subtitle, title)}</h1></div><div class="title-actions">${actions}</div></div>`;
}

let helpSequence = 0;
export function helpTip(description, label = '') {
  if (!description) return '';
  description = /[.!?]$/.test(description.trim()) ? description : `${description.trim()}.`;
  const id = `help-${++helpSequence}`;
  return `<span class="help-tip" tabindex="0" aria-label="${esc(label || description.split(/[.!?]/)[0])} details" aria-describedby="${id}">i<span class="help-popup" role="tooltip" id="${id}">${esc(description)}</span></span>`;
}

export function button(label, action, name = 'plus', primary = true) {
  return `<button class="btn-icon ${primary ? 'primary' : ''}" data-action="${action}">${icon(name)}${esc(label)}</button>`;
}

export function empty(title, description, action = '', name = 'leaf') {
  return `<div class="empty"><div class="empty-icon">${icon(name)}</div><h3>${esc(title)} ${helpTip(description, title)}</h3>${action}</div>`;
}

export function metric(label, value, foot, name = 'finance') {
  return `<div class="metric"><div class="metric-label">${esc(label)}${icon(name)}</div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></div>`;
}

export function card(title, body, options = {}) {
  const subtitle = options.subtitle && /^\d/.test(options.subtitle) ? `<div class="card-subtitle">${esc(options.subtitle)}</div>` : '';
  const aside = options.aside ?? '';
  const footer = options.footer ? `<div class="card-footer">${options.footer}</div>` : '';
  const head = title ? `<div class="card-header"><div><h2>${esc(title)} ${subtitle ? '' : helpTip(options.subtitle, title)}</h2>${subtitle}</div>${aside}</div>` : '';
  return `<section class="card ${options.className ?? ''}">${head}${body}${footer}</section>`;
}

export function table(columns, rows) {
  if (!rows.length) return '';
  return `<div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th${c.numeric ? ' class="numeric"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

export function link(label, page) {
  return `<button class="text-link" data-page="${page}">${esc(label)} ${icon('arrow')}</button>`;
}

/**
 * A small bar. Consumption against a cap warns as it fills; progress toward a
 * target does not, because reaching it is the point.
 */
export function meter(used, total, options = {}) {
  const ratio = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  const state = options.progress ? '' : ratio >= 90 ? 'over' : ratio >= 70 ? 'warn' : '';
  return `<div class="budget-line ${state}"><div style="width:${ratio.toFixed(1)}%"></div></div>${options.caption ? `<div class="budget-summary muted">${options.caption}</div>` : ''}`;
}
