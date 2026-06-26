import { useEffect, useRef, useState } from 'react';

interface NumericTickerProps {
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
}

export default function NumericTicker({ value, decimals = 1, suffix = '', className = '' }: NumericTickerProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const prevValue = useRef(value);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const start = prevValue.current;
    const end = value;
    const duration = 400;
    const startTime = performance.now();

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Smooth ease-out
      const eased = 1 - Math.pow(1 - progress, 4);
      const current = start + (end - start) * eased;
      setDisplayValue(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        prevValue.current = end;
      }
    }

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(rafRef.current);
  }, [value]);

  const formatted = displayValue.toFixed(decimals);

  return (
    <span className={`mono-font inline-flex items-baseline transition-none ${className}`}>
      {formatted}
      {suffix && <span className="ml-0.5 text-[0.85em] opacity-60">{suffix}</span>}
    </span>
  );
}
