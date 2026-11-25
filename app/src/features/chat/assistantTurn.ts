import type { Dispatch } from 'react';
import type { Action } from '@/context/appState/appActions';
import type { ChatCompletionMessage } from '@/lib/desktop';
import { callMcpTool, serverErrorHint, streamChatCompletion } from '@/lib/desktop';
import {
  MAX_TOOL_ROUNDS,
  collectMcpToolSpecs,
  runChatToolLoop as runToolLoop,
  type ChatRoundRunner,
} from '@/features/chat/mcpTools';
import { judgeDelivery } from '@/features/chat/deliveryGuard';
import { createStreamFlusher, terminatedMessageStats } from '@/features/chat/chatTurnHelpers';
import type {
  ChatGenerationConfig,
  ChatEngineId,
  McpServerEntry,
  Message,
  ReasoningProfile,
  ToolActivity,
  VideoSupportLevel,
} from '@/types';

/** 单轮流式回合的下发参数（主模型与 NiNfer / Strata 引擎共用同一条补全链路）。 */
export interface AssistantTurnRequest {
  port: number;
  modelName: string;
  ctxTotal: number;
  supportsReasoning: boolean;
  reasoningBudget: number;
  reasoningProfile: ReasoningProfile;
  videoSupport: VideoSupportLevel;
  mediaBackend: Extract<ChatEngineId, 'fast27b'> | 'llama';
  /** 主模型对外 API 未启用时为 undefined（本机回环不携带鉴权）。 */
  apiKey: string | undefined;
}

export interface AssistantTurnParams {
  dispatch: Dispatch<Action>;
  sessionModelId: string;
  sessionId: string;
  /** 本轮的完整对话历史：已包含最新一条用户消息。 */
  turnMessages: Message[];
  req: AssistantTurnRequest;
  config: ChatGenerationConfig;
  mcpServers: McpServerEntry[];
  /** 气泡与用量记录使用的模型身份（主模型真实信息 / 引擎合成 ID）。 */
  chatIdentity: { id: string; name: string; color: string };
  /** 会话级在途中止句柄表：回合开始注册、finally 清理，与停止按钮共享同一份。 */
  abortControllers: Map<string, AbortController>;
  /** 失败时写进气泡的错误前缀（发送 = 本地推理请求失败；重发 = 重新发送失败）。 */
  failurePrefix: string;
  /** 中止时的界面提示（写输入区上方的 stopMessage）。 */
  notifyStop: (message: string) => void;
  /** 首轮完整回答后的回调（发送流程用它触发自动标题，重发流程不传）。 */
  onComplete?: (assistantText: string) => void;
}

/**
 * 执行一轮「补全流」回答：插入流式 assistant 气泡 → 首轮流 → 工具调用循环 →
 * 交付护栏 → 用量落账 → 收尾（成功 / 中止 / 失败三态）。
 *
 * 原 ChatPage 里 handleSend 与 handleEditAndResend 各自维护一份几乎相同的
 * 350 行流程，差异只有三处：历史来源（新发 vs 截断重发）、失败前缀文案、
 * 以及发送流程独有的自动标题——现在统一由本函数承担，调用方只负责准备
 * 会话与用户消息。
 */
export async function runAssistantTurn(params: AssistantTurnParams): Promise<void> {
  const {
    dispatch,
    sessionModelId,
    sessionId,
    turnMessages,
    req,
    config,
    mcpServers,
    chatIdentity,
    abortControllers,
    failurePrefix,
    notifyStop,
    onComplete,
  } = params;

  const assistantMsgId = `msg-${Date.now()}-assistant`;
  const startTime = performance.now();
  const abortController = new AbortController();
  abortControllers.set(sessionId, abortController);

  dispatch({
    type: 'ADD_MESSAGE',
    payload: {
      modelId: sessionModelId,
      sessionId,
      message: {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        reasoningContent: '',
        modelId: chatIdentity.id,
        modelName: chatIdentity.name,
        modelColor: chatIdentity.color,
        timestamp: Date.now(),
        isStreaming: true,
      },
    },
  });

  let streamedContent = '';
  const contentFlusher = createStreamFlusher((content) => {
    dispatch({
      type: 'UPDATE_MESSAGE',
      payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, content },
    });
  });
  // 滚动统一由内容变化的 useLayoutEffect 接管，避免每个 token 都 scrollToIndex。
  const updateAssistantContent = (content: string) => contentFlusher.push(content);
  const updateActivity = (activities: ToolActivity[]) => {
    dispatch({
      type: 'UPDATE_MESSAGE',
      payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, toolActivity: activities },
    });
  };

  // MCP 工具清单：只纳入已连接服务器的工具；没有可用工具时请求不带 tools 字段。
  // 主模型与 NiNfer 都使用同一套 OpenAI 兼容工具调用链路。
  const toolSpecs = collectMcpToolSpecs(mcpServers);
  const conversation: ChatCompletionMessage[] = turnMessages.map((msg) => ({
    role: msg.role,
    content: msg.multimodalContent ?? msg.content,
  }));
  // 交付护栏的统计口径：思考字符数（判"是否被思考吃光"）与工具调用名（判纯工具轮）。
  let reasoningChars = 0;
  let toolNames: string[] = [];
  const runRound: ChatRoundRunner = (messages, handlers) => streamChatCompletion({
    port: req.port,
    modelName: req.modelName,
    config,
    ctxTotal: req.ctxTotal,
    supportsReasoning: req.supportsReasoning,
    reasoningBudget: req.reasoningBudget,
    reasoningProfile: req.reasoningProfile,
    videoSupport: req.videoSupport,
    mediaBackend: req.mediaBackend,
    apiKey: req.apiKey,
    signal: abortController.signal,
    ...(toolSpecs.specs.length > 0 ? { tools: toolSpecs.specs } : {}),
    messages,
    onToken: handlers.onToken,
    onReasoningDelta: handlers.onReasoningDelta,
  });

  try {
    const first = await runRound(conversation, {
      onToken: (token) => {
        streamedContent += token;
        updateAssistantContent(streamedContent);
      },
      onReasoningDelta: (reasoningContent) => {
        reasoningChars = reasoningContent.length;
        dispatch({
          type: 'UPDATE_MESSAGE',
          payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, reasoningContent },
        });
      },
    });

    // 工具调用循环：模型请求工具 → 应用执行 → 结果回填 → 继续生成。
    let metrics = first;
    if (first.toolCalls.length > 0) {
      const contentRef = { value: streamedContent };
      const outcome = await runToolLoop({
        runRound: async (messages, handlers) => {
          const result = await runRound(messages, handlers);
          metrics = result;
          return result;
        },
        servers: mcpServers,
        conversation,
        initialContent: streamedContent,
        initialPromptTokens: first.promptTokens,
        initialCompletionTokens: first.completionTokens,
        initialMetrics: first,
        initialToolCalls: first.toolCalls,
        callTool: async (serverId, toolName, args) => {
          const payload = await callMcpTool(serverId, toolName, args);
          return { text: payload?.text ?? '', isError: payload?.isError };
        },
        signal: abortController.signal,
        onContent: (content) => {
          contentRef.value = content;
          updateAssistantContent(content);
        },
        onReasoningDelta: (reasoningContent) => {
          reasoningChars = reasoningContent.length;
          dispatch({
            type: 'UPDATE_MESSAGE',
            payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, reasoningContent },
          });
        },
        onActivity: updateActivity,
      });

      streamedContent = contentRef.value;
      toolNames = outcome.activities.map((activity) => activity.tool);
      if (outcome.hitRoundLimit) {
        streamedContent += `\n\n（本轮工具调用已达 ${MAX_TOOL_ROUNDS} 轮上限，为避免失控已停止继续调用。）`;
        updateAssistantContent(streamedContent);
      }
      metrics = outcome.metrics;
    }

    // 交付护栏：只提示、不重发（hub/docs/04 F2 的降级实现）。
    // 三种客观破损：空正文 / 产物未闭合 / finish_reason=length；判定见 deliveryGuard.ts。
    // 结束前把缓冲里的最后一段内容落盘，保证界面与 streamedContent 一致。
    contentFlusher.commit();
    const verdict = judgeDelivery({
      content: streamedContent,
      finishReason: metrics.finishReason,
      reasoningChars,
      toolNames,
    });
    if (!verdict.ok) {
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, warnings: [verdict.detail] },
      });
    }

    const genTime = (performance.now() - startTime) / 1000;
    if (metrics.promptTokens > 0 || metrics.completionTokens > 0) {
      dispatch({
        type: 'ADD_USAGE',
        payload: {
          modelId: chatIdentity.id,
          modelName: chatIdentity.name,
          modelColor: chatIdentity.color,
          promptTokens: metrics.promptTokens,
          completionTokens: metrics.completionTokens,
          totalTokens: metrics.promptTokens + metrics.completionTokens,
          tokensPerSec: metrics.tokensPerSec,
          firstTokenDelay: metrics.firstTokenDelay,
          genTime,
        },
      });
    }
    dispatch({
      type: 'SET_MESSAGE_STREAMING',
      payload: {
        modelId: sessionModelId,
        sessionId,
        messageId: assistantMsgId,
        streaming: false,
        stats: {
          ctxUsed: metrics.ctxUsed,
          ctxTotal: metrics.ctxTotal,
          outputTokens: metrics.completionTokens,
          firstTokenDelay: metrics.firstTokenDelay,
          tokensPerSec: metrics.tokensPerSec ?? 0,
          genTime: metrics.genTime || genTime,
        },
      },
    });

    onComplete?.(streamedContent);
  } catch (error) {
    // 先把已经收到的内容落盘：中止时尾部不能丢字；
    // 出错时随后写入的错误文案会覆盖部分内容，所以顺序不能反。
    contentFlusher.commit();
    if (abortController.signal.aborted) {
      notifyStop('已停止生成。');
      dispatch({
        type: 'SET_MESSAGE_STREAMING',
        payload: {
          modelId: sessionModelId,
          sessionId,
          messageId: assistantMsgId,
          streaming: false,
          stats: terminatedMessageStats(error, startTime, req.ctxTotal),
        },
      });
    } else {
      const message = `${failurePrefix}：${String(error instanceof Error ? error.message : error)}\n\n${serverErrorHint(error)}`;
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, content: message, reasoningContent: '' },
      });
      dispatch({
        type: 'SET_MESSAGE_STREAMING',
        payload: {
          modelId: sessionModelId,
          sessionId,
          messageId: assistantMsgId,
          streaming: false,
          stats: terminatedMessageStats(error, startTime, req.ctxTotal),
        },
      });
    }
  } finally {
    if (abortControllers.get(sessionId) === abortController) {
      abortControllers.delete(sessionId);
    }
  }
}
