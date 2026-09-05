import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Palette } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '@/context/AppContext';
import PageHeader from '@/components/PageHeader';
import type { ModelInfo } from '@/types';
import { getModelThemeGroup } from '@/lib/modelTheme';

export default function ModelThemePage() {
  const { state, dispatch } = useApp();
  const [groupsCollapsed, setGroupsCollapsed] = useState(false);

  const themeGroups = useMemo(() => {
    const groups = new Map<string, {
      key: string;
      label: string;
      icon: string;
      color: string;
      models: ModelInfo[];
    }>();

    state.models.forEach((model) => {
      const group = getModelThemeGroup(model);
      const current = groups.get(group.key);
      if (current) {
        current.models.push(model);
      } else {
        groups.set(group.key, {
          key: group.key,
          label: group.label,
          icon: group.icon,
          color: model.themeColorSolid,
          models: [model],
        });
      }
    });

    return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [state.models]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-6 max-w-2xl">
          <PageHeader
            icon={Palette}
            title="模型主题"
            description="按模型系列分组调整主题色，颜色会同步到模型卡片、对话头像与使用统计。"
          />
        </div>

        <div className="mx-auto max-w-2xl pb-12">
          {themeGroups.length > 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
              className="border-b border-[var(--border-subtle)] py-2"
            >
              <button
                onClick={() => setGroupsCollapsed((value) => !value)}
                className="w-full flex items-center justify-between gap-3 rounded-xl px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <span className="text-sm text-primary-custom">{themeGroups.length} 个主题组</span>
                <ChevronDown
                  className={`w-4 h-4 text-secondary-custom transition-transform ${groupsCollapsed ? '-rotate-90' : 'rotate-0'}`}
                />
              </button>

              {!groupsCollapsed && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-3 overflow-hidden"
                >
                  {themeGroups.map((group, index) => (
                    <div key={group.key}>
                      {index > 0 && <div className="mb-3 border-t border-[var(--border-subtle)]" />}
                      <div className="flex items-center justify-between gap-4 py-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className="w-10 h-10 rounded-xl flex items-center justify-center text-base font-bold text-white flex-shrink-0"
                            style={{ background: group.color }}
                          >
                            {group.icon}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm text-primary-custom">{group.label}</div>
                            <div className="text-xs text-secondary-custom truncate">
                              {group.models.length} 个模型 · {group.models.map((model) => model.name).join(' / ')}
                            </div>
                          </div>
                        </div>
                        <input
                          type="color"
                          aria-label={`${group.label} 主题颜色`}
                          value={group.color}
                          onChange={(event) => dispatch({
                            type: 'SET_MODEL_GROUP_THEME_COLOR',
                            payload: { groupKey: group.key, color: event.target.value },
                          })}
                          className="w-10 h-8 rounded-lg bg-transparent cursor-pointer flex-shrink-0"
                        />
                      </div>
                    </div>
                  ))}
                </motion.div>
              )}
            </motion.div>
          ) : (
            <div className="py-16 text-center text-sm text-secondary-custom">
              尚未发现本地模型。添加模型目录并扫描后，可在这里按系列调整主题色。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
