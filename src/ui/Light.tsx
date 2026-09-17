export type LightColor = 'green' | 'amber' | 'red' | 'off';

export function Light({ color, word, verify = false }: { color: LightColor; word: string; verify?: boolean }) {
  return <span className={`light ${color} ${verify ? 'verify' : ''}`.trim()}>
    <span className="led" aria-hidden="true" /><span className="word">{word}</span>
  </span>;
}
