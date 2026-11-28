import '../ui-test-dom.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { agentFrame, markSizes, stepPose, type MarkSize, type Pose } from '../../../../packages/brand/web-activity/geometry';
import { AgentActivityMark } from './agent-activity-mark';
import { MotionContextProvider } from './motion-context';

test('one visible 28% cut runs at constant length around both lobes, including across the seam', () => {
  for (const [size, [w, h]] of Object.entries(markSizes)) {
    for (const phase of [0, .125, .25, .48, .625, .75, .875, .999]) {
      const { a, b, width } = agentFrame('infinity', size as MarkSize, 1, phase);
      assert.equal(b, '', 'no backing track can bridge the opening');
      assert(!a.includes('Z'));
      const points = a.slice(1).split('L').map(p => p.split(',').map(Number));
      const visible = width + points.slice(1).reduce((len, [x, y], i) => len + Math.hypot(x - points[i][0], y - points[i][1]), 0);
      const rx = (w - width - 1.6) / 2, ry = Math.min(h * .385, rx * .63);
      const full = Array.from({ length: 2048 }, (_, i) => {
        const t = 2 * Math.PI * i / 2048;
        return Math.hypot(rx * Math.cos(t), 2 * ry * Math.cos(2*t)) * 2 * Math.PI / 2048;
      }).reduce((x,y) => x+y);
      assert(Math.abs(1 - visible / full - .28) < .002, `${size}, phase ${phase}`);
    }
  }
});

test('a live phase keeps looping; a retarget or early finish returns from the current pose', () => {
  const pose: Pose = { q: 0, velocity: 0, phase: .16, kind: 'exchange' };
  for (let i = 0; i < 12; i++) stepPose(pose, 'exchange', 1/30);
  assert(pose.q > .5 && pose.q < 1);
  const before = pose.q; stepPose(pose, null, 0); assert.equal(pose.q, before);
  for (let i = 0; i < 4; i++) stepPose(pose, null, 1/30);
  assert(pose.q < before && pose.q > 0);
  for (let i = 0; i < 100; i++) stepPose(pose, 'weave', 1/30);
  assert.equal(pose.kind, 'weave'); assert.equal(pose.q, 1);
  const phase = pose.phase; stepPose(pose, 'weave', 1/30); assert.notEqual(pose.phase, phase);
  for (let i = 0; i < 50; i++) stepPose(pose, null, 1/30);
  assert.deepEqual([pose.q, pose.velocity], [0, 0]);
});

test('a short wait never opens; reduced motion uses the knot and releases the active slot', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = (active: boolean) => act(() => root.render(<MotionContextProvider value={{ theme: 'expressive', reduce: true }}><AgentActivityMark kind={active ? 'weave' : null} /></MotionContextProvider>));
  const wait = () => act(async () => { await new Promise(r=>setTimeout(r, 390)); });
  try {
    await render(true); assert.equal(host.querySelector('[data-live]'), null);
    await render(false); await wait(); assert.equal(host.childElementCount, 0);
    await render(true); await wait(); assert.ok(host.querySelector('[data-rest]'));
    assert.equal(host.querySelector('[data-live] path[d]'), null);
    await render(false); assert.equal(host.childElementCount, 0);
  } finally { await act(() => root.unmount()); host.remove(); }
});
