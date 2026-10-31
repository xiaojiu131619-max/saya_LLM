import { Sparkles } from 'lucide-react';
import PageHeader from '@/components/PageHeader';

/**
 * Skills（技能）页 —— 空界面。
 *
 * 这一格故意留白：技能体系还没定，先把入口和位置占住，
 * 不在里面预埋任何假数据、假列表或「即将上线」的假开关。
 */
export default function SkillsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-6 max-w-2xl">
          <PageHeader
            icon={Sparkles}
            title="Skills"
            description="技能：可复用的任务套路与工具组合，后续在此管理。"
          />
        </div>

        <div className="mx-auto flex min-h-[320px] max-w-2xl flex-col items-center justify-center gap-2 rounded-[var(--radius-panel)] border border-dashed border-[var(--border)] py-16 text-center">
          <Sparkles className="h-5 w-5 text-[var(--text-tertiary)]" />
          <span className="text-[length:var(--font-subtitle)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-tertiary)]">
            Skills
          </span>
          <span className="text-[length:var(--font-caption)] leading-5 text-[var(--text-tertiary)]">
            暂未启用任何技能
          </span>
        </div>
      </div>
    </div>
  );
}
