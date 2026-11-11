const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('./motion-data.json');
const { createModel, kinds } = require('./geometry.js');
const model = createModel(data);
const loops = ['infinity', 'relay', 'threadline', 'beacon'];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Landmarks captured from the approved loading studies, before integration.
const landmarks = {
    infinity: [[[71.87335,198.1254],[188.87343,124.33695],[255.79036,207.69927],[121.52712,131.95461],[71.87335,198.1254]],[[62.33599,205.40818],[196.61019,133.50987],[246.84405,199.70155],[129.15656,122.69223],[62.33599,205.40818]]],
    relay: [[[78.98781,126.76598],[79.49819,193.64252],[162.01406,192.40183],[159.46254,125.55598],[78.98781,126.76598]],[[158.98781,126.76598],[159.49819,193.64252],[242.01406,192.40183],[239.46254,125.55598],[158.98781,126.76598]]]
};

test('approved infinity and handoff shapes retain their strand correspondence', () => {
    for (const [kind, expected] of Object.entries(landmarks)) {
        const pair = model.target(kind).pair;
        for (let strand = 0; strand < 2; strand++)
            [0, 32, 64, 96, 127].forEach((index, i) => assert.ok(distance(pair[strand][index], expected[strand][i]) < .00001, `${kind} strand ${strand} point ${index}`));
    }
    assert.deepEqual(model.target('beacon'), model.target('infinity'));
    for (let i = 0; i < data.N; i++)
        assert.ok(Math.abs(distance(model.target('infinity').pair[0][i], model.target('infinity').pair[1][i]) - 12) < .00001);
});

test('the compact response wave has a readable optical height at 32 pixels', () => {
    const pair = model.target('threadline').pair;
    const points = pair.flat(), xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    assert.ok(Math.max(...ys) - Math.min(...ys) > 120);
    assert.equal(Math.max(...xs) - Math.min(...xs), 250);
    for (let i = 0; i < data.N; i++) assert.ok(pair[1][i][1] - pair[0][i][1] > 18);
});

test('activity has finite gestures and exact still-logo rests, including 5.95 seconds for peripheral work', () => {
    assert.deepEqual(loops.map(kind => kinds[kind].loop), [7400, 7800, 6800, 8600]);
    for (const kind of loops) {
        const clock = model.timing(kind, 0);
        assert.equal(clock.moving, false);
        assert.equal(clock.wait, .45);
        assert.equal(model.cycle(kind, .2).frame, model.base);
        assert.equal(model.cycle(kind, kinds[kind].loop / 1000 - .1).frame, model.base);
        assert.equal(model.cycle(kind, 1.5).rest, 0);
    }
    const clock = model.timing('beacon', 3.1);
    assert.ok(Math.abs(clock.wait - 5.95) < .00001);
    assert.equal(model.cycle('beacon', 3.2).rest, 1);
});

test('all frames stay finite and bounded without collapsing the whole mark', () => {
    for (const kind of loops) {
        for (let seconds = 0; seconds < kinds[kind].loop / 1000; seconds += .05) {
            const points = model.cycle(kind, seconds).frame.pair.flat();
            assert.equal(points.length, data.N * 2);
            for (const [x, y] of points) assert.ok(Number.isFinite(x) && Number.isFinite(y) && x > 0 && x < 320 && y > 0 && y < 320);
            const xs = points.map(p => p[0]);
            assert.ok(Math.max(...xs) - Math.min(...xs) > 140, `${kind} collapses at ${seconds}`);
        }
    }
});

test('cycle seams and interruption settlement preserve position continuity', () => {
    for (const kind of loops) {
        const clock = model.timing(kind, 0);
        for (const boundary of [.45, clock.arrive, clock.release, clock.end, clock.duration]) {
            const before = model.cycle(kind, boundary - .000001).frame;
            const after = model.cycle(kind, boundary + .000001).frame;
            for (let strand = 0; strand < 2; strand++)
                for (let i = 0; i < data.N; i++) assert.ok(distance(before.pair[strand][i], after.pair[strand][i]) < .001);
        }
        const from = model.cycle(kind, 2).frame;
        assert.deepEqual(model.settle(from, 0), from);
        assert.deepEqual(model.settle(from, 1), model.base);
    }
    assert.equal(model.once(.72).rest, 1);
    assert.equal(model.once(.72).moving, false);
});
