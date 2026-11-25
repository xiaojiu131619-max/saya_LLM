/**
 * 全局状态落盘的紧急刹车。
 *
 * 出厂重置会先删除 localStorage 里的快照，再刷新窗口；刷新触发的
 * `beforeunload` 会把内存里的旧状态重新拼成快照写回同一个 key，让刚清掉的
 * 聊天记录、用量和界面偏好「复活」。调用 suspendAppStatePersistence() 后，
 * 防抖落盘与页面隐藏/卸载时的立即落盘都不再执行，直到页面刷新
 * （模块随页面重新初始化，暂停状态自然失效）。
 *
 * 只应由「清空本地数据」类操作调用，且调用方必须在之后尽快刷新窗口；
 * 否则本次会话余下的改动都不会保存。
 */
let suspended = false;

/** 暂停本次页面生命周期内的所有落盘。 */
export function suspendAppStatePersistence() {
  suspended = true;
}

/** 是否已暂停落盘（usePersistState 在调度与写盘前都会检查）。 */
export function appStatePersistenceSuspended() {
  return suspended;
}
