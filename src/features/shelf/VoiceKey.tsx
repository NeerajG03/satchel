import { useEffect, useRef, useState } from 'react';

// One voice note plays at a time across the Shelf: starting one stops the other.
let playing: HTMLAudioElement | null = null;

const clock = (s: number) => Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '';

/**
 * A voice note as a small round key, like the hardware keys: its length
 * beside it, and a thin line that fills while it plays. The words are what
 * the card shows; this is only how to hear them.
 */
export function VoiceKey({ src, label, overlay = false }: { src: string; label: string; overlay?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [length, setLength] = useState(NaN);
  const [at, setAt] = useState(0);

  useEffect(() => () => { if (playing === audio.current) playing = null; }, []);

  function toggle() {
    const a = audio.current;
    if (!a) return;
    if (on) { a.pause(); return; }
    if (playing && playing !== a) playing.pause();
    playing = a;
    void a.play().catch(() => setOn(false));
  }

  return <div className={`voice-key${overlay ? ' overlay' : ''}${on ? ' on' : ''}`}>
    <button type="button" className="key" aria-label={on ? `Stop: ${label}` : label} aria-pressed={on} onClick={toggle}>
      {on
        ? <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" /></svg>
        : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" /></svg>}
    </button>
    {on && <span className="track" aria-hidden="true"><span style={{ width: `${length ? (100 * at) / length : 0}%` }} /></span>}
    <span className="time">{clock(on ? at : length)}</span>
    <audio ref={audio} src={src} preload="metadata"
      onLoadedMetadata={event => setLength(event.currentTarget.duration)}
      onDurationChange={event => setLength(event.currentTarget.duration)}
      onPlay={() => setOn(true)} onPause={() => setOn(false)}
      onEnded={event => { setOn(false); setAt(0); event.currentTarget.currentTime = 0; }}
      onTimeUpdate={event => setAt(event.currentTarget.currentTime)} />
  </div>;
}
