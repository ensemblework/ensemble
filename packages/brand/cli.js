'use strict';
const { frames, braille } = require('./cli-data.json');
/** Never emit control codes here; Ink owns rendering and screen restoration. */
function terminalBrand(env = {}, tty = false) {
    const plain = !tty || env.TERM === 'dumb';
    const noColor = env.NO_COLOR !== undefined;
    return { animated: !plain && env.ENSEMBLE_REDUCE_MOTION !== '1', color: noColor || plain ? undefined : /truecolor|24bit/i.test(env.COLORTERM || '') ? '#D7B56F' : 'yellow', frames: plain ? ['[e] '] : frames, still: '[e] ', interval: 125 };
}
module.exports = { terminalBrand, braille };
