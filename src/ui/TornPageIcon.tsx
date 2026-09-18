// A page torn from the book: the sheet stays put while the bottom strip tears away.
export function TornPageIcon({ size = 20 }: { size?: number }) {
  return <svg className="torn-page" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3h8l4 4v6.5l-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5V3z" />
    <path d="M14 3v4h4" />
    <path className="torn-piece" d="M6 16.5l2 1.5 2-1.5 2 1.5 2-1.5 2 1.5 2-1.5V21H6z" />
  </svg>;
}
