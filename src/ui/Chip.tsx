export function Chip({ children, look = '' }: { children: string; look?: string }) {
  return <span className={`chip ${look}`.trim()}>{children}</span>;
}
