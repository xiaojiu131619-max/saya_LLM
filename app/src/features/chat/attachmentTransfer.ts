import { MAX_ATTACHMENT_BYTES, MAX_MEDIA_BYTES } from './chatUtils';

export interface AttachmentTransfer {
  files: File[];
  text: string;
  errors: string[];
  hasFileItems: boolean;
}

export function hasTransferContent(transfer: DataTransfer): boolean {
  return transfer.files.length > 0 || Array.from(transfer.items ?? []).some((item) => item.kind === 'file')
    || Array.from(transfer.types).some((type) =>
    ['files', 'text/plain', 'text/html', 'text/uri-list'].includes(type.toLowerCase()));
}

function inlineImageFile(source: string, index: number): File {
  const match = source.match(/^data:image\/(png|jpe?g|gif|webp|bmp|tiff?);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) throw new Error('内嵌图片格式无效，请改为粘贴截图或添加原始图片文件。');
  if (match[2].length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) {
    throw new Error('内嵌图片超过媒体附件 80 MiB 限制。');
  }
  const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error('内嵌图片超过媒体附件 80 MiB 限制。');
  const extension = match[1].toLowerCase().replace(/^jpeg$/, 'jpg');
  const mime = extension === 'jpg' ? 'jpeg' : extension === 'tif' ? 'tiff' : extension;
  return new File([bytes], `粘贴或拖入图片-${index}.${extension}`, { type: `image/${mime}` });
}

// template 的内容保持惰性，不能将来源应用的 HTML 插入可见 DOM 或请求其中的资源。
export function transferHtmlContent(html: string): { images: string[]; text: string } {
  const template = document.createElement('template');
  template.innerHTML = html;
  const images = Array.from(template.content.querySelectorAll('img')).map((image) => image.getAttribute('src') ?? '');
  template.content.querySelectorAll('script,style,iframe,object,embed,template').forEach((element) => element.remove());
  template.content.querySelectorAll('br').forEach((element) => element.replaceWith('\n'));
  template.content.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6').forEach((element) => element.append('\n'));
  return { images, text: (template.content.textContent ?? '').trim() };
}

export function readAttachmentTransfer(
  transfer: DataTransfer,
  parseHtml = transferHtmlContent,
): AttachmentTransfer {
  const files = Array.from(transfer.files);
  const items = Array.from(transfer.items ?? []);
  const hasFileItems = files.length > 0 || items.some((item) => item.kind === 'file')
    || Array.from(transfer.types).some((type) => type.toLowerCase() === 'files');
  const seen = new Set(files.map((file) => `${file.name}\0${file.size}\0${file.type}\0${file.lastModified}`));
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    const key = `${file.name}\0${file.size}\0${file.type}\0${file.lastModified}`;
    if (!seen.has(key)) { files.push(file); seen.add(key); }
  }
  const errors: string[] = [];
  let text = files.length > 0 ? '' : transfer.getData('text/plain');
  const html = transfer.getData('text/html');
  const uriList = transfer.getData('text/uri-list').split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'));
  if (html.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + MAX_ATTACHMENT_BYTES) {
    errors.push('来源内容过大，请改为添加原始文件。');
  } else if (html && files.length === 0) {
    const content = parseHtml(html);
    for (const [index, source] of [...new Set(content.images)].entries()) {
      if (source.startsWith('data:')) {
        try { files.push(inlineImageFile(source, index + 1)); }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      } else {
        errors.push('来源应用只提供了图片链接，未取得图片文件；请复制图片本身、粘贴截图，或先保存后添加。');
      }
    }
    if (!text) text = content.text;
  }
  if (!text && files.length === 0 && uriList.length > 0) text = uriList.join('\n');
  if (files.length === 0 && hasFileItems) {
    errors.push('来源应用未提供可读取的文件数据；请先保存到本机，再拖入文件或使用上传按钮。');
  }
  if (new Blob([text]).size > MAX_ATTACHMENT_BYTES) {
    text = '';
    errors.push('拖入或粘贴的文字超过 1 MiB 限制，请改为较小的文本文件。');
  }
  return { files, text, errors: [...new Set(errors)], hasFileItems };
}

export function insertTransferText(value: string, text: string, selection?: { start: number; end: number }) {
  const start = selection?.start ?? value.length;
  const end = selection?.end ?? value.length;
  const prefix = !selection && value && !value.endsWith('\n') ? '\n' : '';
  return { value: value.slice(0, start) + prefix + text + value.slice(end), caret: start + prefix.length + text.length };
}
