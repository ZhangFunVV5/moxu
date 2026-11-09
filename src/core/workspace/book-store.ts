import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  SCHEMA_VERSION,
  bookFileSchema,
  chapterFileSchema,
  type BookFile,
  type BookFormat,
  type ChapterFile,
  type ChapterKind,
  type ImportSettings,
} from "../../shared/book";
import { normalizeNewlines } from "../../shared/text-offsets";
import { hashBody, sha256Hex } from "../text/hash";
import {
  blockStructureProblems,
  deriveBlocks,
} from "../text/structure";
import {
  WriteQueue,
  writeFileAtomic,
  isTemporaryFileName,
  type AtomicWriteOptions,
} from "./atomic-file";

export const WORKSPACE_SUBDIRS = [
  "source",
  "chapters",
  "edits",
  "generated",
  "tasks",
  "presets",
  "output",
] as const;

export type WorkspaceErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_EXISTS"
  | "INVALID_BOOK"
  | "INVALID_CHAPTER"
  | "CHAPTER_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "INVALID_BODY"
  | "INVALID_TITLE"
  | "WRITE_FAILED";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly detail: string;
  readonly data?: Record<string, unknown>;
  constructor(
    code: WorkspaceErrorCode,
    message: string,
    detail = "",
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.detail = detail;
    this.data = data;
  }
}

export interface Workspace {
  root: string;
  book: BookFile;
  chapterFiles: ChapterFile[];
}

export function workspacePaths(root: string) {
  return {
    root,
    book: path.join(root, "book.json"),
    chapters: path.join(root, "chapters"),
    source: path.join(root, "source"),
    edits: path.join(root, "edits"),
    generated: path.join(root, "generated"),
    tasks: path.join(root, "tasks"),
    presets: path.join(root, "presets"),
    output: path.join(root, "output"),
    chapter: (chapterId: string) => path.join(root, "chapters", `${chapterId}.json`),
  };
}

const writeQueue = new WriteQueue();

/**
 * 单章写队列：正文保存、重命名和精校审阅提交共用同一把锁，
 * 防止编辑保存与采纳／撤回互相覆盖。
 */
export function withChapterWriteLock<T>(
  root: string,
  chapterId: string,
  action: () => Promise<T>,
): Promise<T> {
  return writeQueue.run(`${root}:${chapterId}`, action);
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("；");
}

async function readJson(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new WorkspaceError(
        "WORKSPACE_NOT_FOUND",
        "工作区文件不存在",
        `${file} 不存在`,
      );
    throw new WorkspaceError("INVALID_BOOK", "工作区文件无法读取", file);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new WorkspaceError("INVALID_BOOK", "工作区 JSON 无法解析", file);
  }
}

export async function readBookFile(root: string): Promise<BookFile> {
  const parsed = bookFileSchema.safeParse(await readJson(workspacePaths(root).book));
  if (!parsed.success)
    throw new WorkspaceError(
      "INVALID_BOOK",
      "book.json 结构非法，已拒绝打开而不是显示空作品",
      zodMessage(parsed.error),
    );
  return parsed.data;
}

/** 单章完整性校验：hash、块范围、块顺序都来自同一个正文版本。 */
export function chapterIntegrityProblems(chapter: ChapterFile): string[] {
  const problems: string[] = [];
  if (hashBody(chapter.body) !== chapter.bodyHash)
    problems.push("正文 hash 与 body 不一致");
  problems.push(...blockStructureProblems(chapter.body, chapter.blocks));
  if (chapter.body.trim().length > 0 && chapter.blocks.length === 0)
    problems.push("正文非空但没有段落");
  if (chapter.title.current.trim().length === 0) problems.push("标题为空");
  if (chapter.review) {
    const derived = Object.entries(chapter.review.decisions)
      .filter(([, decision]) => decision === "accepted")
      .map(([patchId]) => patchId)
      .sort();
    const stored = [...chapter.review.acceptedPatchIds].sort();
    if (
      derived.length !== stored.length ||
      derived.some((patchId, index) => patchId !== stored[index])
    )
      problems.push("审阅已采纳集合与决议不一致");
    if (new Set(stored).size !== stored.length)
      problems.push("审阅已采纳集合包含重复 ID");
  }
  return problems;
}

export function validateChapterFile(
  raw: unknown,
  file: string,
  expected?: { workspaceId?: string; chapterId?: string },
): ChapterFile {
  const parsed = chapterFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new WorkspaceError(
      "INVALID_CHAPTER",
      "章节文件结构非法",
      `${file}：${zodMessage(parsed.error)}`,
    );
  const chapter = parsed.data;
  if (expected?.workspaceId && chapter.workspaceId !== expected.workspaceId)
    throw new WorkspaceError(
      "INVALID_CHAPTER",
      "章节不属于当前作品",
      `${file} 的 workspaceId 不匹配`,
    );
  if (expected?.chapterId && chapter.chapterId !== expected.chapterId)
    throw new WorkspaceError(
      "INVALID_CHAPTER",
      "章节 ID 与文件名不一致",
      file,
    );
  const problems = chapterIntegrityProblems(chapter);
  if (problems.length)
    throw new WorkspaceError(
      "INVALID_CHAPTER",
      "章节正文校验失败",
      `${file}：${problems.join("；")}`,
    );
  return chapter;
}

export async function readChapterFile(
  root: string,
  book: BookFile,
  chapterId: string,
): Promise<ChapterFile> {
  const file = workspacePaths(root).chapter(chapterId);
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "WORKSPACE_NOT_FOUND")
      throw new WorkspaceError(
        "CHAPTER_NOT_FOUND",
        "章节文件不存在",
        `${chapterId} 缺少权威文件`,
      );
    if (error instanceof WorkspaceError && error.code === "INVALID_BOOK")
      throw new WorkspaceError(
        "INVALID_CHAPTER",
        "章节 JSON 无法解析",
        error.detail,
      );
    throw error;
  }
  const chapter = validateChapterFile(raw, file, {
    workspaceId: book.workspaceId,
    chapterId,
  });
  const expectedBlocks = deriveBlocks(
    book.format,
    chapter.body,
    book.importSettings.paragraphMode,
  );
  if (JSON.stringify(expectedBlocks) !== JSON.stringify(chapter.blocks))
    throw new WorkspaceError(
      "INVALID_CHAPTER",
      "章节段落结构与正文不一致",
      file,
    );
  return chapter;
}

/**
 * 打开工作区并做交叉校验：章序、文件集合、章节身份、正文 hash 与块结构。
 * 任何不一致都给出明确错误，不返回“空作品”。
 */
export async function openWorkspaceAt(root: string): Promise<Workspace> {
  const book = await readBookFile(root);
  if (new Set(book.chapterOrder).size !== book.chapterOrder.length)
    throw new WorkspaceError("INVALID_BOOK", "book.json 章序包含重复 ID");

  let entries: string[];
  try {
    entries = await fsp.readdir(workspacePaths(root).chapters);
  } catch {
    throw new WorkspaceError("INVALID_BOOK", "缺少 chapters 目录", root);
  }
  const files = entries
    .filter((name) => name.endsWith(".json") && !isTemporaryFileName(name))
    .map((name) => name.slice(0, -5))
    .sort();
  const ordered = [...book.chapterOrder].sort();
  if (
    files.length !== ordered.length ||
    files.some((id, index) => id !== ordered[index])
  ) {
    throw new WorkspaceError(
      "INVALID_BOOK",
      "章节文件与 book.json 章序不一致",
      `章序 ${ordered.join(",")}；文件 ${files.join(",")}`,
    );
  }

  const chapterFiles: ChapterFile[] = [];
  for (const [index, chapterId] of book.chapterOrder.entries()) {
    const chapter = await readChapterFile(root, book, chapterId);
    if (chapter.order !== index)
      throw new WorkspaceError(
        "INVALID_CHAPTER",
        "章节 order 与章序不一致",
        `${chapterId}：期望 ${index}，实际 ${chapter.order}`,
      );
    chapterFiles.push(chapter);
  }
  return { root, book, chapterFiles };
}

export async function writeChapterFile(
  root: string,
  chapter: ChapterFile,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(
    workspacePaths(root).chapter(chapter.chapterId),
    JSON.stringify(chapter, null, 2),
    options,
  );
}

export interface CreateWorkspaceChapterInput {
  title: string;
  sourceTitle?: string;
  kind: ChapterKind;
  body: string;
}

export interface CreateWorkspaceInput {
  root: string;
  bookTitle: string;
  format: BookFormat;
  source: {
    fileName: string;
    bytes: Uint8Array;
    encoding: string;
    eol: "lf" | "crlf";
  };
  importSettings: ImportSettings;
  chapters: CreateWorkspaceChapterInput[];
  now?: () => Date;
  fs?: AtomicWriteOptions["fs"];
}

function safeSourceName(fileName: string, format: BookFormat): string {
  const base = path
    .basename(fileName)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "");
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (!base || base === "." || base === ".." || reserved.test(base))
    return format === "markdown" ? "original.md" : "original.txt";
  return base.slice(0, 120);
}

/**
 * 创建完整工作区：在目标旁的临时目录写完 source / chapters / book.json 后再整体改名。
 * 任一步失败都清理临时目录，不留下可被打开的“半成品作品”。
 */
export async function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  const root = path.resolve(input.root);
  if (input.chapters.length === 0)
    throw new WorkspaceError("INVALID_BOOK", "导入结果没有章节");
  const bookTitle = input.bookTitle.trim();
  if (!bookTitle)
    throw new WorkspaceError("INVALID_BOOK", "作品标题不能为空");
  const boundaries = input.importSettings.boundaries;
  if (
    boundaries.length === 0 ||
    boundaries[0] !== 0 ||
    boundaries.some(
      (value, index) =>
        !Number.isInteger(value) ||
        value < 0 ||
        (index > 0 && value <= boundaries[index - 1]),
    ) ||
    boundaries.length !== input.chapters.length
  )
    throw new WorkspaceError("INVALID_BOOK", "导入分章边界非法");
  for (const [index, chapter] of input.chapters.entries()) {
    if (!chapter.title.trim())
      throw new WorkspaceError(
        "INVALID_CHAPTER",
        `第 ${index + 1} 章标题为空`,
      );
    const blocks = deriveBlocks(
      input.format,
      chapter.body,
      input.importSettings.paragraphMode,
    );
    const problems = blockStructureProblems(chapter.body, blocks);
    if (problems.length)
      throw new WorkspaceError(
        "INVALID_BODY",
        `第 ${index + 1} 章正文结构非法`,
        problems.join("；"),
      );
  }

  const existed = await fsp
    .stat(root)
    .then(() => true)
    .catch(() => false);
  if (existed)
    throw new WorkspaceError("WORKSPACE_EXISTS", "目标工作区已存在", root);

  const parent = path.dirname(root);
  await fsp.mkdir(parent, { recursive: true });
  const tempRoot = `${root}.tmp-create-${randomUUID()}`;
  const now = input.now?.() ?? new Date();
  const iso = now.toISOString();
  const workspaceId = randomUUID();
  const chapterIds = input.chapters.map(
    (_chapter, index) => `ch-${randomUUID().slice(0, 8)}${index}`,
  );

  try {
    for (const name of WORKSPACE_SUBDIRS)
      await fsp.mkdir(path.join(tempRoot, name), { recursive: true });

    const sourceName = safeSourceName(
      input.source.fileName,
      input.format,
    );
    const copy = `source/${sourceName}`;
    await writeFileAtomic(
      path.join(tempRoot, copy),
      Buffer.from(input.source.bytes),
      input.fs ? { fs: input.fs } : {},
    );
    const sourceHash = sha256Hex(input.source.bytes);
    const copiedBytes = await fsp.readFile(path.join(tempRoot, copy));
    if (sha256Hex(copiedBytes) !== sourceHash)
      throw new WorkspaceError("INVALID_BOOK", "来源副本 hash 不一致");

    const chapterChapterFiles: ChapterFile[] = [];
    for (const [index, chapter] of input.chapters.entries()) {
      const body = chapter.body;
      const chapterFile: ChapterFile = {
        schemaVersion: SCHEMA_VERSION,
        workspaceId,
        chapterId: chapterIds[index],
        order: index,
        kind: chapter.kind,
        title: {
          current: chapter.title.trim(),
          source: chapter.sourceTitle?.trim() || chapter.title.trim(),
        },
        body,
        blocks: deriveBlocks(
          input.format,
          body,
          input.importSettings.paragraphMode,
        ),
        bodyRevision: 1,
        bodyHash: hashBody(body),
        titleRevision: 1,
        createdAt: iso,
        updatedAt: iso,
      };
      const problems = chapterIntegrityProblems(chapterFile);
      if (problems.length)
        throw new WorkspaceError(
          "INVALID_CHAPTER",
          `第 ${index + 1} 章无法写入`,
          problems.join("；"),
        );
      chapterChapterFiles.push(chapterFile);
      await writeFileAtomic(
        path.join(tempRoot, "chapters", `${chapterFile.chapterId}.json`),
        JSON.stringify(chapterFile, null, 2),
        input.fs ? { fs: input.fs } : {},
      );
    }

    const book: BookFile = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId,
      bookTitle,
      format: input.format,
      chapterOrder: chapterChapterFiles.map((chapter) => chapter.chapterId),
      source: {
        fileName: input.source.fileName,
        byteLength: input.source.bytes.byteLength,
        sha256: sourceHash,
        encoding: input.source.encoding,
        eol: input.source.eol,
        copy,
      },
      importSettings: input.importSettings,
      createdAt: iso,
      updatedAt: iso,
    };
    await writeFileAtomic(
      path.join(tempRoot, "book.json"),
      JSON.stringify(book, null, 2),
      input.fs ? { fs: input.fs } : {},
    );
    await fsp.rename(tempRoot, root);
  } catch (error) {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(
      "WRITE_FAILED",
      "作品创建失败，未留下半成品工作区",
      error instanceof Error ? error.message : String(error),
    );
  }
  return openWorkspaceAt(root);
}

/**
 * 保存正文：在写队列内重新读取权威版本，校验 baseRevision 后生成完整新章对象，
 * 临时文件写完再原子替换。失败时旧章节仍可读。
 */
export async function saveChapterBody(
  root: string,
  chapterId: string,
  bodyInput: string,
  baseRevision: number,
): Promise<ChapterFile> {
  return withChapterWriteLock(root, chapterId, async () => {
    const book = await readBookFile(root);
    const current = await readChapterFile(root, book, chapterId);
    if (current.bodyRevision !== baseRevision)
      throw new WorkspaceError(
        "VERSION_CONFLICT",
        "正文已在别处被修改，不能覆盖新版本",
        `期望修订 ${baseRevision}，当前 ${current.bodyRevision}`,
        { currentRevision: current.bodyRevision, currentHash: current.bodyHash },
      );
    const normalized = normalizeNewlines(bodyInput).text;
    if (normalized.length > 4_000_000)
      throw new WorkspaceError("INVALID_BODY", "单章正文超过长度上限");
    if (normalized === current.body) return current;
    if (hashBody(normalized) === current.bodyHash) return current;
    const blocks = deriveBlocks(book.format, normalized, book.importSettings.paragraphMode);
    const problems = blockStructureProblems(normalized, blocks);
    if (problems.length)
      throw new WorkspaceError(
        "INVALID_BODY",
        "正文结构非法，未保存",
        problems.join("；"),
      );
    const next: ChapterFile = {
      ...current,
      body: normalized,
      blocks,
      bodyRevision: current.bodyRevision + 1,
      bodyHash: hashBody(normalized),
      updatedAt: new Date().toISOString(),
    };
    const finalProblems = chapterIntegrityProblems(next);
    if (finalProblems.length)
      throw new WorkspaceError(
        "INVALID_BODY",
        "正文校验失败，未保存",
        finalProblems.join("；"),
      );
    await writeChapterFile(root, next);
    return next;
  });
}

/** 标题是独立元数据：只推进 titleRevision，bodyHash / bodyRevision 不变。 */
export async function renameChapter(
  root: string,
  chapterId: string,
  title: string,
): Promise<ChapterFile> {
  return withChapterWriteLock(root, chapterId, async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f]/.test(trimmed))
      throw new WorkspaceError("INVALID_TITLE", "标题为空或包含非法字符");
    const book = await readBookFile(root);
    const current = await readChapterFile(root, book, chapterId);
    if (current.title.current === trimmed) return current;
    const next: ChapterFile = {
      ...current,
      title: { ...current.title, current: trimmed },
      titleRevision: current.titleRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeChapterFile(root, next);
    return next;
  });
}
