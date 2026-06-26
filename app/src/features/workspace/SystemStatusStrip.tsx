import { useState } from 'react';
import { motion } from 'framer-motion';
import { Activity, Cpu, Globe2, HardDrive, MemoryStick, ShieldCheck } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { useSystemStats } from '@/hooks/useSystemStats';
import SystemStatusOverlay from '@/pages/SystemStatusOverlay';

function percent(value: number) {
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

export default function SystemStatusStrip() {
  const { state } = useApp();
  const stats = useSystemStats();
  const [showOverlay, setShowOverlay] = useState(false);
  const vramPercent = stats.vramTotal > 0 ? (stats.vramUsed / stats.vramTotal) * 100 : 0;

  return (
    <div className="paper-surface flex h-11 flex-shrink-0">
      <button
        onClick={() => setShowOverlay(true)}
        className="flex h-full w-full items-center gap-3 overflow-hidden rounded-xl border border-[#DED9CC] bg-[#F7F4EC] px-3 text-left text-[#403C32] shadow-sm transition-colors hover:bg-[#F2EEE5]"
        title="打开系统监控"
      >
        <div className="flex items-center gap-2 pr-2">
          <Activity className="h-4 w-4 text-[#D7663E]" />
          <span className="hidden text-xs font-semibold sm:inline">系统监控</span>
        </div>

        <StatusMeter icon={MemoryStick} label="RAM" value={percent(stats.ramUsage)} meter={stats.ramUsage} color="#5A6CFF" />
        <StatusMeter icon={Cpu} label="GPU" value={percent(stats.gpuUsage)} meter={stats.gpuUsage} color="#34D399" />

        <div className="hidden min-w-0 items-center gap-2 text-xs text-[#7B7468] lg:flex">
          <HardDrive className="h-4 w-4 flex-shrink-0" />
          <span className="flex-shrink-0">VRAM</span>
          <span className="mono-font truncate text-[#403C32]">
            {stats.vramTotal > 0 ? `${stats.vramUsed.toFixed(2)} / ${stats.vramTotal.toFixed(0)} GB` : '未连接'}
          </span>
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-black/5">
            <motion.div
              className="h-full rounded-full bg-[#FBBF24]"
              animate={{ width: percent(vramPercent) }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            />
          </div>
        </div>

        <div className="ml-auto hidden items-center gap-2 text-xs text-[#7B7468] xl:flex">
          {state.apiConfig.enabled && (
            <span className="flex items-center gap-1 rounded-full bg-[#5A6CFF]/10 px-2 py-1 text-[#5A6CFF]">
              <Globe2 className="h-3.5 w-3.5" />
              <span className="mono-font">API:{state.serverPort}</span>
              {state.apiConfig.hasApiKey && <ShieldCheck className="h-3.5 w-3.5" />}
            </span>
          )}
          <span className="mono-font">{state.backendAvailable ? 'Backend ready' : 'Desktop backend offline'}</span>
        </div>
      </button>

      {showOverlay && <SystemStatusOverlay onClose={() => setShowOverlay(false)} />}
    </div>
  );
}

function StatusMeter({ icon: Icon, label, value, meter, color }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  meter: number;
  color: string;
}) {
  return (
    <div className="flex min-w-[84px] items-center gap-2 text-xs text-[#7B7468]">
      <Icon className="h-4 w-4 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span>{label}</span>
          <span className="mono-font text-[#403C32]">{value}</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/5">
          <motion.div
            className="h-full rounded-full"
            style={{ background: color }}
            animate={{ width: percent(meter) }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          />
        </div>
      </div>
    </div>
  );
}
