// Context menus, popovers, modals and toasts.
import { h, icon, add } from './h.js';

let openMenu = null;
export function closeMenus() { openMenu?.close(); openMenu = null; }

function place(el, x, y, anchor) {
  document.body.append(el);
  const r = el.getBoundingClientRect();
  const W = window.innerWidth; const H = window.innerHeight;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    x = a.left; y = a.bottom + 4;
    if (y + r.height > H - 8) y = Math.max(8, a.top - r.height - 4);
  }
  if (x + r.width > W - 8) x = Math.max(8, W - r.width - 8);
  if (y + r.height > H - 8) y = Math.max(8, H - r.height - 8);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

/** items: [{ label, icon, kbd, onClick, danger, disabled, checked } | '-' ] */
export function contextMenu(e, items) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  closeMenus();
  const el = h('div', { class: 'menu', role: 'menu' });
  for (const it of items.filter(Boolean)) {
    if (it === '-') { el.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.header) { el.append(h('div', { class: 'menu-head' }, it.header)); continue; }
    el.append(h('button', {
      class: 'menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''),
      onclick: (ev) => { ev.stopPropagation(); if (it.disabled) return; closeMenus(); it.onClick?.(); },
    }, h('span', { class: 'menu-ic' }, it.checked ? icon('check') : it.icon ? icon(it.icon) : null), h('span', { class: 'menu-label' }, it.label), it.kbd ? h('span', { class: 'menu-kbd' }, it.kbd) : null));
  }
  place(el, e?.clientX ?? 0, e?.clientY ?? 0, e?.anchor);
  const away = (ev) => { if (!el.contains(ev.target)) closeMenus(); };
  const esc = (ev) => { if (ev.key === 'Escape') closeMenus(); };
  setTimeout(() => { document.addEventListener('mousedown', away, true); document.addEventListener('keydown', esc, true); });
  openMenu = { close: () => { el.remove(); document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', esc, true); } };
  return openMenu;
}

/** A floating panel under an anchor element. Returns { el, close }. */
export function popover(anchor, content, { onClose, cls = '' } = {}) {
  closeMenus();
  const el = h('div', { class: 'popover ' + cls }, content);
  place(el, 0, 0, anchor);
  const close = () => { el.remove(); document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', esc, true); onClose?.(); if (openMenu === handle) openMenu = null; };
  const away = (ev) => { if (!el.contains(ev.target) && !anchor.contains(ev.target)) close(); };
  const esc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  setTimeout(() => { document.addEventListener('mousedown', away, true); document.addEventListener('keydown', esc, true); });
  const handle = { el, close };
  openMenu = handle;
  return handle;
}

/** Modal dialog. Returns { el, body, foot, close }. */
export function modal({ title, subtitle, body, foot, width = 560, onClose, cls = '' }) {
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: 'modal ' + cls, style: { width: width + 'px' }, role: 'dialog' });
  const head = h('div', { class: 'modal-head' }, h('div', {}, h('div', { class: 'modal-title' }, title), subtitle ? h('div', { class: 'modal-sub' }, subtitle) : null),
    h('button', { class: 'icon-btn modal-x', title: 'Close', onclick: () => close() }, icon('x')));
  const b = h('div', { class: 'modal-body' }, body);
  const f = foot ? h('div', { class: 'modal-foot' }, foot) : null;
  add(box, head, b, f);
  back.append(box);
  document.body.append(back);
  let closed = false;
  const close = () => { if (closed) return; closed = true; back.classList.add('out'); setTimeout(() => back.remove(), 120); document.removeEventListener('keydown', esc, true); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape' && !document.querySelector('.popover, .menu')) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  requestAnimationFrame(() => back.classList.add('in'));
  return { el: box, body: b, foot: f, close };
}

export function confirmBox({ title, message, ok = 'OK', danger = false, cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const okBtn = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => finish(true) }, ok);
    const m = modal({ title, body: h('div', { class: 'confirm-msg' }, message), width: 420, onClose: () => finish(false),
      foot: [h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => finish(false) }, cancel), okBtn] });
    setTimeout(() => okBtn.focus(), 30);
  });
}

export function promptBox({ title, label, value = '', ok = 'OK' }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value });
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value); });
    const m = modal({ title, body: h('label', { class: 'field' }, h('span', {}, label), input), width: 420, onClose: () => finish(null),
      foot: [h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => finish(input.value) }, ok)] });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

let toastBox;
export function toast(msg, kind = 'info', ms = 3200) {
  toastBox ||= document.body.appendChild(h('div', { class: 'toasts' }));
  const t = h('div', { class: 'toast ' + kind }, icon(kind === 'error' ? 'warning' : kind === 'ok' ? 'check' : 'info'), h('span', {}, msg));
  toastBox.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 200); }, ms);
}
