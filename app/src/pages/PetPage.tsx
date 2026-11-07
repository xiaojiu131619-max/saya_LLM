import { PawPrint } from 'lucide-react';
import PageHeader from '@/components/PageHeader';

/**
 * 浮窗宠物（占位页）。
 *
 * 先占住入口与位置：后续这里放桌面宠物的形象、动作与互动设置。
 * 不预埋假开关或假数据。
 */
export default function PetPage() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-6 max-w-2xl">
          <PageHeader
            icon={PawPrint}
            title="浮窗宠物"
            description="桌面宠物的形象、动作与互动设置。"
          />
        </div>
        <div className="mx-auto flex min-h-[280px] max-w-2xl flex-col items-center justify-center gap-2 rounded-[var(--radius-panel)] border border-dashed border-[var(--border)] py-16 text-center">
          <PawPrint className="h-5 w-5 text-[var(--text-tertiary)]" />
          <span className="text-[length:var(--font-subtitle)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-tertiary)]">
            暂未启用
          </span>
          <span className="text-[length:var(--font-caption)] leading-5 text-[var(--text-tertiary)]">
            下一步接入浮窗宠物形象与互动，当前只保留入口。
          </span>
        </div>
      </div>
    </div>
  );
}
