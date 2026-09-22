import { Link, NavLink } from 'react-router';
import { useDevMode } from '../app/dev';

type Destination = { to: string; label: string; end?: boolean };

const DESTINATIONS: Destination[] = [
  { to: '/', label: 'Left off', end: true },
  { to: '/book', label: 'Book' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/projects', label: 'Projects' },
  { to: '/apps', label: 'Apps' },
  { to: '/settings', label: 'Settings' },
];

// Seventh, and only when asked for. The rail is six fixed destinations by
// decision, because nothing in it may grow; this one is a switch a person
// turns on for themselves and turns off again, so it does not make the list
// something that grows on its own.
const DEVELOPER: Destination = { to: '/activity', label: 'Activity' };

export function Rail() {
  const dev = useDevMode();
  return <nav className="rail hw" aria-label="Destinations">
    {[...DESTINATIONS, ...(dev ? [DEVELOPER] : [])].map(item => <NavLink key={item.to} to={item.to} end={item.end}>
      {({ isActive }) => <><span className="dot" aria-hidden="true" />{item.label}{isActive && <span className="visually-hidden"> (current page)</span>}</>}
    </NavLink>)}
    <span className="spacer" />
    <Link to="/book?compose=1" className="key">Write</Link>
  </nav>;
}
