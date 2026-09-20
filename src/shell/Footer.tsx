import { useReadout } from '../app/readout';

export function Footer({ right = 'Explicit saves only' }: { right?: string }) {
  const { left, message } = useReadout();
  return <footer className="foot">
    <span role="status" aria-live="polite">{message ? <span className="readout">{message}</span> : left}</span>
    <span>{right}</span>
  </footer>;
}
