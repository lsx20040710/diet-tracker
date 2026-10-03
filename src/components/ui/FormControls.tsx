import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, children }: FieldProps) {
  return (
    <label className="block text-sm font-medium text-slate-700">
      <span>{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-red-600">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs font-normal text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15 disabled:bg-slate-100 ${className}`}
      {...props}
    />
  );
}

export function SelectInput({
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15 disabled:bg-slate-100 ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export const primaryButtonClass =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:bg-slate-300';

export const secondaryButtonClass =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-50';

export const dangerButtonClass =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:opacity-50';
