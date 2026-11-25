import { useEffect, useRef, type RefObject } from 'react';

/**
 * 弹出菜单的键盘行为（对话输入栏的思考/权限/技能菜单共用）。
 *
 * - 打开时把焦点移到第一项：鼠标点开后也能直接按 ↑/↓ 选择，不用先 Tab；
 * - ↑/↓ 循环移动，Home/End 跳到首尾；
 * - Esc 关闭菜单并把焦点还给触发按钮（不把用户丢在页面顶部）；
 * - 菜单项按 DOM 顺序取 `button`（禁用项跳过），不要求子组件额外声明 role。
 *
 * 注意：`onClose` 用 ref 保存，避免父组件每次渲染传入新闭包导致 effect 重跑、
 * 把焦点反复抢回第一项。
 */
export function useMenuKeyboard({
  open,
  menuRef,
  triggerRef,
  onClose,
}: {
  open: boolean;
  menuRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  // 在 effect 里同步而不是渲染期写 ref（lint react-hooks/refs）；
  // 该 effect 先于下面的键盘监听 effect 执行，事件触发时读到的始终是本次渲染的闭包。
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    // 只取弹层内部的按钮：menuRef 是「触发按钮 + 弹层」的容器，
    // 直接在容器里查会把触发按钮也算成第一项。
    const items = () => {
      const popup = menuRef.current?.querySelector<HTMLElement>('[role="menu"]') ?? menuRef.current;
      return Array.from(
        popup?.querySelectorAll<HTMLElement>('button:not([disabled]), [role="menuitem"]:not([disabled])') ?? [],
      );
    };
    // 等一帧，避开进场动画期间的布局抖动。
    const timer = window.setTimeout(() => {
      const list = items();
      const active = document.activeElement as HTMLElement | null;
      // 焦点已经在某个菜单项上时不重复聚焦（避免和用户的 Tab 抢焦点）；
      // 停在触发按钮上也属于「还没进入菜单」，要移进来。
      if (!active || !list.includes(active)) list[0]?.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
      const list = items();
      if (list.length === 0) return;
      event.preventDefault();
      const index = list.indexOf(document.activeElement as HTMLElement);
      let next = 0;
      if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % list.length;
      else if (event.key === 'ArrowUp') next = index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length;
      else if (event.key === 'End') next = list.length - 1;
      list[next]?.focus();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.clearTimeout(timer);
    };
  }, [menuRef, open, triggerRef]);
}
