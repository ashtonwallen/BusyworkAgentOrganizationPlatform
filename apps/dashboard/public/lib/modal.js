import { icon } from './icons.js';
import { esc } from './format.js';
import { modal } from './state.js';
import { ctx } from './context.js';
import { toast } from './api.js';
import { helpTip } from './ui.js';

export function openModal(title, body, options = {}) {
  modal.className = options.wide ? 'wide' : '';
  modal.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button data-action="close-modal" aria-label="Close">${icon('close')}</button></div><div class="modal-body">${body}<p id="modal-error" class="error-message" role="alert"></p></div>`;
  if (!modal.open) modal.showModal();
  modal.querySelector('.modal-body').scrollTop = 0;
}

export function closeModal() { if (modal.open) modal.close(); }

export function field(label, name, value = '', type = 'text', help = '') {
  const currency = /Usd$/.test(name);
  if (currency) type = 'number';
  const control = type === 'textarea'
    ? `<textarea id="f-${name}" name="${name}" required>${esc(value)}</textarea>`
    : `<input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" required${currency ? ' min="0" step="0.01" inputmode="decimal"' : type === 'number' ? ` min="${['minutes','maxDepth'].includes(name) ? 0 : 1}" step="1" inputmode="numeric"` : ''}>`;
  return `<div class="field"><label for="f-${name}">${esc(label)} <small>Required</small> ${helpTip(help, label)}</label>${control}</div>`;
}

export function selectField(label, name, options, value = '') {
  if (options.length === 1) return `<div class="field"><label>${esc(label)}</label><p>${esc(options[0][1])}</p><input type="hidden" name="${esc(name)}" value="${esc(options[0][0])}"></div>`;
  return `<div class="field"><label for="f-${name}">${esc(label)}</label><select id="f-${name}" name="${name}">${options.map(([v, t]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
}

export function form(body, label = 'Save') {
  return `<form id="modal-form" novalidate>${body}<div class="form-actions"><button type="button" data-action="close-modal">Cancel</button><button type="submit" class="primary">${esc(label)}</button></div></form>`;
}

export function detail(sections) {
  return sections.filter(([, v]) => v).map(([k, v]) => `<div class="detail-row"><h3>${esc(k)}</h3><p>${esc(v)}</p></div>`).join('');
}

/** Submits the open modal form, reports failures inside the dialog, and refreshes on success. */
export function handleModal(handler, message = 'Recorded in the company log.') {
  document.querySelector('#modal-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.target.querySelectorAll('.field-error').forEach(el => el.remove());
    let firstInvalid;
    for (const input of e.target.querySelectorAll('input,textarea,select')) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
      if (!input.validity.valid || (input.required && !input.value.trim())) {
        const error = document.createElement('small');
        error.className = 'field-error error-message';
        error.id = `${input.id}-error`;
        error.textContent = input.validity.rangeUnderflow ? `Enter ${input.min} or more.` : input.validity.stepMismatch ? `Use increments of ${input.step}.` : input.validity.badInput ? 'Enter a number.' : 'Complete this field.';
        input.after(error);
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', error.id);
        firstInvalid ||= input;
      }
    }
    if (firstInvalid) { firstInvalid.focus(); return; }
    const submit = e.target.querySelector('button[type=submit]');
    submit.disabled = true;
    try {
      const result = await handler(Object.fromEntries(new FormData(e.target)));
      if (result === false) return;
      closeModal();
      await ctx.refresh(true);
      toast(message);
    } catch (error) {
      const target = document.querySelector('#modal-error');
      if (target) target.textContent = error instanceof SyntaxError ? 'That is not valid JSON. Check for a missing quote or brace.' : error.message;
    } finally {
      submit.disabled = false;
    }
  });
}
