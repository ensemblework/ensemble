const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalBrand } = require('./cli.js');
const { staticSVG } = require('./index.js');
test('plain output, NO_COLOR and reduced motion have independent fallbacks', () => {
  assert.equal(terminalBrand({}, false).animated, false);
  assert.deepEqual(terminalBrand({TERM:'dumb'}, true).frames, ['[e] ']);
  assert.equal(terminalBrand({NO_COLOR:''}, true).color, undefined);
  assert.equal(terminalBrand({ENSEMBLE_REDUCE_MOTION:'1'}, true).animated, false);
  assert.equal(terminalBrand({COLORTERM:'truecolor'}, true).color, '#D7B56F');
  assert.equal(terminalBrand({}, true).color, 'yellow');
  for (const frame of terminalBrand({}, true).frames) assert.equal([...frame].length, 4);
});
test('logo labels are escaped and caller IDs stay scoped', () => {
  const svg = staticSVG(32, {label:'A "quoted" <label>',id:'a:b'});
  assert.match(svg,/A &quot;quoted&quot; &lt;label&gt;/);
  assert.match(svg,/id="a_b-a"/);
  assert.doesNotMatch(svg,/wc-d-/);
  assert.match(staticSVG(32,{tone:'white'}),/color="#FFFFFF"/);
  assert.doesNotMatch(staticSVG(32,{tone:'ink'}),/stroke="url/);
});
