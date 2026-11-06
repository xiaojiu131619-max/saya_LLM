import { useEffect, useRef } from 'react';
import {
  LINE_FIELD_COLUMNS,
  drawLineField,
  prefersReducedMotion,
  sampleLineField,
} from '@/lib/lineField';

interface ModelLineFieldProps {
  /** 承载品牌标志的容器，采样从这里取 SVG / img。 */
  target: { current: Element | null };
  /** 线场颜色，通常传模型的 themeColorSolid。 */
  color: string;
  /** 卡片数量过多时由上层关掉动效，只保留静态首帧（D-39）。 */
  allowAnimation: boolean;
}

/** 全局只允许一张卡片跑动效（D-57）。 */
let stopActiveField: (() => void) | null = null;

/**
 * 卡片水印式量化线场：静态首帧常驻，悬停 / 键盘聚焦时该卡单独运行动效。
 * 画布只作装饰，对辅助技术隐藏；不接收指针事件。
 *
 * 采样发生在卡片首次进入视口时，且同品牌共用缓存——列表上千条也不会
 * 在挂载瞬间同时解码几百个图标。
 */
export default function ModelLineField({ target, color, allowAnimation }: ModelLineFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gridRef = useRef<Float32Array | null>(null);
  const rafRef = useRef<number | null>(null);
  const visibleRef = useRef(false);
  const pointerRef = useRef({ x: 0, y: 0, pulse: 0 });
  const clockRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return undefined;

    let disposed = false;
    let resolvedColor = color;
    let lastFrame = 0;

    // themeColorSolid 可能是 CSS 变量，画布只认具体色值，用探针元素解析一次。
    if (!/^(#|rgb|hsl)/i.test(resolvedColor)) {
      const probe = document.createElement('span');
      probe.style.color = resolvedColor;
      probe.style.display = 'none';
      host.appendChild(probe);
      const computed = getComputedStyle(probe).color;
      probe.remove();
      if (computed) resolvedColor = computed;
    }

    const paint = (time: number) => {
      const grid = gridRef.current;
      if (!grid) return;
      const rect = host.getBoundingClientRect();
      drawLineField(canvas, grid, {
        cssWidth: rect.width,
        cssHeight: rect.height,
        color: resolvedColor,
        time,
        pointer: time > 0 ? pointerRef.current : null,
      });
    };

    const stop = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      clockRef.current = 0;
      pointerRef.current.pulse = 0;
      if (stopActiveField === stop) stopActiveField = null;
      paint(0);
    };

    const canAnimate = () =>
      allowAnimation && visibleRef.current && !document.hidden && !prefersReducedMotion();

    const tick = (now: number) => {
      if (!canAnimate()) {
        rafRef.current = null;
        paint(0);
        return;
      }
      const delta = clockRef.current === 0 ? 1 / 60 : Math.min((now - lastFrame) / 1000, 1 / 30);
      lastFrame = now;
      clockRef.current += delta;
      pointerRef.current.pulse *= Math.exp(-delta * 5.5);
      paint(clockRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };

    const start = () => {
      if (rafRef.current != null || !canAnimate()) return;
      if (stopActiveField && stopActiveField !== stop) stopActiveField();
      stopActiveField = stop;
      lastFrame = performance.now();
      rafRef.current = requestAnimationFrame(tick);
    };

    const ensureSampled = () => {
      if (gridRef.current || disposed || !target.current) return;
      void sampleLineField(target.current).then((grid) => {
        if (disposed || !grid) return;
        gridRef.current = grid;
        paint(0);
      });
    };

    const hostCard = (canvas.closest('article') ?? host) as HTMLElement;
    const onEnter = () => {
      ensureSampled();
      start();
    };
    const onLeave = () => stop();
    const onMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointerRef.current.x = event.clientX - rect.left;
      pointerRef.current.y = event.clientY - rect.top;
      pointerRef.current.pulse = 1;
      start();
    };

    hostCard.addEventListener('pointerenter', onEnter);
    hostCard.addEventListener('pointermove', onMove);
    hostCard.addEventListener('pointerleave', onLeave);
    hostCard.addEventListener('focusin', onEnter);
    hostCard.addEventListener('focusout', onLeave);

    // 尺寸变化只重绘、不重新采样（D-40）：网格只依赖图形，与画布尺寸无关。
    const resizeObserver = new ResizeObserver(() => {
      if (rafRef.current == null) paint(0);
    });
    resizeObserver.observe(host);

    const intersectionObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      visibleRef.current = entry?.isIntersecting ?? false;
      if (visibleRef.current) ensureSampled();
      else if (rafRef.current == null) stop();
    });
    intersectionObserver.observe(host);

    const onVisibility = () => {
      if (document.hidden) stop();
      else if (visibleRef.current) paint(0);
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (stopActiveField === stop) stopActiveField = null;
      hostCard.removeEventListener('pointerenter', onEnter);
      hostCard.removeEventListener('pointermove', onMove);
      hostCard.removeEventListener('pointerleave', onLeave);
      hostCard.removeEventListener('focusin', onEnter);
      hostCard.removeEventListener('focusout', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  }, [allowAnimation, color, target]);

  return (
    <canvas
      ref={canvasRef}
      className="model-line-field"
      aria-hidden="true"
      // 采样前保持 0 尺寸，避免每张卡片默认占一块 300×150 的像素缓冲。
      width={0}
      height={0}
      data-columns={LINE_FIELD_COLUMNS}
    />
  );
}
