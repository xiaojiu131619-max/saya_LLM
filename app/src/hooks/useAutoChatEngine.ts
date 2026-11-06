import { useEffect } from 'react';
import { useApp } from '@/context/AppContext';
import { refreshEngineStatus, useEngineStatuses } from '@/hooks/useEngineStatuses';
import { useStrataStatus } from '@/hooks/useStrataStatus';
import { refreshStrataStatus } from '@/lib/desktopState';
import { isDesktopRuntime } from '@/lib/desktop';
import { listenDesktopEvent } from '@/lib/ipc/system';
import type { ChatEngineId } from '@/types';

/**
 * 主对话后端的自动选择。
 *
 * 主对话只有三个档：主模型 llama-server / NiNfer / Strata。三者在显存上互斥，
 * 任一时刻最多只有一个在跑，「当前该用哪个」本来就没有歧义——让用户手动切
 * 只会切到未运行的那一个然后报错。
 *
 * 判定优先级：
 * 1. 主模型服务在跑（llama-server 起来 + 有加载中的模型）→ 主模型；
 * 2. 否则 NiNfer 进程在跑 → NiNfer；
 * 3. 否则 Strata 进程在跑 → Strata；
 * 4. 都没跑 → 保持当前值（默认主模型），界面会提示「未加载模型」。
 *
 * 用「进程在跑」而不是「可对话」作为判据：引擎启动要几秒到十几分钟，
 * 启动期间对话页就该显示「引擎正在加载」，而不是继续指向已经被顶掉的主模型。
 *
 * agent（Pi）不在这条线上：它有自己的对话界面和独立数据，
 * 由侧边栏或 Agent 设置面板里的入口打开，不参与主对话的后端选择。
 */
export function useAutoChatEngine() {
  const { state, dispatch } = useApp();
  const engineStatuses = useEngineStatuses();
  const strataStatus = useStrataStatus();

  const mainRunning = state.serverRunning;
  const fast27bRunning = Boolean(engineStatuses.fast27b?.running);
  const strataRunning = Boolean(strataStatus?.running);

  useEffect(() => {
    // 三档之外的值一律回落主模型；Pi 属于 ChatScope，不参与引擎轴的自动选择。
    const fallback: ChatEngineId =
      state.chatEngine === 'fast27b' || state.chatEngine === 'strata' ? state.chatEngine : 'main';
    const target: ChatEngineId = mainRunning
      ? 'main'
      : fast27bRunning
        ? 'fast27b'
        : strataRunning
          ? 'strata'
          : fallback;
    if (target !== state.chatEngine) {
      dispatch({ type: 'SET_CHAT_ENGINE', payload: target });
    }
  }, [dispatch, fast27bRunning, mainRunning, strataRunning, state.chatEngine]);

  // 互斥闸门停掉某个后端时会发 stopped/ready 事件；立刻刷新对应快照，
  // 别让「自动选择」在 3 秒轮询间隙里继续指向已经被停掉的后端。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    const disposers: Array<() => void> = [];
    const track = (pending: Promise<() => void>) => {
      void pending
        .then((dispose) => {
          if (disposed) dispose();
          else disposers.push(dispose);
        })
        .catch(() => {});
    };
    track(listenDesktopEvent('fast27b:stopped', () => void refreshEngineStatus()));
    track(listenDesktopEvent('fast27b:ready', () => void refreshEngineStatus()));
    track(listenDesktopEvent('strata:stopped', () => void refreshStrataStatus()));
    track(listenDesktopEvent('strata:ready', () => void refreshStrataStatus()));
    return () => {
      disposed = true;
      disposers.forEach((dispose) => dispose());
    };
  }, []);
}
