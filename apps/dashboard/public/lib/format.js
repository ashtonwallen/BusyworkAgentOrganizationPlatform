export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const money = (v, digits = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: Math.min(digits, 2) }).format(Number(v || 0));

/** Ledger and call amounts are stored as integer millionths of a dollar. */
export const micro = (v, digits = 2) => money(Number(v || 0) / 1e6, digits);

export const date = (v) => (v ? new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');

export const dateTime = (v) => (v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

export const ago = (v) => {
  const minutes = Math.floor((Date.now() - new Date(v).getTime()) / 60000);
  if (minutes < 0) return `in ${until(v)}`;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`;
  return date(v);
};

export const until = (v) => {
  const minutes = Math.floor((new Date(v).getTime() - Date.now()) / 60000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
};

export const titleCase = (v) => String(v || '').toLowerCase().replace(/_/g, ' ').replace(/(^|\s)\S/g, (c) => c.toUpperCase());

export const truncate = (v, length) => {
  const s = String(v ?? '');
  return s.length > length ? `${esc(s.slice(0, length).trimEnd())}…` : esc(s);
};

const GOOD = ['COMPLETED', 'PASS', 'RUNNING', 'EXECUTED', 'DONE', 'REPEATING', 'DELIVERING', 'APPROVED', 'SENT', 'ACTIVE', 'READY', 'SUCCEEDED'];
const BAD = ['FAILED', 'KILLED', 'REJECTED', 'CANCELLED', 'BLOCK', 'EXPIRED', 'DECLINED', 'RETIRED', 'REVOKED'];
const WARN = ['PENDING', 'BLOCKED_APPROVAL', 'BLOCKED_BUDGET', 'PAUSED', 'UNCERTAIN', 'REVISE', 'REVIEW', 'OPEN', 'VALIDATING'];

export const tone = (v) => (GOOD.includes(v) ? 'green' : BAD.includes(v) ? 'red' : WARN.includes(v) ? 'amber' : 'blue');

export const badge = (v, label) => `<span class="badge ${tone(v)}">${esc(label ?? titleCase(v))}</span>`;

/**
 * The API returns and accepts six-decimal USD strings. Editable fields show the
 * cents for ordinary budget controls. Accounting retains micro-dollar precision.
 */
export const usdInput = (v) => {
  return Number(v ?? 0).toFixed(2);
};

/** Local wall-clock value for a datetime-local input. */
export const localDateTime = (value) => new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
