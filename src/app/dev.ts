import { useEffect, useState } from 'react';

// Developer mode: a switch that reveals the Activity destination.
//
// Per browser rather than per account, and deliberately. It changes nothing
// about what Satchel stores or who may read it, only whether this machine
// shows you the machinery. Putting it in memory_settings would sync a window
// preference to a phone that has no window, and would make an agent
// connection able to read it for no reason.
//
// localStorage can throw: a private window, blocked site data, a browser that
// has it switched off. Every read and write is wrapped, and the honest default
// when it is unreadable is off.
const KEY = 'satchel.dev';
const CHANGED = 'satchel:dev';

export function devModeOn(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setDevMode(on: boolean): void {
  try { on ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); }
  catch { /* Nothing to persist to. The switch still works for this page. */ }
  // The rail and the settings row are in different trees, so a plain state
  // hook in one cannot tell the other. `storage` only fires in *other* tabs,
  // which is exactly the tab that does not need telling.
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: on }));
}

export function useDevMode(): boolean {
  const [on, setOn] = useState(devModeOn);
  useEffect(() => {
    const here = () => setOn(devModeOn());
    window.addEventListener(CHANGED, here);
    window.addEventListener('storage', here);
    return () => { window.removeEventListener(CHANGED, here); window.removeEventListener('storage', here); };
  }, []);
  return on;
}
