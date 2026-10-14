'use strict';
const art = require('./artwork.json');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** The approved Woven Chorus master. IDs are scoped by the caller for SSR. */
function svgBody({ id = 'woven', tone = 'gold', micro = false } = {}) {
    const prefix = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    let body = (micro ? art.micro : art.body).replace(/wc-d-/g, prefix + '-');
    if (tone !== 'gold' && tone !== 'auto')
        body = body.replace(/url\(#[^)]+\)/g, 'currentColor');
    if (micro && (tone === 'gold' || tone === 'auto'))
        body = body.replace(/currentColor/g, '#D7B56F');
    return body;
}
function staticSVG(size = 32, opts = {}) {
    const color = opts.tone === 'white' ? '#FFFFFF' : opts.tone === 'ink' ? '#1C1915' : 'inherit';
    const a11y = opts.label ? `role="img" aria-label="${escape(opts.label)}"` : 'aria-hidden="true"';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${Number(size)}" height="${Number(size)}" viewBox="0 0 320 320" data-brand-tone="${opts.tone || 'gold'}" color="${color}" ${a11y} focusable="false">${svgBody({ ...opts, micro: opts.micro ?? size <= 20 })}</svg>`;
}
module.exports = { svgBody, staticSVG };
