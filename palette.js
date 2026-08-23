/* NES 2C02 palette (64 colors, approximate RGB) + tile renderer */
(function (root) { root.NESPalette = NES_PAL; })(typeof self !== 'undefined' ? self : this);
function NES_PAL() {}
// Hex RGB values for the 64 NES colors
NES_PAL.colors = [
  '#7c7c7c',
  '#0000fc',
  '#0000bc',
  '#4428bc',
  '#940084',
  '#a80020',
  '#a81000',
  '#881400',
  '#503000',
  '#007800',
  '#006800',
  '#005800',
  '#004058',
  '#000000',
  '#000000',
  '#000000',
  '#bcbcbc',
  '#0078f8',
  '#0058f8',
  '#6844fc',
  '#d800cc',
  '#e40058',
  '#f83800',
  '#e45c10',
  '#ac7c00',
  '#00b800',
  '#00a800',
  '#00a844',
  '#008888',
  '#000000',
  '#000000',
  '#000000',
  '#f8f8f8',
  '#3cbcfc',
  '#6888fc',
  '#9878f8',
  '#f878f8',
  '#f85898',
  '#f87858',
  '#fca044',
  '#f8b800',
  '#b8f818',
  '#58d854',
  '#58f898',
  '#00e8d8',
  '#787878',
  '#000000',
  '#000000',
  '#fcfcfc',
  '#a4e4fc',
  '#b8b8f8',
  '#d8b8f8',
  '#f8b8f8',
  '#f8a4c0',
  '#f0d0b0',
  '#fce0a8',
  '#f8d878',
  '#d8f878',
  '#b8f8b8',
  '#b8f8d8',
  '#00fcfc',
  '#f8d8f8',
  '#000000',
  '#000000',
];
NES_PAL.rgb = function (idx) { const c = this.colors[idx & 63] || '#000'; return [parseInt(c.slice(1,3),16), parseInt(c.slice(3,5),16), parseInt(c.slice(5,7),16)]; };
NES_PAL.hex = function (idx) { return this.colors[idx & 63] || '#000'; };

/* Render helpers (shared by editor). Works on plain 8-bit arrays. */
NES_PAL.tilePixels = function (chr, tileIndex) {
  // returns 8x8 array of 0-3 color indices
  const base = (tileIndex & 0xFF) * 16;
  const out = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    const p0 = chr[base + y], p1 = chr[base + 8 + y];
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x;
      out[y * 8 + x] = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1);
    }
  }
  return out;
};
