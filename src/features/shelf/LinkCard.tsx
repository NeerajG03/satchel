import { useEffect, useState } from 'react';
import { useStores } from '../../app/stores';
import type { LinkPreview } from './repository';

const LINK = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
const KEEP_MS = 12 * 3600 * 1000;

/** The words of a note with its links taken out, and the links on their own. */
export function splitLinks(note: string): { words: string; links: string[] } {
  const links = [...new Set(note.match(LINK) ?? [])].slice(0, 3);
  const words = note.replace(LINK, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return { words, links };
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// Kept per browser for twelve hours: a picture link from a social site stops working after a while.
const memory = new Map<string, Promise<LinkPreview | null>>();
function cached(url: string, load: (url: string) => Promise<LinkPreview | null>): Promise<LinkPreview | null> {
  const known = memory.get(url);
  if (known) return known;
  const key = `satchel.link:${url}`;
  try {
    const kept = JSON.parse(localStorage.getItem(key) ?? 'null') as { at: number; preview: LinkPreview | null } | null;
    if (kept && Date.now() - kept.at < KEEP_MS) {
      const done = Promise.resolve(kept.preview);
      memory.set(url, done);
      return done;
    }
  } catch { /* storage may be blocked; read it fresh */ }
  const fresh = load(url).catch(() => null).then(preview => {
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), preview })); } catch { /* fine without */ }
    return preview;
  });
  memory.set(url, fresh);
  return fresh;
}

/** A link as a person recognises it: the page's picture and title, and only the site's name. */
export function LinkCard({ url }: { url: string }) {
  const stores = useStores();
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let live = true;
    void cached(url, u => stores.shelf.preview(u)).then(found => { if (live) setPreview(found); });
    return () => { live = false; };
  }, [url, stores]);
  const domain = domainOf(url);
  const image = preview?.image && !broken ? preview.image : null;
  return <a className={`link-card${image ? '' : ' bare'}`} href={url} target="_blank" rel="noopener noreferrer">
    {image && <img className="link-card-image" src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />}
    <span className="link-card-text">
      {preview?.title && <span className="link-card-title">{preview.title}</span>}
      <span className="link-card-domain">{domain} ↗</span>
    </span>
  </a>;
}
