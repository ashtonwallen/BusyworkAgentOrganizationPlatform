let onUnauthorized = () => {};

export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function download(path, filename) {
  const response = await fetch('/v1' + path);
  if (!response.ok) {
    if (response.status === 401) onUnauthorized();
    throw new Error(response.status === 401 ? 'Sign in, then retry the download.' : 'Download failed. Please retry.');
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function api(path, method = 'GET', body) {
  const options = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
  let response = await fetch('/v1' + path, options);
  // Only retry the read-only snapshot. Never replay a mutation automatically.
  for (let attempt = 0; path === '/snapshot' && response.status === 401 && attempt < 2; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
    response = await fetch('/v1' + path, options);
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') onUnauthorized();
    const detail = data.issues ? '\n' + data.issues.map((i) => i.path.join('.') + ': ' + i.message).join('\n') : '';
    throw new Error(data.error + detail);
  }
  return data;
}

export function toast(text) {
  const el = document.querySelector('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el.dataset.timer);
  el.dataset.timer = setTimeout(() => el.classList.remove('show'), 5000);
}
