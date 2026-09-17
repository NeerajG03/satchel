import { useReadout } from '../app/readout';
import { Button } from './Button';

export function CommandBlock({ lines, label }: { lines: string[]; label: string }) {
  const { announce } = useReadout();
  async function copy() {
    try { await navigator.clipboard.writeText(lines.join('\n')); announce('Copied'); } catch { announce('Copy failed'); }
  }
  return <div className="code" aria-label={label}>
    <pre>{lines.join('\n')}</pre>
    <Button look="quiet" small onClick={() => void copy()}>Copy</Button>
  </div>;
}
