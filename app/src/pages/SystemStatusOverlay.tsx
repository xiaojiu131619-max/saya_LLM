import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, Cpu, MemoryStick, HardDrive, Monitor, Activity } from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { useSystemStats } from '@/hooks/useSystemStats';
import NumericTicker from '@/components/NumericTicker';

interface SystemStatusOverlayProps {
  onClose: () => void;
}

function RadialGauge({ value, label, color, size = 140 }: { value: number; label: string; color: string; size?: number }) {
  const radius = (size - 20) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (value / 100) * circumference;

  return (
    <div className="flex flex-col items-center relative">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--glass-border)"
          strokeWidth={10}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <NumericTicker value={value} decimals={1} suffix="%" className="text-xl font-bold text-primary-custom" />
      </div>
      <span className="text-xs text-secondary-custom mt-2">{label}</span>
    </div>
  );
}

export default function SystemStatusOverlay({ onClose }: SystemStatusOverlayProps) {
  const stats = useSystemStats();
  const overlayRef = useRef<HTMLDivElement>(null);
  const vramUsagePercent = stats.vramTotal > 0 ? (stats.vramUsed / stats.vramTotal) * 100 : 0;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const chartData = stats.computeScores.map((v, i) => ({
    time: i,
    gpu: v,
  }));

  return (
    <motion.div
      ref={overlayRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-white/70 p-4 dark:bg-black/75 sm:p-8"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.8, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        className="glass-panel-strong w-full max-w-3xl max-h-[90vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-black/5 dark:border-white/5">
          <div className="flex items-center gap-3">
            <Monitor className="w-5 h-5 text-[#5A6CFF]" />
            <h2 className="text-lg font-semibold text-primary-custom">系统监控</h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center hover:bg-black/10 transition-colors dark:bg-white/5 dark:hover:bg-white/10"
          >
            <X className="w-4 h-4 text-secondary-custom" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Gauges */}
          <div className="flex items-center justify-center gap-12">
            <RadialGauge value={stats.gpuUsage} label="GPU 占用" color="#34D399" />
            <RadialGauge value={stats.ramUsage} label="RAM 占用" color="#5A6CFF" />
          </div>

          {/* VRAM Detail */}
          <div className="glass-panel p-4">
            <div className="flex items-center gap-2 mb-3">
              <HardDrive className="w-4 h-4 text-[#5A6CFF]" />
              <span className="text-sm font-medium text-primary-custom">显存详情</span>
            </div>
            <div className="grid grid-cols-3 gap-4 mb-3">
              <div className="text-center">
                <div className="text-xs text-secondary-custom mb-1">总量</div>
                <div className="text-sm mono-font text-primary-custom">{stats.vramTotal.toFixed(0)} GB</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-secondary-custom mb-1">已分配</div>
                <div className="text-sm mono-font text-[#FBBF24]">{stats.vramUsed.toFixed(2)} GB</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-secondary-custom mb-1">可用</div>
                <div className="text-sm mono-font text-[#34D399]">{(stats.vramTotal - stats.vramUsed).toFixed(2)} GB</div>
              </div>
            </div>
            <div className="h-2 rounded-full bg-black/5 overflow-hidden dark:bg-white/5">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-[#34D399] via-[#5A6CFF] to-[#FBBF24]"
                animate={{ width: `${vramUsagePercent}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </div>

          {/* Real-time Chart */}
          <div className="glass-panel p-4">
            <div className="flex items-center gap-2 mb-3">
              <Activity className="w-4 h-4 text-[#34D399]" />
              <span className="text-sm font-medium text-primary-custom">算力趋势 (60秒)</span>
            </div>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="gpuGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34D399" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#34D399" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area
                    type="monotone"
                    dataKey="gpu"
                    stroke="#34D399"
                    strokeWidth={2}
                    fill="url(#gpuGrad)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Hardware Info */}
          <div className="grid grid-cols-2 gap-4">
            <div className="glass-panel p-4">
              <div className="flex items-center gap-2 mb-2">
                <Cpu className="w-4 h-4 text-[#5A6CFF]" />
                <span className="text-xs text-secondary-custom">GPU</span>
              </div>
              <div className="text-sm text-primary-custom font-medium">{stats.gpuName}</div>
            </div>
            <div className="glass-panel p-4">
              <div className="flex items-center gap-2 mb-2">
                <MemoryStick className="w-4 h-4 text-[#5A6CFF]" />
                <span className="text-xs text-secondary-custom">内存</span>
              </div>
              <div className="text-sm text-primary-custom font-medium">{stats.ramTotal} GB</div>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
