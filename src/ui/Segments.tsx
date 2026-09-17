export type Segment<K extends string> = { key: K; label: string; count?: number };

export function Segments<K extends string>({ items, value, onChange, label }: { items: Segment<K>[]; value: K; onChange: (key: K) => void; label: string }) {
  return <div className="seg" role="tablist" aria-label={label}>
    {items.map(item => <button key={item.key} type="button" role="tab" aria-selected={item.key === value} onClick={() => onChange(item.key)}>
      {item.label}{item.count !== undefined && <span className="mono"> {item.count}</span>}
    </button>)}
  </div>;
}
