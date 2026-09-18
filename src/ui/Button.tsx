import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';

type Look = 'default' | 'primary' | 'quiet' | 'danger' | 'link';
type Props = ButtonHTMLAttributes<HTMLButtonElement> & { look?: Look; small?: boolean; children: ReactNode };

function classes(look: Look, small?: boolean, extra?: string) {
  return ['btn', look !== 'default' && look, small && 'sm', extra].filter(Boolean).join(' ');
}

export function Button({ look = 'default', small, className, type = 'button', children, ...rest }: Props) {
  return <button type={type} className={classes(look, small, className)} {...rest}>{children}</button>;
}

export function LinkButton({ to, look = 'default', small, className, children, external, ...rest }:
  { to: string; look?: Look; small?: boolean; className?: string; children: ReactNode; external?: boolean; 'aria-label'?: string; title?: string }) {
  if (external) return <a href={to} className={classes(look, small, className)} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
  return <Link to={to} className={classes(look, small, className)} {...rest}>{children}</Link>;
}
