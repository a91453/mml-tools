// Studio Workshop icons: a small inline SVG sprite drawn for Studio, replacing
// the icon font the owner's earlier frontend used (no font, no extra licence).
// Stroked 24×24 outlines; `fill: true` marks the few solid glyphs.
export const ICONS = Object.freeze({
  play: { d: 'M7 4.5v15l12.5-7.5z', fill: true },
  pause: { d: 'M6 4.5h4v15H6zM14 4.5h4v15h-4z', fill: true },
  stop: { d: 'M6 6h12v12H6z', fill: true },
  'arrow-pointer': { d: 'M5.5 3l13 8.6-5.6 1.4 3.3 6.3-2.4 1.2-3.2-6.4-5.1 4.1z', fill: true },
  toolbox: { d: 'M3 9h18v10H3zM8.5 9V6h7v3M3 13.5h18' },
  'table-list': { d: 'M4 5h16v14H4zM4 10h16M4 14.5h16M9 5v14' },
  'file-code': { d: 'M6 3h8l4 4v14H6zM14 3v4h4M10.5 11.5L8.5 14l2 2.5M13.5 11.5l2 2.5-2 2.5' },
  'circle-info': { d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM12 11v6M12 7.5v.2' },
  'circle-question': { d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .9-1 1.6v.4M12 16.8v.2' },
  'circle-right': { d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM8 12h8M13 9l3 3-3 3' },
  clipboard: { d: 'M9 3.5h6v3H9zM7 5H5v16h14V5h-2M8.5 11h7M8.5 15h5' },
  'folder-open': { d: 'M3 19V5h6l2 2h7v3M3 19l3.5-8H21l-3.5 8z' },
  gear: { d: 'M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 1 0 0-6.4zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1' },
  bars: { d: 'M4 6h16M4 12h16M4 18h16' },
  retweet: { d: 'M4 11.5V9a3 3 0 0 1 3-3h11M15 3l3 3-3 3M20 12.5V15a3 3 0 0 1-3 3H6M9 21l-3-3 3-3' },
  music: { d: 'M9 17.5V5.5l10-2v12M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0zM19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z' },
  'arrows-left-right': { d: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4' },
  'arrows-up-down': { d: 'M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4' },
  'rotate-left': { d: 'M4 4.5v5h5M4.6 9.5A8 8 0 1 1 6 16.8' },
  'rotate-right': { d: 'M20 4.5v5h-5M19.4 9.5A8 8 0 1 0 18 16.8' },
  'gauge-high': { d: 'M4 17a8 8 0 1 1 16 0M12 17l4.2-5.2M12 17v.01' },
  sliders: { d: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4' },
  'arrow-up-right-dots': { d: 'M5 19L18 6M11 5.5h7.5V13M4.5 12.5v.1M4.5 8.5v.1M11.5 19.5v.1M15.5 19.5v.1' },
  'wand-magic-sparkles': { d: 'M4 20l11-11M13 7l4 4M18 2.5v3M16.5 4h3M20.5 9v2M19.5 10h2M9 2.5v2M8 3.5h2' },
  'layer-group': { d: 'M12 3l9 4.8-9 4.8-9-4.8zM3 12.2l9 4.8 9-4.8M3 16.2l9 4.8 9-4.8' },
  'arrow-right': { d: 'M4 12h16M14 6l6 6-6 6' },
  'volume-high': { d: 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12' },
  'volume-xmark': { d: 'M4 9h4l5-4v14l-5-4H4zM16.5 9.5l5 5M21.5 9.5l-5 5' },
  bullhorn: { d: 'M3 10v4h3l9 5V5l-9 5zM6 14l1.5 5h2.5l-1-4.5M18 9.5a3 3 0 0 1 0 5' },
  eye: { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6z' },
  'eye-slash': { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM3 3l18 18' },
  'arrows-to-eye': { d: 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM3 3l4.5 4.5M21 3l-4.5 4.5M3 21l4.5-4.5M21 21l-4.5-4.5' },
  compress: { d: 'M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6' },
  'chart-gantt': { d: 'M4 4v16h16M8 8h6M10 12h7M7 16h5' },
  download: { d: 'M12 4v11M7 10l5 5 5-5M5 20h14' },
  film: { d: 'M3 5h18v14H3zM7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4' },
  wave: { d: 'M2 12h3l2-5 3 10 3-14 3 14 2-5h4' },
  'studio-in': { d: 'M14 4h6v16h-6M3 12h11M10 8l4 4-4 4' },
  'studio-out': { d: 'M10 4H4v16h6M9 12h12M17 8l4 4-4 4' },
  xmark: { d: 'M6 6l12 12M18 6L6 18' },
});

export const iconId = name => `i-${name}`;

// Markup for one icon; the symbol lives in the page's sprite.
export function icon(name, cls = '') {
  if (!ICONS[name]) throw Error(`unknown icon ${name}`);
  return `<svg class="ico${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="#${iconId(name)}"></use></svg>`;
}

// Swap the icon inside an element that holds one (a button, a span).
export function setIcon(el, name) {
  if (!ICONS[name]) throw Error(`unknown icon ${name}`);
  const use = el?.querySelector('svg.ico use');
  if (use) use.setAttribute('href', `#${iconId(name)}`);
  else if (el) el.insertAdjacentHTML('afterbegin', icon(name));
}

// The <symbol> sprite written into the page (see index.html).
export function spriteMarkup() {
  const symbols = Object.entries(ICONS).map(([name, { d, fill }]) =>
    `<symbol id="${iconId(name)}" viewBox="0 0 24 24"><path d="${d}"${fill ? ' fill="currentColor" stroke="none"' : ''}/></symbol>`);
  return `<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false"><defs>${symbols.join('')}</defs></svg>`;
}
