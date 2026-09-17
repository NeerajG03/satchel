import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Common = { label: ReactNode; hint?: string; limit?: number; value?: string | number | readonly string[] };

function Counter({ value, limit }: { value: string; limit: number }) {
  if (value.length < limit * 0.8) return null;
  return <span className={`count ${value.length >= limit ? 'warn' : ''}`.trim()}>{value.length}/{limit}</span>;
}

export function TextField({ label, hint, limit, className, ref, ...rest }: Common & InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const id = useId();
  const text = typeof rest.value === 'string' ? rest.value : '';
  return <label className="f" htmlFor={id}>
    <span className="between"><span>{label} {hint && <span className="hint">· {hint}</span>}</span>{limit && <Counter value={text} limit={limit} />}</span>
    <input ref={ref} id={id} className={`field ${className ?? ''}`.trim()} maxLength={limit} {...rest} />
  </label>;
}

export function TextArea({ label, hint, limit, className, ...rest }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const text = typeof rest.value === 'string' ? rest.value : '';
  return <label className="f" htmlFor={id}>
    <span className="between"><span>{label} {hint && <span className="hint">· {hint}</span>}</span>{limit && <Counter value={text} limit={limit} />}</span>
    <textarea id={id} className={`field ${className ?? ''}`.trim()} maxLength={limit} {...rest} />
  </label>;
}

export function SelectField({ label, hint, children, ...rest }: Common & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const id = useId();
  return <label className="f" htmlFor={id}>
    <span>{label} {hint && <span className="hint">· {hint}</span>}</span>
    <select id={id} className="field" {...rest}>{children}</select>
  </label>;
}

export function CheckField({ label, hint, ...rest }: { label: ReactNode; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return <label className="check"><input type="checkbox" {...rest} /><span>{label}{hint && <span className="muted fine"> · {hint}</span>}</span></label>;
}
