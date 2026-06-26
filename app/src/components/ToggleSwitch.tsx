import { motion } from 'framer-motion';

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
  label?: string;
}

export default function ToggleSwitch({ checked, onChange, className = '', label = '切换开关' }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative w-12 h-6 rounded-full transition-colors duration-300 focus:outline-none ${
        checked ? 'bg-[#D06646]' : 'bg-[#BDB8AD]'
      } ${className}`}
    >
      <motion.div
        className="absolute top-[2px] left-[2px] w-5 h-5 rounded-full bg-white shadow-md"
        animate={{
          x: checked ? 24 : 0,
        }}
        transition={{
          type: 'spring',
          stiffness: 500,
          damping: 25,
        }}
      />
    </button>
  );
}
