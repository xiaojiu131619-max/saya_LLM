/**
 * 传输层 barrel：把 `lib/ipc/*` 的纯 invoke 包装统一对外暴露。
 *
 * 调用方（页面 / 组件 / hooks）继续从 `@/lib/desktop` 导入即可，无需改动；
 * `lib/desktop` 会再导出本模块，保持原有导入路径与名字不变。
 */
export * from './config';
export * from './model';
export * from './server';
export * from './system';
export * from './kernel';
export * from './dsh';
export * from './fast27b';
export * from './mcp';
