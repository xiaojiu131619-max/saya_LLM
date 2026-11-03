# 0.5 之后的完成清单

> 本清单记录尚未实施的事项；已完成项随完成批次更新状态。  
> 0.5 交付内容见 `CHANGELOG.md`。

## P0：Pi 内核收口 — ✅ 已完成（2026-11-04）

1. **Pi 在线安装 / 升级**（`services/pi_install.rs`）
   - npm registry 在线安装 / 升级指定版本（官方源 + npmmirror 镜像可选）；
   - npm 自带 SRI（sha512）逐包校验 + 顶层包 integrity 记录进 `pi-version.json`；
   - 安装后 `--version` 冒烟，失败自动恢复上一版本；
   - 升级保留 `node_modules.backup` 回滚点，界面可一键回滚上一版本。

## P1：技能与模型 — ✅ 已完成（2026-11-04）

2. **技能路由对齐完整雷达**（`services/pi_skills.rs`）
   - 打分口径与拾一雷达一致：名称 +3 / 格式词 +3 / 别名 +2 / 触发词 +2 /
     描述 token +0.5（封顶 4）/ `not_for` −4 / 查询型 −0.5；
   - `not_for` 解析 + `DEFAULT_NEGATIVE` 兜底、delegated 转发器互斥、
     格式词（stl/mp4/xlsx…）词边界加权、纯描述命中不入选（强信号门）；
   - 真实 238 技能回归集（`real_skills_router_regression`，11 条输入全过）。

3. **模型矩阵**（`scripts/pi-model-matrix.mjs` + `docs/reports/PI_MODEL_MATRIX_2026-11-04.md`）
   - Saluki-27B IQ2：10 项电池 0.90 成功率、0 协议失败、TTFT 中位 423ms，
     副作用逐项校验，越界写观测为「拒绝」；
   - Spark-X2.6-4B 沿用 2026-11-03 spike 结果；
   - MiMo 9B（本机无模型）与外部端点（无 Key）已记录结论，脚本支持补测。

## P2：画布联动 — M1/M2 已完成，M3 部分完成（2026-11-04）

4. **无限画布 × Pi 联动**（`services/canvas_agent.rs`）
   - M1 只读：`canvas_status` / `canvas_list_workflows` / `canvas_get_workflow`；
   - M2 生图：`canvas_run`（白名单工作流、输出固定会话工作区 `canvas/`、
     守门档逐条确认、`canvas_cancel` 中断 ComfyUI）；
   - M3 核心：`canvas_run` 支持 `input_images`（工作区相对路径 → 沙箱校验 →
     multipart 图生图），产物回写 `canvas/` 并进产物卡；
   - 画布包更新到上游 v0.24.7（commit 1a67130），zip 重新打包并同步 SHA256。
   - **未实施**：画布 UI「选中项交给Pi」按钮——画布前端是压缩产物、无稳定
     全局 API，注入 DOM 抓取会随画布升级碎掉；改由「Pi 工作区已有图 →
     canvas_run 图生图」覆盖同一场景（图可由产物卡/拖拽进工作区）。

## P3：体验与文档 — ✅ 已完成（2026-11-04）

5. **Agent 消息性能指标**：Pi `message_update` 自带 usage（provider 上报）+
   增量事件时刻 → tok/s、TTFT、token 统计写入消息 `stats`，气泡统计行与
   普通对话同口径。
6. **记忆功能**：`save_memory` 宿主工具（plan 拒 / auto 询问 / full 直记）+
   工具失败自动记录（连续重复去重）+ 每轮【长期记忆】注入，全局
   `%APPDATA%/AgentLLM/pi/memory/` 落盘。
7. **Pi 浮窗**：标题栏机器人按钮 / `pi_float_window` 打开常驻小窗
   （置顶、不进任务栏、关闭即隐藏），快聊走当前 Pi 会话与技能路由，
   被其他会话占用时明确提示。
8. **CHANGELOG / 文档债**：0.5 之后的改动已按批次记录，发版前归并。
