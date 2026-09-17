import { Link, NavLink } from 'react-router';

const DESTINATIONS = [
  { to: '/', label: 'Left off', end: true },
  { to: '/book', label: 'Book' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/projects', label: 'Projects' },
  { to: '/apps', label: 'Apps' },
  { to: '/settings', label: 'Settings' },
];

export function Rail() {
  return <nav className="rail hw" aria-label="Destinations">
    {DESTINATIONS.map(item => <NavLink key={item.to} to={item.to} end={item.end}>
      {({ isActive }) => <><span className="dot" aria-hidden="true" />{item.label}{isActive && <span className="visually-hidden"> (current page)</span>}</>}
    </NavLink>)}
    <span className="spacer" />
    <Link to="/book?compose=1" className="key">Write</Link>
  </nav>;
}
