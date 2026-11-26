import type { SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  wrapperClassName?: string;
}

export function Select({ className, wrapperClassName, children, ...props }: SelectProps) {
  return (
    <div className={['relative', wrapperClassName].filter(Boolean).join(' ')}>
      <select
        {...props}
        className={[
          'min-h-11 w-full appearance-none rounded-xl border border-slate-300 bg-white py-2 pr-9 pl-3 text-sm text-slate-900 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-60',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 shrink-0 -translate-y-1/2 text-slate-500"
      />
    </div>
  );
}
