import { useState, useRef, useEffect } from 'react';
import { ArrowUpDown, Check } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import type { SortType } from '@/types';

const sortOptions: { value: SortType; label: string }[] = [
  { value: 'default', label: '默认排序' },
  { value: 'name', label: '名称 A-Z' },
  { value: 'size', label: '参数量从小到大' },
  { value: 'updated', label: '更新时间' },
];

export default function SortDropdown() {
  const { state, dispatch } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const current = sortOptions.find((o) => o.value === state.sortBy);

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-3 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
      >
        <ArrowUpDown className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
        <span className="truncate">{current?.label}</span>
      </button>

      {open && (
        <div
          className="anim-pop-in absolute right-0 top-full z-50 mt-2 w-48 rounded-md border border-[var(--border)] bg-[var(--surface)] py-1.5 shadow-lg"
        >
          {sortOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                dispatch({ type: 'SET_SORT', payload: option.value });
                setOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors ${
                state.sortBy === option.value
                  ? 'bg-[var(--surface-muted)] text-[var(--accent)]'
                  : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
              }`}
            >
              {option.label}
              {state.sortBy === option.value && <Check className="w-4 h-4" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
