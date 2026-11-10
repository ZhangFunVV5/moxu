import { EpubError } from "./epub-error";

export interface ResolvedHref {
  /** 容器内 POSIX 路径，不含前导斜杠。 */
  path: string;
  /** 解码后的文档锚点；无锚点为 null。 */
  fragment: string | null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function dirName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * 解析 OPF / nav / NCX 中的相对链接：
 * - 空路径指向当前文档；
 * - 支持 ../ 与 ./，但越过容器根即拒绝；
 * - 逐段解码百分号编码，避免 %2F 被误当目录分隔符；
 * - 反斜杠与非 POSIX 绝对路径拒绝，防止容器内路径歧义。
 */
export function resolveHref(currentPath: string, href: string): ResolvedHref {
  const raw = href.trim();
  if (raw.includes("\\"))
    throw new EpubError("UNSAFE_PATH", "EPUB 链接包含反斜杠路径", raw);
  const hashIndex = raw.indexOf("#");
  const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const fragment =
    hashIndex >= 0 ? decodeSegment(raw.slice(hashIndex + 1)) || null : null;
  const queryIndex = beforeHash.indexOf("?");
  const pathPart = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  if (!pathPart) return { path: currentPath, fragment };
  if (pathPart.startsWith("/"))
    throw new EpubError("UNSAFE_PATH", "EPUB 链接不得使用容器绝对路径", raw);
  const base = dirName(currentPath);
  const segments = (pathPart.startsWith("./") ? pathPart.slice(2) : pathPart).split("/");
  const stack: string[] = base ? base.split("/") : [];
  for (const segment of segments) {
    const decoded = decodeSegment(segment);
    if (!decoded || decoded === ".") continue;
    if (decoded === "..") {
      if (stack.length === 0)
        throw new EpubError(
          "UNSAFE_PATH",
          "EPUB 链接指向容器外路径",
          raw,
        );
      stack.pop();
      continue;
    }
    if (decoded.includes("/") || decoded.includes("\\") || decoded === "..")
      throw new EpubError("UNSAFE_PATH", "EPUB 链接路径非法", raw);
    stack.push(decoded);
  }
  if (stack.length === 0)
    throw new EpubError("UNSAFE_PATH", "EPUB 链接缺少目标路径", raw);
  return { path: stack.join("/"), fragment };
}

/** 解压后的原始条目名可能就是编码形式；查找时同时尝试解码后的原样路径。 */
export function rawHrefPath(currentPath: string, href: string): string | null {
  const hashIndex = href.indexOf("#");
  const withoutFragment = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const queryIndex = withoutFragment.indexOf("?");
  const pathPart =
    queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment;
  if (!pathPart) return null;
  if (pathPart.startsWith("/")) return null;
  const base = dirName(currentPath);
  const combined = pathPart.startsWith("./")
    ? pathPart.slice(2)
    : pathPart;
  const joined = base ? `${base}/${combined}` : combined;
  const parts: string[] = [];
  for (const segment of joined.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length ? parts.join("/") : null;
}
