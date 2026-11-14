import { launcherPosition, snapLauncher, normalizeSpot, defaultPanelSize, clampPanelSize, draggedPanelSize, readPanelSize } from '@ensemble/brand/assistant';

const read = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Appearance can be session-only. */ } };

export function helperLayout(launcher, panel, open) {
  let spot = normalizeSpot(read('ensemble.docs.launcher.v1'));
  let size = readPanelSize(read('ensemble.docs.size.v1'));
  let expanded = false;
  let drag;
  const viewport = () => ({ width: innerWidth, height: innerHeight });
  const bounds = () => ({ ...viewport(), top: document.querySelector('.site-header').getBoundingClientRect().bottom, left: innerWidth > 760 ? document.querySelector('main').getBoundingClientRect().left : 0 });
  function measure() {
    const point = launcherPosition(spot, bounds());
    launcher.style.transform = `translate(${point.x}px, ${point.y}px)`;
    const phone = innerWidth <= 640;
    const shown = clampPanelSize(size ?? defaultPanelSize(viewport()), viewport());
    panel.style.width = phone || expanded ? '' : `${shown.width}px`;
    panel.style.height = phone || expanded ? '' : `${shown.height}px`;
    for (const handle of panel.querySelectorAll('.assistant-resize')) {
      handle.hidden = phone || expanded;
      if (handle.dataset.edge !== 'corner') {
        handle.setAttribute('aria-valuenow', String(handle.dataset.edge === 'left' ? shown.width : shown.height));
        handle.setAttribute('aria-valuemin', String(Math.min(handle.dataset.edge === 'left' ? 380 : 440, handle.dataset.edge === 'left' ? innerWidth - 40 : innerHeight - 40)));
        handle.setAttribute('aria-valuemax', String(handle.dataset.edge === 'left' ? innerWidth - 40 : innerHeight - 40));
      }
    }
  }
  launcher.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, start: spot };
    launcher.setPointerCapture(event.pointerId);
  });
  launcher.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    drag.moved = true;
    launcher.dataset.dragging = '1';
    spot = snapLauncher({ x: event.clientX, y: event.clientY }, bounds());
    measure();
  });
  launcher.addEventListener('pointerup', (event) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const moved = drag.moved;
    drag = null;
    if (launcher.hasPointerCapture(event.pointerId)) launcher.releasePointerCapture(event.pointerId);
    delete launcher.dataset.dragging;
    if (moved) save('ensemble.docs.launcher.v1', spot);
    else open();
  });
  launcher.addEventListener('pointercancel', () => { if (drag) spot = drag.start; drag = null; delete launcher.dataset.dragging; measure(); });
  launcher.addEventListener('click', (event) => { if (event.detail === 0) open(); });
  launcher.addEventListener('keydown', (event) => {
    const delta = event.shiftKey ? .2 : .05;
    const current = normalizeSpot(spot);
    if (event.key === 'ArrowLeft') spot = current.edge === 'bottom' ? { edge: 'bottom', t: current.t - delta } : current.t >= .999 ? { edge: 'bottom', t: 1 - delta } : current;
    else if (event.key === 'ArrowRight') spot = current.edge === 'bottom' ? { edge: 'bottom', t: current.t + delta } : current;
    else if (event.key === 'ArrowUp') spot = current.edge === 'right' ? { edge: 'right', t: current.t - delta } : current.t >= .999 ? { edge: 'right', t: 1 - delta } : current;
    else if (event.key === 'ArrowDown') spot = current.edge === 'right' ? { edge: 'right', t: current.t + delta } : current;
    else return;
    event.preventDefault();
    spot = normalizeSpot(spot);
    launcher.dataset.nudged = '1';
    measure();
    save('ensemble.docs.launcher.v1', spot);
    setTimeout(() => delete launcher.dataset.nudged, 240);
  });
  for (const handle of panel.querySelectorAll('.assistant-resize')) {
    const edge = handle.dataset.edge;
    let resizing;
    const end = () => {
      if (!resizing) return;
      resizing = null;
      delete document.body.dataset.assistantResizing;
      delete handle.dataset.active;
      save('ensemble.docs.size.v1', size);
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || expanded || innerWidth <= 640) return;
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      resizing = { x: event.clientX, y: event.clientY, start: { width: rect.width, height: rect.height } };
      handle.setPointerCapture(event.pointerId);
      handle.dataset.active = '';
      document.body.dataset.assistantResizing = edge;
    });
    handle.addEventListener('pointermove', (event) => {
      if (!resizing) return;
      size = draggedPanelSize(resizing.start, edge, event.clientX - resizing.x, event.clientY - resizing.y, viewport());
      measure();
    });
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    handle.addEventListener('dblclick', () => { size = null; save('ensemble.docs.size.v1', null); measure(); });
    handle.addEventListener('keydown', (event) => {
      if (edge === 'corner' || expanded) return;
      if (event.key === 'Home') { event.preventDefault(); size = null; save('ensemble.docs.size.v1', null); measure(); return; }
      const amount = edge === 'left' ? event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0 : event.key === 'ArrowUp' ? 16 : event.key === 'ArrowDown' ? -16 : 0;
      if (!amount) return;
      event.preventDefault();
      const current = size ?? defaultPanelSize(viewport());
      size = clampPanelSize({ width: current.width + (edge === 'left' ? amount : 0), height: current.height + (edge === 'top' ? amount : 0) }, viewport());
      save('ensemble.docs.size.v1', size);
      measure();
    });
  }
  const expand = panel.querySelector('#helper-expand');
  expand.addEventListener('click', () => {
    expanded = !expanded;
    panel.dataset.expanded = String(expanded);
    expand.setAttribute('aria-label', expanded ? 'Shrink' : 'Expand');
    expand.title = expanded ? 'Shrink' : 'Expand';
    measure();
  });
  addEventListener('resize', measure);
  measure();
  return measure;
}
