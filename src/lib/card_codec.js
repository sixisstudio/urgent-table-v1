// Urgent Table — card sentinel helper
//
// Copied verbatim from Hijack Logger's lib/card_codec.js (only isRealCard
// is needed here). Hero seat is the seat with real face-up cards in its
// p{N}card slots. Hijack uses both 2-char ("KC") and 3-char ("10C") forms.

export const SENTINEL_EMPTY = '';
export const SENTINEL_FACEDOWN = 'facedown';

export function isRealCard(c) {
  if (!c || typeof c !== 'string') return false;
  if (c === SENTINEL_FACEDOWN || c === SENTINEL_EMPTY) return false;
  if (c.length === 2) return true;
  if (c.length === 3 && c.startsWith('10')) return true;
  return false;
}
