import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 单文件原子替换：先写临时文件，再 rename 覆盖权威文件；失败时旧文件保持可读。
 * 这不是多文件事务，调用方不得把多个 JSON 的写入宣称成整体原子。
 */
export interface WritableFileSystem {
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  writeFile(file: string, data: string | Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

/** Windows readers can briefly deny replacement. Retry the same rename without deleting the target. */
export async function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => Promise<void> = fsp.rename,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (let retries = 0; ; retries++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        platform !== "win32" ||
        !["EPERM", "EBUSY", "EACCES"].includes(code ?? "") ||
        retries >= 5
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export const nodeFs: WritableFileSystem = {
  mkdir: (dir, options) => fsp.mkdir(dir, options),
  writeFile: (file, data) => fsp.writeFile(file, data),
  rename: (from, to) => renameWithRetry(from, to),
  unlink: (file) => fsp.unlink(file),
};

export class AtomicWriteError extends Error {
  readonly code: "WRITE_FAILED" | "RENAME_FAILED";
  readonly target: string;
  constructor(
    code: "WRITE_FAILED" | "RENAME_FAILED",
    target: string,
    cause: unknown,
  ) {
    super(`原子写入失败（${code}）：${target}`);
    this.name = "AtomicWriteError";
    this.code = code;
    this.target = target;
    this.cause = cause;
  }
}

export interface AtomicWriteOptions {
  fs?: WritableFileSystem;
  /** 测试用临时文件后缀；生产默认 `.tmp-<uuid>`。 */
  tempSuffix?: () => string;
}

export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const fs = options.fs ?? nodeFs;
  const suffix = options.tempSuffix?.() ?? `.tmp-${randomUUID()}`;
  const temp = `${file}${suffix}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temp, data);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw new AtomicWriteError("WRITE_FAILED", file, error);
  }
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw new AtomicWriteError("RENAME_FAILED", file, error);
  }
}

export function isTemporaryFileName(fileName: string): boolean {
  // 原子写入的临时名形如 `<权威文件>.tmp-<uuid>`；加载时一律忽略，
  // 避免崩溃残留被误当作新正文。
  return fileName.includes(".tmp-");
}

/**
 * 按 key 串行化写入。同一工作区／章节的保存、标题修改和后续提交排队执行，
 * 不同 key 互不阻塞；任务失败不会阻塞后续队列。
 */
export class WriteQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.tails.set(key, next);
    void next
      .catch(() => undefined)
      .then(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    return next;
  }

  async idle(key?: string): Promise<void> {
    if (key !== undefined) {
      await (this.tails.get(key) ?? Promise.resolve()).catch(() => undefined);
      return;
    }
    await Promise.allSettled([...this.tails.values()]);
  }
}
