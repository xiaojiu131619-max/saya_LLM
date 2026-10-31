import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 侧边栏宽度拖拽。
 *
 * 为什么要这么写：
 * - 拖拽必须跟随指针 1:1（不能有过渡动画，否则手感发飘），因此拖拽期间直接写
 *   内联宽度，松手后才把最终值提交给上层持久化；
 * - 用 `pointerdown/move/up` + `setPointerCapture`，鼠标移出窗口边界也不会断；
 * - 拖拽时给 body 加 `cursor: col-resize` 并禁用文本选择，否则会拖出蓝色选区；
 * - 用 ref 记住「上一次提交的值」，指针没真正移动时不重复提交（避免持久化抖动）。
 *
 * 宽度收口由调用方传进来的 clamp 函数负责（与 AppContext 的上下限同源）。
 */
export function useResizableWidth({
  value,
  onChange,
  min,
  max,
  direction = 'right',
}: {
  /** 当前宽度（受控）。 */
  value: number;
  /** 拖拽结束时的提交回调（拖拽期间不调用）。 */
  onChange: (width: number) => void;
  min: number;
  max: number;
  /** 分隔条在侧边栏的哪一侧：right = 侧边栏在左、拖右侧边；left = 侧边栏在右。 */
  direction?: 'left' | 'right';
}) {
  const [dragging, setDragging] = useState(false);
  // 拖拽期间的实时宽度（非 null 时优先于受控 value 渲染）。
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const liveWidthRef = useRef<number | null>(null);

  const clamp = useCallback(
    (width: number) => Math.min(max, Math.max(min, Math.round(width))),
    [min, max],
  );

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    // 只接主键；避免右键菜单与中键滚动也触发拖拽。
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    startXRef.current = event.clientX;
    startWidthRef.current = value;
    liveWidthRef.current = value;
    setLiveWidth(value);
    setDragging(true);
  }, [value]);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (!dragging) return;
    const delta = event.clientX - startXRef.current;
    // 侧边栏在左侧时，往右拖变宽；在右侧时，往左拖变宽。
    const next = clamp(startWidthRef.current + (direction === 'right' ? delta : -delta));
    liveWidthRef.current = next;
    setLiveWidth(next);
  }, [clamp, direction, dragging]);

  const finish = useCallback((event: React.PointerEvent) => {
    if (!dragging) return;
    const element = event.currentTarget as HTMLElement;
    if (element.hasPointerCapture?.(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    setLiveWidth(null);
    const committed = liveWidthRef.current;
    liveWidthRef.current = null;
    if (committed !== null && committed !== value) onChange(committed);
  }, [dragging, onChange, value]);

  // 拖拽期间锁光标与选区：只在 dragging 为真时挂，松手立刻恢复。
  useEffect(() => {
    if (!dragging) return;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [dragging]);

  return {
    /** 实际渲染用的宽度（拖拽期间是实时值）。 */
    width: liveWidth ?? value,
    dragging,
    /** 分隔条要绑的 pointer 事件。 */
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
  };
}
