import { fullDate, whenText } from '../app/format';

export function Provenance({ parts, at }: { parts: (string | false | null | undefined)[]; at?: string }) {
  const items = parts.filter(Boolean) as string[];
  return <span className="prov">
    {items.map((part, i) => <span key={i}>{i > 0 && '· '}{part}</span>)}
    {at && <span>{items.length > 0 && '· '}<time dateTime={at} title={fullDate(at)}>{whenText(at)}</time></span>}
  </span>;
}
