import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Waypoints,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import EmptyState from '@/components/EmptyState';
import ToggleSwitch from '@/components/ToggleSwitch';
import { open } from '@tauri-apps/plugin-dialog';
import { usePiRuntime } from '@/features/pi/PiRuntimeContext';
import {
  piAgentSelectSkills,
  piAgentSkillsIndex,
  type PiSkillLink,
  type PiSelectedSkill,
  type PiSkillMeta,
} from '@/lib/ipc/pi';
import { isDesktopRuntime, revealDesktopPath } from '@/lib/desktop';
import { savePiConfig } from '@/lib/piConfig';

/**
 * 技能树（Agent 工作区的独立页）。
 *
 * 技能不注册成 Pi 的原生 skills，而是由宿主雷达按任务文本选 1–2 个注入正文。
 * 层级来自技能库根目录的 `_tree.json`（大类 → 子类 → 技能），路由也是两级的：
 * 先分支晋级（Top-2），再在分支内选技能；格式词/技能名命中的「豁免」技能
 * 不被分支裁掉。这里把三件事联动呈现：
 * - 左侧按分类树浏览，搜索命中自动展开；
 * - 右侧详情带分类面包屑与关联技能（点击跳转）；
 * - 底部试跑两级路由，命中的技能在左树上自动展开并高亮。
 */

const KIND_LABEL: Record<string, string> = {
  generate: '生成类',
  query: '查询类',
  delegated: '转发类',
  generic: '通用',
};

const LINK_LABEL: Record<string, string> = {
  complement: '配套',
  depends: '依赖',
  delegate: '委托',
};

/** 未收录进 `_tree.json` 的技能归入的隐式分组（与宿主侧 UNCLASSIFIED_LABEL 对齐）。 */
const UNCLASSIFIED = '未分类';

function kindOf(skill: PiSkillMeta) {
  return skill.kind && KIND_LABEL[skill.kind] ? skill.kind : 'generic';
}

/** 折叠状态的键：大类 `cat:<label>`、子类 `sub:<大类>/<子类>`。 */
function catKey(label: string) {
  return `cat:${label}`;
}
function subKey(cat: string, sub: string) {
  return `sub:${cat}/${sub}`;
}

interface SubNode {
  label: string;
  skills: PiSkillMeta[];
}
interface CatNode {
  label: string;
  /** 直挂在大类下（无子类）的技能。 */
  skills: PiSkillMeta[];
  subs: SubNode[];
  /** 顶层分支声明序（_tree.json 顺序）；未分类取最大值自然垫底。 */
  order: number;
}

/** 由分类路径聚合成 大类→子类→技能 三层树，分支按声明序排列，未分类垫底。 */
function buildTree(skills: PiSkillMeta[]): CatNode[] {
  const catMap = new Map<string, CatNode>();
  for (const skill of skills) {
    const path = skill.categoryPath ?? [];
    const catLabel = path[0] ?? UNCLASSIFIED;
    let cat = catMap.get(catLabel);
    if (!cat) {
      cat = { label: catLabel, skills: [], subs: [], order: Number.MAX_SAFE_INTEGER };
      catMap.set(catLabel, cat);
    }
    cat.order = Math.min(cat.order, skill.categoryOrder ?? Number.MAX_SAFE_INTEGER);
    const subLabel = path[1];
    if (!subLabel) {
      cat.skills.push(skill);
      continue;
    }
    let sub = cat.subs.find((item) => item.label === subLabel);
    if (!sub) {
      sub = { label: subLabel, skills: [] };
      cat.subs.push(sub);
    }
    sub.skills.push(skill);
  }
  return [...catMap.values()].sort((a, b) => a.order - b.order);
}

export default function SkillsPage() {
  const piRuntime = usePiRuntime();
  const config = piRuntime.config;
  const skillsDir = config?.skillsDir?.trim() ?? '';
  const [skills, setSkills] = useState<PiSkillMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeName, setActiveName] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [routeText, setRouteText] = useState('');
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeResult, setRouteResult] = useState<{
    skills: PiSelectedSkill[];
    context: string;
    branches?: string[];
  } | null>(null);

  const loadSkills = useCallback(async () => {
    if (!isDesktopRuntime() || !skillsDir) {
      setSkills([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSkills(await piAgentSkillsIndex(skillsDir));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [skillsDir]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSkills();
  }, [loadSkills]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) =>
      [skill.name, skill.description, ...skill.triggers, ...skill.tools]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [skills, query]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  /** 试跑命中 / 相关技能跳转时高亮的技能名集合。 */
  const highlightNames = useMemo(
    () => new Set((routeResult?.skills ?? []).map((skill) => skill.name)),
    [routeResult],
  );

  /** 展开某个技能所在的全部分支（大类 + 子类）。 */
  const revealSkill = useCallback(
    (categoryPath?: string[]) => {
      const path = categoryPath ?? [];
      const keys = [path[0] ? catKey(path[0]) : null, path[0] && path[1] ? subKey(path[0], path[1]) : null];
      const targets = keys.filter((key): key is string => Boolean(key));
      if (targets.length === 0) return;
      setCollapsed((prev) => {
        const next = { ...prev };
        for (const key of targets) delete next[key];
        return next;
      });
    },
    [],
  );

  /** 详情面板点相关技能：清搜索、展开其分支并选中。 */
  const jumpToSkill = useCallback(
    (name: string) => {
      const meta = skills.find((skill) => skill.name === name);
      if (!meta) return;
      setQuery('');
      setActiveName(name);
      revealSkill(meta.categoryPath);
    },
    [skills, revealSkill],
  );

  const activeSkill = filtered.find((skill) => skill.name === activeName) ?? filtered[0];

  const pickSkillsDir = async () => {
    if (!isDesktopRuntime() || !config) return;
    const selected = await open({ multiple: false, directory: true, title: '选择技能库目录' });
    if (typeof selected === 'string' && selected.trim()) {
      savePiConfig({ ...config, skillsDir: selected.trim() });
    }
  };

  const runRoute = async () => {
    const text = routeText.trim();
    if (!text || !skillsDir) return;
    setRouteBusy(true);
    setError(null);
    try {
      const result = await piAgentSelectSkills(skillsDir, text, 2, 8000);
      setRouteResult(result);
      // 三方联动：命中技能所在分支自动展开。
      for (const skill of result.skills) {
        const meta = skills.find((item) => item.name === skill.name);
        if (meta) revealSkill(meta.categoryPath);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRouteBusy(false);
    }
  };

  const searching = query.trim().length > 0;

  const renderSkillRow = (skill: PiSkillMeta, indentClass: string) => {
    const selected = activeSkill?.name === skill.name;
    const highlighted = highlightNames.has(skill.name);
    return (
      <button
        key={skill.path}
        type="button"
        onClick={() => setActiveName(skill.name)}
        className={`flex w-full min-w-0 flex-col items-start gap-0.5 rounded-[var(--radius-field)] px-2 py-1.5 text-left transition-colors ${indentClass} ${
          selected
            ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
            : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.06]'
        }`}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          {highlighted ? (
            <span
              className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--accent)]"
              title="本轮路由命中"
            />
          ) : null}
          <span
            className={`min-w-0 flex-1 truncate text-[length:var(--font-caption)] font-medium ${
              highlighted && !selected ? 'text-[var(--accent)]' : ''
            }`}
          >
            {skill.name}
          </span>
        </span>
        <span className="w-full truncate text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
          {skill.triggers.slice(0, 4).join(' · ') || skill.description}
        </span>
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex-shrink-0 border-b border-[var(--border)] px-6 py-3">
        <PageHeader
          icon={Sparkles}
          title="技能树"
          description="按分类树浏览技能，试跑两级路由（先分支后技能），并查看关联技能。"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
            共 {skills.length} 个技能
          </span>
          {skills.some((skill) => (skill.categoryPath?.length ?? 0) > 0) ? (
            <span className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
              {tree.filter((cat) => cat.label !== UNCLASSIFIED).length} 个分类 · 两级路由
            </span>
          ) : null}
          <span className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
            路由每轮注入 1–2 个
          </span>
          <button
            type="button"
            onClick={() => void loadSkills()}
            disabled={loading || !skillsDir}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            重新索引
          </button>
          {skillsDir ? (
            <button
              type="button"
              onClick={() => void revealDesktopPath(skillsDir).catch(() => undefined)}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              技能库目录
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void pickSkillsDir()}
            disabled={!isDesktopRuntime()}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-50"
          >
            更改目录
          </button>
          <span className="min-w-0 flex-1 truncate text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]" title={skillsDir}>
            {skillsDir || '未配置技能库目录'}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">技能路由</span>
            <ToggleSwitch
              checked={Boolean(config?.skillRoutingEnabled)}
              onChange={(checked) => {
                if (!config) return;
                savePiConfig({ ...config, skillRoutingEnabled: checked });
              }}
              label="技能路由"
            />
          </div>
        </div>

        {error ? (
          <p className="rounded-[var(--radius-field)] border border-[var(--state-danger-border)] px-3 py-2 text-[length:var(--font-caption)] text-[var(--state-danger)]">
            {error}
          </p>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(240px,340px)_minmax(0,1fr)]">
          {/* 左：技能树（大类 → 子类 → 技能） */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)]">
            <label className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-[var(--text-tertiary)]">
              <Search className="h-3.5 w-3.5 flex-shrink-0" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索技能 / 触发词 / 工具"
                className="min-w-0 flex-1 bg-transparent text-[length:var(--font-caption)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {loading ? (
                <p className="px-2 py-6 text-center text-[length:var(--font-caption)] text-[var(--text-tertiary)]">正在读取技能索引…</p>
              ) : tree.length === 0 ? (
                <EmptyState
                  compact
                  icon={skillsDir ? Search : FolderOpen}
                  title={skillsDir ? '没有匹配的技能' : '尚未配置技能库'}
                  description={skillsDir
                    ? '试试技能名、触发词或工具名；搜索会同时匹配子技能。'
                    : '到 Agent 页的 Pi 设置里选择技能库目录，索引会自动生成。'}
                />
              ) : (
                tree.map((cat) => {
                  // 搜索时全部展开，让命中结果连同层级一起可见。
                  const catOpen = searching || !collapsed[catKey(cat.label)];
                  const catCount = cat.skills.length + cat.subs.reduce((sum, sub) => sum + sub.skills.length, 0);
                  return (
                    <div key={cat.label} className="mb-1.5">
                      <button
                        type="button"
                        onClick={() => setCollapsed((prev) => ({ ...prev, [catKey(cat.label)]: catOpen }))}
                        className="flex w-full items-center gap-1.5 rounded-[var(--radius-field)] px-2 py-1 text-left text-[length:var(--font-eyebrow)] font-semibold tracking-[var(--tracking-eyebrow)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
                      >
                        {catOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        {cat.label}
                        <span className="ml-auto text-[var(--text-tertiary)]">{catCount}</span>
                      </button>
                      {catOpen ? (
                        <>
                          {cat.skills.map((skill) => renderSkillRow(skill, 'pl-6'))}
                          {cat.subs.map((sub) => {
                            const subOpen = searching || !collapsed[subKey(cat.label, sub.label)];
                            return (
                              <div key={sub.label}>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setCollapsed((prev) => ({ ...prev, [subKey(cat.label, sub.label)]: subOpen }))
                                  }
                                  className="flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-field)] py-1 pl-6 pr-2 text-left text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
                                >
                                  {subOpen ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />}
                                  <span className="min-w-0 flex-1 truncate">{sub.label}</span>
                                  <span className="flex-shrink-0 text-[length:var(--font-micro)] text-[var(--text-tertiary)]">{sub.skills.length}</span>
                                </button>
                                {subOpen ? sub.skills.map((skill) => renderSkillRow(skill, 'pl-10')) : null}
                              </div>
                            );
                          })}
                        </>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* 右：详情 + 路由试跑 */}
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <div className="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4">
              {activeSkill ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[length:var(--font-subtitle)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                      {activeSkill.name}
                    </h2>
                    <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[length:var(--font-micro)] text-[var(--text-secondary)]">
                      {KIND_LABEL[kindOf(activeSkill)]}
                    </span>
                    <span className="text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                      正文 {activeSkill.bodyChars.toLocaleString()} 字符
                    </span>
                  </div>
                  <p className="mt-1 text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                    分类：{(activeSkill.categoryPath?.length ?? 0) > 0 ? activeSkill.categoryPath!.join(' / ') : UNCLASSIFIED}
                  </p>
                  <p className="mt-2 text-[length:var(--font-caption)] leading-relaxed text-[var(--text-secondary)]">
                    {activeSkill.description || '（无描述）'}
                  </p>
                  {activeSkill.related?.length ? (
                    <div className="mt-3">
                      <div className="mb-1 text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-secondary)]">相关技能</div>
                      <div className="flex flex-wrap gap-1">
                        {activeSkill.related.map((link: PiSkillLink) => (
                          <button
                            key={`${link.direction}-${link.name}`}
                            type="button"
                            onClick={() => jumpToSkill(link.name)}
                            title={link.note || `${LINK_LABEL[link.kind] ?? link.kind} · ${link.name}`}
                            className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[length:var(--font-micro)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                          >
                            {LINK_LABEL[link.kind] ?? link.kind} · {link.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-secondary)]">触发词</div>
                      <div className="flex flex-wrap gap-1">
                        {activeSkill.triggers.length > 0 ? activeSkill.triggers.map((trigger) => (
                          <span key={trigger} className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[length:var(--font-micro)] text-[var(--text-secondary)]">
                            {trigger}
                          </span>
                        )) : <span className="text-[length:var(--font-micro)] text-[var(--text-tertiary)]">未声明</span>}
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-secondary)]">排除词（not_for）</div>
                      <div className="flex flex-wrap gap-1">
                        {activeSkill.notFor.length > 0 ? activeSkill.notFor.map((item) => (
                          <span key={item} className="rounded-full border border-[var(--state-warning-border)] px-2 py-0.5 text-[length:var(--font-micro)] text-[var(--state-warning)]">
                            {item}
                          </span>
                        )) : <span className="text-[length:var(--font-micro)] text-[var(--text-tertiary)]">未声明</span>}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3">
                    <div className="mb-1 text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-secondary)]">声明的工具</div>
                    <div className="flex flex-wrap gap-1">
                      {activeSkill.tools.length > 0 ? activeSkill.tools.map((tool) => (
                        <span key={tool} className="rounded-[var(--radius-sm)] border border-[var(--border)] px-1.5 py-0.5 font-mono text-[length:var(--font-micro)] text-[var(--text-secondary)]">
                          {tool}
                        </span>
                      )) : <span className="text-[length:var(--font-micro)] text-[var(--text-tertiary)]">未声明</span>}
                    </div>
                  </div>
                  <p className="mt-3 truncate font-mono text-[length:var(--font-micro)] text-[var(--text-tertiary)]" title={activeSkill.path}>
                    {activeSkill.path}
                  </p>
                </>
              ) : (
                <p className="py-8 text-center text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
                  选择一个技能查看详情
                </p>
              )}
            </div>

            <div className="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex items-center gap-2">
                <Waypoints className="h-4 w-4 text-[var(--accent)]" />
                <h3 className="text-[length:var(--font-body)] font-medium text-[var(--text-primary)]">路由试跑</h3>
              </div>
              <p className="mt-1 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-tertiary)]">
                输入一句真实任务，看两级路由先晋级哪些分支、再命中哪些技能。不调用模型，零成本。
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  value={routeText}
                  onChange={(event) => setRouteText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void runRoute();
                  }}
                  placeholder="例如：把这份 Excel 做成三表模型"
                  className="min-w-0 flex-1 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-[length:var(--font-caption)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
                <button
                  type="button"
                  onClick={() => void runRoute()}
                  disabled={routeBusy || !routeText.trim() || !skillsDir}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-field)] bg-[var(--accent)] px-3 py-1.5 text-[length:var(--font-caption)] font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  {routeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Waypoints className="h-3.5 w-3.5" />}
                  试跑
                </button>
              </div>
              {routeResult ? (
                <div className="mt-3 space-y-2">
                  {routeResult.branches?.length ? (
                    <p className="text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                      晋级分支：{routeResult.branches.join('、')}
                    </p>
                  ) : null}
                  {routeResult.skills.length === 0 ? (
                    <p className="text-[length:var(--font-caption)] text-[var(--text-tertiary)]">没有命中技能：本轮按无技能发送。</p>
                  ) : (
                    routeResult.skills.map((skill, index) => (
                      <button
                        key={`${skill.name}-${index}`}
                        type="button"
                        onClick={() => jumpToSkill(skill.name)}
                        title={(skill.categoryPath?.length ?? 0) > 0 ? `分类：${skill.categoryPath!.join(' / ')}` : undefined}
                        className="flex w-full items-center gap-2 rounded-[var(--radius-field)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-left transition-colors hover:border-[var(--accent)]"
                      >
                        <span className="rounded-full bg-[var(--accent-subtle)] px-1.5 py-0.5 font-mono text-[length:var(--font-micro)] text-[var(--accent)]">
                          #{index + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[length:var(--font-caption)] text-[var(--text-primary)]">{skill.name}</span>
                        <span className="hidden flex-shrink-0 truncate text-[length:var(--font-micro)] text-[var(--text-tertiary)] sm:block">
                          {skill.categoryPath?.join(' / ') ?? UNCLASSIFIED}
                        </span>
                        <span className="flex-shrink-0 font-mono text-[length:var(--font-micro)] text-[var(--text-secondary)]">得分 {skill.score.toFixed(1)}</span>
                        <span className="flex-shrink-0 text-[length:var(--font-micro)] text-[var(--text-tertiary)]">{skill.body.length} 字符</span>
                      </button>
                    ))
                  )}
                  <details className="rounded-[var(--radius-field)] border border-[var(--border-subtle)] px-2.5 py-2">
                    <summary className="cursor-pointer text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
                      查看注入正文（{routeResult.context.length} 字符）
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[length:var(--font-micro)] leading-relaxed text-[var(--text-secondary)]">
                      {routeResult.context || '（空）'}
                    </pre>
                  </details>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
