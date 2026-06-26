import { useMemo, useState, type PointerEvent } from 'react';
import { Database, FolderPlus, RefreshCw, Search } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import ModelCard from '@/components/ModelCard';
import ModelDownloadPanel from '@/components/ModelDownloadPanel';
import SortDropdown from '@/components/SortDropdown';
import ColumnToggle from '@/components/ColumnToggle';
import { isDesktopRuntime, scanDesktopModels, toFrontendModel } from '@/lib/desktop';

export default function HomePage() {
  const { state, dispatch } = useApp();
  const [isScanning, setIsScanning] = useState(false);

  const sortedModels = useMemo(() => {
    let models = [...state.models];
    // Search filter
    if (state.searchQuery.trim()) {
      const q = state.searchQuery.toLowerCase();
      models = models.filter((m) =>
        m.name.toLowerCase().includes(q) ||
        m.family.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q))
      );
    }

    const recentUsedAt = (model: typeof models[number]) => state.recentModelUsage[model.id] ?? 0;
    const compareRecentFirst = (a: typeof models[number], b: typeof models[number]) => {
      const recentDelta = recentUsedAt(b) - recentUsedAt(a);
      if (recentDelta !== 0) return recentDelta;
      if (a.status === 'loaded' && b.status !== 'loaded') return -1;
      if (a.status !== 'loaded' && b.status === 'loaded') return 1;
      return 0;
    };
    const sortWithRecent = (compare?: (a: typeof models[number], b: typeof models[number]) => number) =>
      models.sort((a, b) => compareRecentFirst(a, b) || (compare ? compare(a, b) : 0));

    // Sort
    switch (state.sortBy) {
      case 'name':
        return sortWithRecent((a, b) => a.name.localeCompare(b.name));
      case 'size': {
        const parseParams = (p: string) => {
          const num = parseFloat(p);
          return p.includes('M') ? num / 1000 : num;
        };
        return sortWithRecent((a, b) => parseParams(a.params) - parseParams(b.params));
      }
      case 'updated':
        return sortWithRecent((a, b) => b.releaseDate.localeCompare(a.releaseDate));
      default:
        return sortWithRecent();
    }
  }, [state.models, state.recentModelUsage, state.sortBy, state.searchQuery]);

  const recentModelCount = useMemo(() => {
    const visibleModelIds = new Set(state.models.map((model) => model.id));
    return Object.keys(state.recentModelUsage).filter((modelId) => visibleModelIds.has(modelId)).length;
  }, [state.models, state.recentModelUsage]);

  const handleSurfacePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const xRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const yRatio = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    // 鼠标引力：放大位移与拉拽幅度，让点阵被指针「吸过去」的感觉更明显
    event.currentTarget.style.setProperty('--dot-shift-x', `${(xRatio - 0.5) * 28}px`);
    event.currentTarget.style.setProperty('--dot-shift-y', `${(yRatio - 0.5) * 28}px`);
    event.currentTarget.style.setProperty('--dot-pull-x', `${(xRatio - 0.5) * 44}px`);
    event.currentTarget.style.setProperty('--dot-pull-y', `${(yRatio - 0.5) * 44}px`);
    event.currentTarget.style.setProperty('--dot-focus-x', `${xRatio * 100}%`);
    event.currentTarget.style.setProperty('--dot-focus-y', `${yRatio * 100}%`);
  };

  const handleSurfacePointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.style.setProperty('--dot-shift-x', '0px');
    event.currentTarget.style.setProperty('--dot-shift-y', '0px');
    event.currentTarget.style.setProperty('--dot-pull-x', '0px');
    event.currentTarget.style.setProperty('--dot-pull-y', '0px');
    event.currentTarget.style.setProperty('--dot-focus-x', '50%');
    event.currentTarget.style.setProperty('--dot-focus-y', '50%');
  };

  const handleRefreshModels = async () => {
    if (!isDesktopRuntime()) {
      dispatch({ type: 'SET_APP_STATUS', payload: '请在桌面版中刷新真实 GGUF 模型列表。' });
      return;
    }

    setIsScanning(true);
    dispatch({ type: 'SET_APP_STATUS', payload: '正在刷新 GGUF 模型列表...' });
    try {
      const models = await scanDesktopModels(true);
      dispatch({ type: 'UPSERT_MODELS', payload: models.map(toFrontendModel) });
      dispatch({
        type: 'SET_APP_STATUS',
        payload: models.length > 0 ? `已发现 ${models.length} 个本地 GGUF 模型。` : '模型目录里暂未发现 GGUF 文件。',
      });
    } catch (error) {
      dispatch({ type: 'SET_APP_STATUS', payload: `刷新模型列表失败：${String(error)}` });
    } finally {
      setIsScanning(false);
    }
  };

  const gridClass = state.gridColumns === 2
    ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 justify-items-center gap-4'
    : 'grid-cols-1 w-full justify-items-stretch gap-2';

  return (
    <div
      className="model-dotted-surface flex h-full flex-1 flex-col overflow-hidden"
      onPointerMove={handleSurfacePointerMove}
      onPointerLeave={handleSurfacePointerLeave}
    >
      <header className="flex-shrink-0 border-b border-[#E7E2D8] bg-[#FBFAF6] px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-[1180px] min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-[#DCD8CF] bg-[#FAF9F5] text-[#D06646] shadow-[0_1px_0_rgba(255,255,255,0.7)]">
            <Database className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold leading-tight text-[#2F2C26]">模型管理</h1>
            <p className="mt-0.5 text-xs leading-5 text-[#7D766B]">
              扫描本地 GGUF 文件，选择模型并进入参数加载。
            </p>
          </div>
        </div>
      </header>

      <div className="flex-shrink-0 border-b border-[#E7E2D8] bg-[#F6F3ED] px-4 py-3 sm:px-6">
        <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-2 min-[560px]:grid-cols-[minmax(220px,1fr)_auto_auto] min-[560px]:items-center">
          <div className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-[#DCD8CF] bg-[#FBFAF6] px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
            <Search className="h-4 w-4 flex-shrink-0 text-[#8B8275]" />
            <input
              type="text"
              placeholder="搜索模型..."
              value={state.searchQuery}
              onChange={(e) => dispatch({ type: 'SET_SEARCH', payload: e.target.value })}
              className="min-w-0 flex-1 bg-transparent text-sm text-[#2F2C26] outline-none placeholder:text-[#A09A90]"
            />
          </div>
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2 min-[560px]:contents">
            <button
              onClick={() => void handleRefreshModels()}
              disabled={isScanning}
              className="flex h-9 items-center justify-center gap-2 rounded-lg border border-[#DCD8CF] bg-[#FBFAF6] px-3 text-sm text-[#2F2C26] transition-colors hover:bg-[#F1EEE7] disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 text-[#7D766B] ${isScanning ? 'animate-spin' : ''}`} />
              <span className="hidden min-[390px]:inline">刷新列表</span>
              <span className="min-[390px]:hidden">刷新</span>
            </button>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
              <SortDropdown />
              <ColumnToggle />
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
        <div className="mx-auto max-w-[1180px]">
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-[#7D766B]">
            <span className="rounded-md border border-[#E4E0D8] bg-[#FAF9F5] px-2.5 py-1">
              {state.models.length} 个模型
            </span>
            <span className="rounded-md border border-[#E4E0D8] bg-[#FAF9F5] px-2.5 py-1">
              {state.models.filter((m) => m.status === 'loaded').length} 个已加载
            </span>
            {recentModelCount > 0 && (
              <span className="rounded-md border border-[#E4E0D8] bg-[#FAF9F5] px-2.5 py-1">
                最近使用 {recentModelCount} 个
              </span>
            )}
            {state.appStatus && (
              <span className="min-w-0 truncate rounded-md border border-[#E4E0D8] bg-[#FAF9F5] px-2.5 py-1">
                {state.appStatus}
              </span>
            )}
          </div>

          <div className="perspective-1000 pb-8">
            <div
              key={`model-grid-${state.gridColumns}`}
              className={`anim-fade-rise grid ${gridClass}`}
            >
              {sortedModels.map((model, i) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  index={i}
                  isSingleColumn={state.gridColumns === 1}
                  recentUsedAt={state.recentModelUsage[model.id]}
                />
              ))}
            </div>
            {sortedModels.length === 0 && (
              <div className="flex min-h-[320px] items-center justify-center sm:min-h-[420px]">
                {state.gridColumns === 1 ? (
                  <div className="w-full rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] px-5 py-5 sm:px-6">
                    <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[#EEEAE2] text-[#D06646]">
                          <FolderPlus className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-base font-semibold text-[#2F2C26]">
                            {state.models.length === 0 ? '尚未发现真实 GGUF 模型' : '未找到匹配的模型'}
                          </div>
                          <p className="mt-1 text-sm leading-relaxed text-[#7D766B]">
                            {state.models.length === 0
                              ? '先在设置中选择模型目录，或在桌面版中刷新本地模型列表。'
                              : '请调整搜索关键词或排序方式。'}
                          </p>
                        </div>
                      </div>
                      {state.models.length === 0 && (
                        <div className="flex flex-shrink-0 gap-2">
                          <button
                            onClick={() => void handleRefreshModels()}
                            disabled={isScanning}
                            className="flex h-9 items-center gap-2 rounded-lg border border-[#DCD8CF] bg-[#FBFAF6] px-3 text-sm text-[#2F2C26] transition-colors hover:bg-[#F1EEE7] disabled:opacity-50"
                          >
                            <RefreshCw className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
                            刷新
                          </button>
                          <button
                            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'settings' })}
                            className="flex h-9 items-center rounded-lg bg-[#D06646] px-3 text-sm font-medium text-white transition-colors hover:bg-[#BE593A]"
                          >
                            选择目录
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="w-full max-w-md rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] px-8 py-10 text-center">
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#EEEAE2] text-[#D06646]">
                      <FolderPlus className="h-6 w-6" />
                    </div>
                    <div className="text-base font-semibold text-[#2F2C26]">
                      {state.models.length === 0 ? '尚未发现真实 GGUF 模型' : '未找到匹配的模型'}
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-[#7D766B]">
                      {state.models.length === 0
                        ? '先在设置中选择模型目录，或在桌面版中刷新本地模型列表。'
                        : '请调整搜索关键词或排序方式。'}
                    </p>
                    {state.models.length === 0 && (
                      <div className="mt-5 flex justify-center gap-2">
                        <button
                          onClick={() => void handleRefreshModels()}
                          disabled={isScanning}
                          className="flex h-9 items-center gap-2 rounded-lg border border-[#DCD8CF] bg-[#FAF9F5] px-3 text-sm text-[#2F2C26] transition-colors hover:bg-[#F1EEE7] disabled:opacity-50"
                        >
                          <RefreshCw className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
                          刷新
                        </button>
                        <button
                          onClick={() => dispatch({ type: 'SET_VIEW', payload: 'settings' })}
                          className="flex h-9 items-center rounded-lg bg-[#D06646] px-3 text-sm font-medium text-white transition-colors hover:bg-[#BE593A]"
                        >
                          选择目录
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <ModelDownloadPanel />
    </div>
  );
}
