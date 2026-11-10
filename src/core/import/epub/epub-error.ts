/**
 * EPUB 解析错误：所有失败都带稳定 code，供 IPC 转成用户可读反馈。
 * 解析失败不得创建任何工作区文件。
 */
export type EpubErrorCode =
  | "INVALID_ZIP"
  | "TOO_MANY_ENTRIES"
  | "ZIP_ENTRY_TOO_LARGE"
  | "ZIP_TOO_LARGE"
  | "UNSUPPORTED_COMPRESSION"
  | "UNSAFE_PATH"
  | "MISSING_CONTAINER"
  | "INVALID_CONTAINER"
  | "MISSING_OPF"
  | "INVALID_OPF"
  | "INVALID_XML"
  | "XML_TOO_LARGE"
  | "UNSUPPORTED_ENCODING"
  | "MISSING_SPINE"
  | "MISSING_SPINE_RESOURCE"
  | "DRM_PROTECTED"
  | "FIXED_LAYOUT"
  | "TOO_MANY_CHAPTERS"
  | "INVALID_BOUNDARIES"
  | "NO_TEXT_CONTENT";

export class EpubError extends Error {
  readonly code: EpubErrorCode;
  readonly detail: string;
  constructor(code: EpubErrorCode, message: string, detail = "") {
    super(message);
    this.name = "EpubError";
    this.code = code;
    this.detail = detail;
  }
}
