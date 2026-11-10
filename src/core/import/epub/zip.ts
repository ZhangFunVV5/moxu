import { unzipSync } from "fflate";
import { EpubError } from "./epub-error";

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
}

/**
 * 解析限制：EPUB 是外部容器，先按条目数与解压总量设上限，避免压缩炸弹耗尽内存。
 * 上限只针对导入解析，不改变 50 MB 的来源文件上限。
 */
export const EPUB_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxTotalBytes: 120 * 1024 * 1024,
  maxEntryBytes: 40 * 1024 * 1024,
};

/** ZIP 条目名必须是容器内相对 POSIX 路径；不接受绝对路径、盘符、反斜杠或 ..。 */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > 512) return false;
  if (name.includes("\\") || name.includes("\u0000")) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  const segments = name.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      segment !== "__proto__" &&
      segment !== "prototype" &&
      segment !== "constructor" &&
      !/[<>:"|?*]/.test(segment),
  );
}

export interface ZipEntries {
  /** 以原始条目名索引；查找时另用 normalizeEntryName。 */
  files: Map<string, Uint8Array>;
  /** NFC 规范化后的名称索引，兼容不同平台写出的 ZIP。 */
  byNormalized: Map<string, Uint8Array>;
  names: string[];
}

/**
 * 读取 EPUB 的 ZIP 容器。只允许 stored / deflate；重复条目名与不安全路径直接拒绝，
 * 避免同一路径出现两份内容时静默选择其中一份。
 */
export function readZipEntries(
  bytes: Uint8Array,
  limits: ZipLimits = EPUB_ZIP_LIMITS,
): ZipEntries {
  let entries = 0;
  let totalBytes = 0;
  const seen = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        entries += 1;
        if (entries > limits.maxEntries)
          throw new EpubError(
            "TOO_MANY_ENTRIES",
            `EPUB 条目超过 ${limits.maxEntries} 个上限，已拒绝解析`,
          );
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0)
          throw new EpubError("INVALID_ZIP", "EPUB 条目大小无效");
        if (file.originalSize > limits.maxEntryBytes)
          throw new EpubError(
            "ZIP_ENTRY_TOO_LARGE",
            "EPUB 中存在超过单条目大小上限的文件",
            file.name,
          );
        totalBytes += file.originalSize;
        if (totalBytes > limits.maxTotalBytes)
          throw new EpubError(
            "ZIP_TOO_LARGE",
            "EPUB 解压总量超过上限，已拒绝解析",
          );
        if (file.compression !== 0 && file.compression !== 8)
          throw new EpubError(
            "UNSUPPORTED_COMPRESSION",
            "EPUB 使用了不支持的 ZIP 压缩方式",
            file.name,
          );
        const isDirectory = file.name.endsWith("/");
        if (!isDirectory && !isSafeEntryName(file.name))
          throw new EpubError(
            "UNSAFE_PATH",
            "EPUB 包含不安全的容器内路径，已拒绝解析",
            file.name,
          );
        if (!isDirectory) {
          if (seen.has(file.name))
            throw new EpubError(
              "INVALID_ZIP",
              "EPUB 包含重复条目，无法确定权威内容",
              file.name,
            );
          seen.add(file.name);
        }
        return !isDirectory;
      },
    });
  } catch (error) {
    if (error instanceof EpubError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt/i.test(message))
      throw new EpubError("DRM_PROTECTED", "EPUB 使用加密压缩，暂不支持", message);
    throw new EpubError(
      "INVALID_ZIP",
      "EPUB 文件损坏或不是有效的 ZIP 容器",
      message,
    );
  }
  const map = new Map<string, Uint8Array>();
  const byNormalized = new Map<string, Uint8Array>();
  const names: string[] = [];
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    map.set(name, data);
    byNormalized.set(name.normalize("NFC"), data);
    names.push(name);
  }
  return { files: map, byNormalized, names };
}

/** 先精确匹配，再用 NFC 匹配；找不到返回 null。 */
export function findZipEntry(
  zip: ZipEntries,
  path: string,
): Uint8Array | null {
  return zip.files.get(path) ?? zip.byNormalized.get(path.normalize("NFC")) ?? null;
}
