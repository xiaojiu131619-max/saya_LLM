import { useRef, useState } from 'react';
import type { Dispatch, DragEvent, ChangeEvent, ClipboardEvent, RefObject, SetStateAction } from 'react';
import type { ChatEngineId } from '@/types';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_MEDIA_BYTES,
  attachmentBackendError,
  attachmentMediaMime,
  classifyAttachment,
  fileExtension,
  formatFileSize,
  type PendingAttachment,
} from '@/features/chat/chatUtils';
import { hasTransferContent, insertTransferText, readAttachmentTransfer } from '@/features/chat/attachmentTransfer';
import { readFileAsDataUrl } from '@/features/chat/chatTurnHelpers';

/**
 * 聊天输入栏的附件与拖拽/粘贴状态（拆自 ChatPage，逻辑保持逐行一致）：
 * 待发送附件、读取进度、拖拽高亮、文件选择 / 粘贴 / 跨应用拖入的统一入口。
 */
export function useChatAttachments(options: {
  chatEngine: ChatEngineId;
  isAnyGenerating: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setInputText: Dispatch<SetStateAction<string>>;
}) {
  const { chatEngine, isAnyGenerating, textareaRef, setInputText } = options;
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [readingAttachments, setReadingAttachments] = useState(false);
  const attachmentReadsRef = useRef(0);
  // 文本框内部的文字拖拽（调整选区）不属于「拖入文件」，靠这个标记排除。
  const internalTextDragRef = useRef(false);

  const processAttachmentFiles = async (files: File[]) => {
    if (files.length === 0) return;
    attachmentReadsRef.current += 1;
    setReadingAttachments(true);
    try {
    const nextAttachments: PendingAttachment[] = [];
    const errors: string[] = [];

    for (const file of files) {
      const kind = classifyAttachment(file);
      if (!kind) {
        errors.push(`${file.name} 不是支持的文本、代码、数据、图片、音频或视频文件。`);
        continue;
      }
      const backendError = attachmentBackendError(kind, chatEngine);
      if (backendError) { errors.push(`${file.name}：${backendError}`); continue; }
      if (kind === 'text') {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          errors.push(`${file.name} 超过文本附件 ${formatFileSize(MAX_ATTACHMENT_BYTES)} 限制。`);
          continue;
        }
        try {
          const content = (await file.text()).split(String.fromCharCode(0)).join('');
          nextAttachments.push({
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            extension: fileExtension(file.name),
            kind: 'text',
            content,
          });
        } catch (error) {
          errors.push(`${file.name} ${String(error instanceof Error ? error.message : error)}`);
        }
        continue;
      }
      if (file.size > MAX_MEDIA_BYTES) {
        errors.push(`${file.name} 超过媒体附件 ${formatFileSize(MAX_MEDIA_BYTES)} 限制。`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        nextAttachments.push({
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          extension: fileExtension(file.name),
          kind,
          mimeType: attachmentMediaMime(file.name, file.type),
          dataUrl,
        });
      } catch (error) {
        errors.push(`${file.name} ${String(error instanceof Error ? error.message : error)}`);
      }
    }

    // 跨多次拖入/选择去重：同一个文件加两次会让 token 用量翻倍。
    setPendingAttachments((current) => {
      const keyOf = (item: PendingAttachment) => `${item.name}\0${item.size}\0${item.kind}`;
      const seen = new Set(current.map(keyOf));
      const unique = nextAttachments.filter((item) => {
        const key = keyOf(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return [...current, ...unique];
    });
    setAttachmentError(errors.length > 0 ? errors.join(' ') : null);
    } finally {
      attachmentReadsRef.current -= 1;
      setReadingAttachments(attachmentReadsRef.current > 0);
    }
  };

  const handleAttachFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (isAnyGenerating) {
      setAttachmentError('请等待当前输出结束后再添加内容。');
      return;
    }
    await processAttachmentFiles(files);
  };

  const handleDragOver = (event: DragEvent) => {
    if (internalTextDragRef.current || !hasTransferContent(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = !isAnyGenerating ? 'copy' : 'none';
    setDraggingFiles(true);
  };

  const handleDragEnter = (event: DragEvent) => {
    if (internalTextDragRef.current || !hasTransferContent(event.dataTransfer) || isAnyGenerating) return;
    event.preventDefault();
    setDraggingFiles(true);
  };

  const handleDragLeave = (event: DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDraggingFiles(false);
    }
  };

  const applyTransfer = async (payload: ReturnType<typeof readAttachmentTransfer>, selection?: { start: number; end: number }) => {
    if (payload.text) {
      setInputText((current) => insertTransferText(current, payload.text, selection).value);
      if (selection) {
        requestAnimationFrame(() => textareaRef.current?.setSelectionRange(selection.start + payload.text.length, selection.start + payload.text.length));
      }
    }
    await processAttachmentFiles(payload.files);
    if (payload.errors.length > 0) {
      setAttachmentError((current) => [current, ...payload.errors].filter(Boolean).join(' '));
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const transfer = event.clipboardData;
    // 普通文字继续使用浏览器原生粘贴，保留选区、撤销和输入法行为。
    const hasFiles = transfer.files.length > 0 || Array.from(transfer.items).some((item) => item.kind === 'file')
      || Array.from(transfer.types).includes('Files');
    const html = transfer.getData('text/html');
    const richOnly = !transfer.getData('text/plain') && Boolean(html);
    if (!hasFiles && !richOnly && !/<img[\s>]/i.test(html)) return;
    event.preventDefault();
    if (isAnyGenerating) {
      setAttachmentError('请等待当前输出结束后再添加内容。');
      return;
    }
    const selection = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
    // DataTransfer 在事件结束后可能失效，必须在 await 之前提取文件和文字。
    const payload = readAttachmentTransfer(transfer);
    void applyTransfer(payload, selection);
  };

  const handleDrop = async (event: DragEvent) => {
    if (internalTextDragRef.current || !hasTransferContent(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDraggingFiles(false);
    if (isAnyGenerating) {
      setAttachmentError('请等待当前输出结束后再添加内容。');
      return;
    }
    const payload = readAttachmentTransfer(event.dataTransfer);
    await applyTransfer(payload);
  };

  const removeAttachment = (id: string) => {
    setPendingAttachments((current) => current.filter((file) => file.id !== id));
    setAttachmentError(null);
  };

  return {
    pendingAttachments,
    setPendingAttachments,
    attachmentError,
    setAttachmentError,
    readingAttachments,
    draggingFiles,
    setDraggingFiles,
    attachmentReadsRef,
    internalTextDragRef,
    handleAttachFiles,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    applyTransfer,
    handlePaste,
    handleDrop,
    removeAttachment,
  };
}
