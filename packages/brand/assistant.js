'use strict';
const LAUNCHER_SIZE = 44;
const LAUNCHER_MARGIN = 16;
const DEFAULT_LAUNCHER_SPOT = { edge: 'bottom', t: 1 };
const clamp01 = value => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
function normalizeSpot(value) {
  if (value?.edge === 'free') {
    const x = clamp01(Number(value.x)), y = clamp01(Number(value.y));
    return 1 - x < 1 - y ? { edge: 'right', t: y } : { edge: 'bottom', t: x };
  }
  return value && ['bottom', 'right'].includes(value.edge) ? { edge: value.edge, t: clamp01(Number(value.t)) } : DEFAULT_LAUNCHER_SPOT;
}
function launcherPosition(value, bounds) {
  const spot = normalizeSpot(value), minX = (bounds.left ?? 0) + LAUNCHER_MARGIN;
  const maxX = Math.max(minX, bounds.width - LAUNCHER_SIZE - LAUNCHER_MARGIN);
  const minY = bounds.top + LAUNCHER_MARGIN, maxY = Math.max(minY, bounds.height - LAUNCHER_SIZE - LAUNCHER_MARGIN);
  return spot.edge === 'right' ? { x: maxX, y: Math.round(minY + spot.t * (maxY - minY)) } : { x: Math.round(minX + spot.t * (maxX - minX)), y: maxY };
}
function snapLauncher(point, bounds) {
  const minX = (bounds.left ?? 0) + LAUNCHER_MARGIN, maxX = Math.max(minX, bounds.width - LAUNCHER_SIZE - LAUNCHER_MARGIN);
  const minY = bounds.top + LAUNCHER_MARGIN, maxY = Math.max(minY, bounds.height - LAUNCHER_SIZE - LAUNCHER_MARGIN);
  const x = point.x - LAUNCHER_SIZE / 2, y = point.y - LAUNCHER_SIZE / 2;
  return maxX - x < maxY - y ? { edge: 'right', t: clamp01((y - minY) / Math.max(1, maxY - minY)) } : { edge: 'bottom', t: clamp01((x - minX) / Math.max(1, maxX - minX)) };
}
const PANEL_DEFAULT = { width: 660, height: 720 }, PANEL_MIN = { width: 380, height: 440 };
const PANEL_MARGIN = 20, PANEL_PHONE_MAX = 640, PANEL_EDGES = ['left', 'top', 'corner'];
function panelBounds(viewport) {
  const max = { width: Math.max(0, viewport.width - 2 * PANEL_MARGIN), height: Math.max(0, viewport.height - 2 * PANEL_MARGIN) };
  return { min: { width: Math.min(PANEL_MIN.width, max.width), height: Math.min(PANEL_MIN.height, max.height) }, max };
}
function clampPanelSize(size, viewport) {
  const { min, max } = panelBounds(viewport);
  return { width: Math.round(Math.min(max.width, Math.max(min.width, size.width))), height: Math.round(Math.min(max.height, Math.max(min.height, size.height))) };
}
function defaultPanelSize(viewport) {
  return clampPanelSize({ width: Math.min(PANEL_DEFAULT.width, viewport.width * .94), height: Math.min(PANEL_DEFAULT.height, viewport.height * .85) }, viewport);
}
function readPanelSize(value) {
  return value && typeof value.width === 'number' && typeof value.height === 'number' && Number.isFinite(value.width) && Number.isFinite(value.height) ? { width: value.width, height: value.height } : null;
}
function draggedPanelSize(start, edge, dx, dy, viewport) {
  return clampPanelSize({ width: edge === 'top' ? start.width : start.width - dx, height: edge === 'left' ? start.height : start.height - dy }, viewport);
}
module.exports = { LAUNCHER_SIZE, DEFAULT_LAUNCHER_SPOT, normalizeSpot, launcherPosition, snapLauncher, PANEL_DEFAULT, PANEL_MIN, PANEL_MARGIN, PANEL_PHONE_MAX, PANEL_EDGES, panelBounds, clampPanelSize, defaultPanelSize, readPanelSize, draggedPanelSize };
