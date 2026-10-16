/** Scale typography without resizing the layout or the control being dragged. */
module.exports = () => ({
  postcssPlugin: 'ensemble-text-scale',
  Declaration(decl) {
    if (!['font-size', 'line-height'].includes(decl.prop) || decl.value.includes('var(--text-scale')) return;
    if (!/^\d*\.?\d+(px|rem)$/.test(decl.value)) return;
    decl.value = `calc(${decl.value} * var(--text-scale, 1))`;
  },
});
module.exports.postcss = true;
