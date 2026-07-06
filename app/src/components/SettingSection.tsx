import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface SettingSectionProps {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  delay?: number;
}

interface SettingRowProps {
  label: string;
  description?: string;
  children: ReactNode;
}

export function SettingSection({ title, icon: Icon, children, delay = 0 }: SettingSectionProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.16, 1, 0.3, 1] }}
      className="glass-panel p-5"
    >
      <div className="flex items-center gap-2.5 mb-4">
        <Icon className="w-4.5 h-4.5 text-[#5A6CFF]" />
        <h2 className="text-[15px] font-semibold text-primary-custom">{title}</h2>
      </div>
      <div className="space-y-4">{children}</div>
    </motion.div>
  );
}

export function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex-1 min-w-0 mr-4">
        <div className="text-sm text-primary-custom">{label}</div>
        {description && (
          <div className="text-xs text-secondary-custom mt-0.5">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
