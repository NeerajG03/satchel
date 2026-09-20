import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Common = { label: ReactNode; hint?: string; limit?: number; value?: string | number | readonly string[] };

function Counter({ value, limit }: { value: string; limit: number }) {
  if (value.length < limit * 0.8) return null;
  return <span className={`count ${value.length >= limit ? 'warn' : ''}`.trim()}>{value.length}/{limit}</span>;
}

function Head({ id, hintId, label, hint, text, limit }: { id: string; hintId: string; label: ReactNode; hint?: string; text?: string; limit?: number }) {
  return <span className="between">
    <span><label htmlFor={id}>{label}</label> {hint && <span className="hint" id={hintId}>· {hint}</span>}</span>
    {limit && text !== undefined && <Counter value={text} limit={limit} />}
  </span>;
}

export function TextField({ label, hint, limit, className, ref, ...rest }: Common & InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const text = typeof rest.value === 'string' ? rest.value : '';
  return <div className="f">
    <Head id={id} hintId={hintId} label={label} hint={hint} text={text} limit={limit} />
    <input ref={ref} id={id} className={`field ${className ?? ''}`.trim()} maxLength={limit} aria-describedby={hint ? hintId : undefined} {...rest} />
  </div>;
}

export function TextArea({ label, hint, limit, className, ...rest }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const text = typeof rest.value === 'string' ? rest.value : '';
  return <div className="f">
    <Head id={id} hintId={hintId} label={label} hint={hint} text={text} limit={limit} />
    <textarea id={id} className={`field ${className ?? ''}`.trim()} maxLength={limit} aria-describedby={hint ? hintId : undefined} {...rest} />
  </div>;
}

export function SelectField({ label, hint, children, ...rest }: Common & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return <div className="f">
    <Head id={id} hintId={hintId} label={label} hint={hint} />
    <select id={id} className="field" aria-describedby={hint ? hintId : undefined} {...rest}>{children}</select>
  </div>;
}

export function CheckField({ label, hint, ...rest }: { label: ReactNode; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  return <label className="check"><input type="checkbox" aria-describedby={hint ? hintId : undefined} {...rest} /><span>{label}{hint && <span className="muted fine" id={hintId}> · {hint}</span>}</span></label>;
}
