# fast-27b 附件恢复（2026-10-15）

## 修复范围

- 恢复自带聊天页 fast-27b 后端的文件选择、普通拖拽与桌面路径拖拽，不再统一拒绝附件。
- 照片使用 `image_url`，视频使用 Chat Completions 原生 `video_url`，不转为 llama.cpp 专用 `input_video`，也不自动转成图片帧或切换后端。
- TXT、Markdown、代码、JSON、CSV 等原有文本格式继续读取内容并拼入用户消息。本次不新增 PDF、Word 二进制文档解析。
- fast-27b 的媒体能力依据当前端口、当前鉴权的 `/props.modalities.vision` 验证，不受主模型的 mmproj／视频能力限制。能力未启用或查询失败时明确拒绝媒体；文本仍可发送。
- 音频输入继续明确拒绝；视频只分析画面，不代表识别声轨。切换后端后残留的音频也会在发送前检查。
- 浏览器未提供媒体 MIME 时按扩展名补全；读取失败显示附件错误。保留原有单文本 1 MiB、单媒体 80 MiB 限制。
- 保留 MCP 工具声明、历史调用及结果回填字段。发送和重新生成均指定媒体协议后端。
- 主模型原有音频转换、原生视频及抽帧回退路径保留；加载、采样、上下文及思考默认参数未修改。

## 协议证据

只读核查时实际运行引擎是 `app/resources/fast-llm/engine/ninfer-serve-86.exe`；当前服务的 `/props` 报告视觉开启、音频关闭。融合引擎源码中的 `openai_chat_request.cpp` 接受 `image_url`、`video_url` 的 base64 data URL；Responses 的 `input_video` 与 Chat 协议不能混用。视频由引擎内部解码，不依赖客户端 llama.cpp 的视频转换流程。

## 验证

- 新增 `app/scripts/fast27b-media.test.mjs`，28 项纯函数及真实 `streamChatCompletion` 隔离集成测试通过。
- 全量前端回归 204/204 通过。
- `npm run build`（`tsc -b` + Vite）通过。
- lint：0 error，1 个既有 `useVirtualizer` 警告。
- `npm run desktop:build` 成功，最新程序已更新至 `app/src-tauri/target/release/agent-llm.exe`。
- `git diff --check` 通过。本轮未新增 Rust 改动，未重跑 Rust 单元测试；桌面 release 编译通过。
- 浏览器实际聊天页切换 fast-27b 后上传入口可用。浏览器环境无桌面引擎状态，且自动化不支持文件选择上传，因此未将这一项视为桌面端端到端附件验收。
- 本机媒体小样本推理未完成：最初未鉴权探测返回 401；后续使用既有本地鉴权时服务已不可连接（Windows 10061）。没有为验证重启模型，实际发送推理请求 0 次。自动化证明客户端协议与控制流，不代表任意视频编解码器或媒体内容识别已实机验证。

本轮不提交或推送，不修改显存预测算法；此前完成的自动调参改动保留。
