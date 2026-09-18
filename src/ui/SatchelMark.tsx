export function SatchelMark({ size = 26, glyph = true }: { size?: number; glyph?: boolean }) {
  return <svg className="mark" width={size} height={size} viewBox="0 0 180 180" aria-hidden="true" focusable="false">
    <rect width="180" height="180" rx="22" fill="#26231F" />
    <rect x="14" y="14" width="152" height="152" rx="14" fill="#F4F0E7" />
    <path d="M14 28a14 14 0 0 1 14-14h124a14 14 0 0 1 14 14v8H14z" fill="#26231F" />
    <circle cx="150" cy="25" r="6" fill="#E4571E" />
    {glyph && <text x="90" y="118" textAnchor="middle" fontFamily="Caveat, cursive" fontWeight="600" fontSize="88" fill="#1F1B17">s</text>}
  </svg>;
}
