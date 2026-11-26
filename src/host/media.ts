/**
 * 媒体类型 → 文件后缀。
 *
 * 入站（下载图片时给临时名）与出站（核心只给 base64 与 mediaType 时补文件名）都要用，
 * 放在一处，改一处两边同时生效。
 */

/** 插件认得的四种图片类型；未知类型按 png 兜底（平台只接受这四种）。 */
export function extensionOf(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'png';
  }
}
