import { app, dialog, type BrowserWindow } from "electron";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  type BookFormat,
  type ChapterSummary,
  type WorkspaceInfo,
  toChapterDetail,
  toChapterSummary,
} from "../../shared/book";
import type {
  CreateWorkspaceRequest,
  ImportPreviewResponse,
  PreviewRequest,
  RecentWorkspace,
  SourceSelection,
} from "../../shared/workspace-contracts";
import { isSupportedEncoding, type SupportedEncoding } from "../../shared/encoding";
import {
  buildImportPreview,
  assembleImportChapters,
  ImportError,
  type ImportOptions,
} from "../../core/import/import-pipeline";
import { DecodeError } from "../../core/import/encoding";
import {
  createWorkspace,
  openWorkspaceAt,
  readChapterFile,
  renameChapter,
  saveChapterBody,
  WorkspaceError,
  type Workspace,
  workspacePaths,
} from "../../core/workspace/book-store";
import { writeFileAtomic } from "../../core/workspace/atomic-file";

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const SOURCE_TTL_MS = 30 * 60 * 1000;
const PREVIEW_TTL_MS = 30 * 60 * 1000;

interface PendingSource {
  token: string;
  fileName: string;
  format: BookFormat;
  bytes: Uint8Array;
  createdAt: number;
}

interface PendingPreview {
  token: string;
  sourceToken: string;
  options: ImportOptions;
  requiresChoice: boolean;
  createdAt: number;
}

const RECENT_LIMIT = 8;

export class WorkspaceServiceError extends Error {
  readonly code:
    | "NO_WORKSPACE"
    | "UNSUPPORTED_FORMAT"
    | "SOURCE_TOO_LARGE"
    | "SOURCE_REQUIRED"
    | "PREVIEW_EXPIRED"
    | "ENCODING_REQUIRED"
    | "ENCODING_UNSUPPORTED";
  constructor(code: WorkspaceServiceError["code"], message: string) {
    super(message);
    this.name = "WorkspaceServiceError";
    this.code = code;
  }
}

function formatOf(fileName: string): BookFormat | null {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".txt") return "txt";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  return null;
}

function slugTitle(title: string): string {
  const slug = title
    .replace(/[\\/:*?"<>|\u0000-\u001f\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "book";
}

function bookTitleFromFile(fileName: string): string {
  const base = path.basename(fileName, path.extname(fileName)).trim();
  return base || "未命名作品";
}

/**
 * 工作区应用服务：持有当前作品身份、导入令牌和最近工作区登记。
 * Renderer 只拿到令牌与作品 DTO，底层路径、解码和落盘全部在 main 解析。
 */
export class WorkspaceService {
  private current: Workspace | null = null;
  private startupError: WorkspaceError | null = null;
  private sources = new Map<string, PendingSource>();
  private previews = new Map<string, PendingPreview>();
  private readonly recentFile: string;
  private readonly booksRoot: string;
  private readonly testSource?: string;

  constructor(options?: {
    recentFile?: string;
    booksRoot?: string;
    testSource?: string;
  }) {
    this.recentFile =
      options?.recentFile ??
      path.join(app.getPath("userData"), "recent-workspaces.json");
    this.booksRoot =
      options?.booksRoot ??
      process.env.BOOK_WORKBENCH_ROOT ??
      path.join(app.getPath("documents"), "BookWorkbench");
    this.testSource = options?.testSource ?? process.env.BOOK_WORKBENCH_TEST_SOURCE;
  }

  async initialize(): Promise<void> {
    const entries = await this.readRecent();
    const entry = entries[0];
    this.current = null;
    this.startupError = null;
    if (entry) {
      try {
        this.current = await openWorkspaceAt(entry.root);
        await this.remember(entry.root, this.current.book.bookTitle);
        return;
      } catch (error) {
        this.startupError = new WorkspaceError(
          error instanceof WorkspaceError ? error.code : "WORKSPACE_NOT_FOUND",
          `无法自动打开最近工作区“${entry.title}”，请修复后重新打开或选择其他工作区。`,
          `${entry.root}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  state(): WorkspaceInfo | null {
    if (!this.current && this.startupError) throw this.startupError;
    return this.current ? this.toInfo(this.current) : null;
  }

  /** 供任务／检查点服务读取当前权威章节；调用方不得直接改返回对象。 */
  currentWorkspace(): Workspace | null {
    return this.current;
  }

  private toInfo(workspace: Workspace): WorkspaceInfo {
    return {
      workspaceId: workspace.book.workspaceId,
      root: workspace.root,
      bookTitle: workspace.book.bookTitle,
      format: workspace.book.format,
      chapterOrder: [...workspace.book.chapterOrder],
      chapters: workspace.chapterFiles.map((chapter) =>
        toChapterSummary(chapter, 0, "unchecked"),
      ),
      source: { ...workspace.book.source },
      importSettings: { ...workspace.book.importSettings },
      createdAt: workspace.book.createdAt,
      updatedAt: workspace.book.updatedAt,
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, source] of this.sources)
      if (now - source.createdAt > SOURCE_TTL_MS) this.sources.delete(token);
    for (const [token, preview] of this.previews)
      if (now - preview.createdAt > PREVIEW_TTL_MS) this.previews.delete(token);
  }

  async chooseSource(win: BrowserWindow | null): Promise<SourceSelection | null> {
    let filePath = this.testSource;
    if (!filePath) {
      const options = {
        title: "导入 TXT / Markdown 书籍",
        properties: ["openFile" as const],
        filters: [{ name: "书籍文本", extensions: ["txt", "md", "markdown"] }],
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return null;
      filePath = result.filePaths[0];
    }
    const format = formatOf(filePath);
    if (!format)
      throw new WorkspaceServiceError(
        "UNSUPPORTED_FORMAT",
        "只支持 TXT / Markdown 文件",
      );
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile())
      throw new WorkspaceServiceError("SOURCE_REQUIRED", "无法读取所选文件");
    if (stat.size > MAX_SOURCE_BYTES)
      throw new WorkspaceServiceError(
        "SOURCE_TOO_LARGE",
        "文件超过 50 MB 上限",
      );
    const bytes = new Uint8Array(await fsp.readFile(filePath));
    const token = randomUUID();
    this.prune();
    this.sources.set(token, {
      token,
      fileName: path.basename(filePath),
      format,
      bytes,
      createdAt: Date.now(),
    });
    return {
      token,
      fileName: path.basename(filePath),
      format,
      byteLength: bytes.byteLength,
    };
  }

  async preview(request: PreviewRequest): Promise<ImportPreviewResponse> {
    this.prune();
    const source = this.sources.get(request.token);
    if (!source)
      throw new WorkspaceServiceError(
        "PREVIEW_EXPIRED",
        "导入来源已过期，请重新选择文件",
      );
    if (request.encoding && !isSupportedEncoding(request.encoding))
      throw new WorkspaceServiceError("ENCODING_UNSUPPORTED", "不支持的编码");
    const options: ImportOptions = {
      encoding: (request.encoding as SupportedEncoding | null) ?? null,
      splitMode: request.splitMode,
      paragraphMode: request.paragraphMode,
      headingLevel: request.headingLevel,
    };
    const preview = buildImportPreview(
      { fileName: source.fileName, format: source.format, bytes: source.bytes },
      options,
      request.boundaries,
    );
    const previewToken = randomUUID();
    this.previews.set(previewToken, {
      token: previewToken,
      sourceToken: source.token,
      options,
      requiresChoice: preview.requiresChoice,
      createdAt: Date.now(),
    });
    return { ...preview, previewToken };
  }

  async create(request: CreateWorkspaceRequest): Promise<WorkspaceInfo> {
    this.prune();
    const preview = this.previews.get(request.previewToken);
    if (!preview)
      throw new WorkspaceServiceError(
        "PREVIEW_EXPIRED",
        "导入预览已过期，请重新预览",
      );
    const source = this.sources.get(preview.sourceToken);
    if (!source)
      throw new WorkspaceServiceError(
        "PREVIEW_EXPIRED",
        "导入来源已过期，请重新选择文件",
      );
    if (preview.requiresChoice && preview.options.encoding === null)
      throw new WorkspaceServiceError(
        "ENCODING_REQUIRED",
        "编码存在歧义或替换字符，请先显式选择编码再创建作品",
      );
    const assembled = assembleImportChapters(
      { fileName: source.fileName, format: source.format, bytes: source.bytes },
      preview.options,
      request.boundaries,
      request.titles ?? {},
    );
    const root = path.join(
      this.booksRoot,
      `${slugTitle(request.bookTitle)}-${randomUUID().slice(0, 8)}`,
    );
    const workspace = await createWorkspace({
      root,
      bookTitle: request.bookTitle || bookTitleFromFile(source.fileName),
      format: source.format,
      source: {
        fileName: source.fileName,
        bytes: source.bytes,
        encoding: assembled.preview.encoding,
        eol: assembled.preview.eol,
      },
      importSettings: {
        splitMode: preview.options.splitMode,
        paragraphMode: preview.options.paragraphMode,
        headingLevel: preview.options.headingLevel,
        boundaries: [...request.boundaries],
      },
      chapters: assembled.chapters,
    });
    this.current = workspace;
    this.startupError = null;
    this.sources.delete(source.token);
    for (const [token, pending] of this.previews)
      if (pending.sourceToken === source.token) this.previews.delete(token);
    await this.remember(workspace.root, workspace.book.bookTitle);
    return this.toInfo(workspace);
  }

  async open(win: BrowserWindow | null): Promise<WorkspaceInfo | null> {
    const options = {
      title: "打开作品工作区",
      properties: ["openDirectory" as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const root = result.filePaths[0];
    await fsp.access(workspacePaths(root).book).catch(() => {
      throw new WorkspaceError(
        "WORKSPACE_NOT_FOUND",
        "所选目录不是有效作品工作区",
        "缺少 book.json",
      );
    });
    const workspace = await openWorkspaceAt(root);
    this.current = workspace;
    this.startupError = null;
    this.sources.clear();
    this.previews.clear();
    await this.remember(workspace.root, workspace.book.bookTitle);
    return this.toInfo(workspace);
  }

  close(): null {
    this.current = null;
    this.startupError = null;
    this.sources.clear();
    this.previews.clear();
    return null;
  }

  private requireWorkspace(): Workspace {
    if (!this.current)
      throw new WorkspaceServiceError("NO_WORKSPACE", "尚未打开作品");
    return this.current;
  }

  private assertChapter(workspace: Workspace, chapterId: string): void {
    if (!workspace.book.chapterOrder.includes(chapterId))
      throw new WorkspaceError(
        "CHAPTER_NOT_FOUND",
        "章节不属于当前作品",
        chapterId,
      );
  }

  async getChapter(chapterId: string) {
    const workspace = this.requireWorkspace();
    this.assertChapter(workspace, chapterId);
    const chapter = await readChapterFile(
      workspace.root,
      workspace.book,
      chapterId,
    );
    return toChapterDetail(chapter, 0);
  }

  async saveChapter(input: {
    chapterId: string;
    baseRevision: number;
    body: string;
  }) {
    const workspace = this.requireWorkspace();
    this.assertChapter(workspace, input.chapterId);
    const saved = await saveChapterBody(
      workspace.root,
      input.chapterId,
      input.body,
      input.baseRevision,
    );
    const index = workspace.chapterFiles.findIndex(
      (chapter) => chapter.chapterId === saved.chapterId,
    );
    if (index >= 0) workspace.chapterFiles[index] = saved;
    return toChapterDetail(saved, 0);
  }

  async renameChapter(input: {
    chapterId: string;
    title: string;
  }): Promise<ChapterSummary> {    const workspace = this.requireWorkspace();
    this.assertChapter(workspace, input.chapterId);
    const renamed = await renameChapter(
      workspace.root,
      input.chapterId,
      input.title,
    );
    const index = workspace.chapterFiles.findIndex(
      (chapter) => chapter.chapterId === renamed.chapterId,
    );
    if (index >= 0) workspace.chapterFiles[index] = renamed;
    return toChapterSummary(renamed, 0, "unchecked");
  }

  /** 精校审阅提交后同步内存章节缓存；不重新扫描整个目录。 */
  updateChapterCache(chapter: import("../../shared/book").ChapterFile): void {
    const workspace = this.current;
    if (!workspace) return;
    const index = workspace.chapterFiles.findIndex(
      (item) => item.chapterId === chapter.chapterId,
    );
    if (index >= 0) workspace.chapterFiles[index] = chapter;
  }

  async recent(): Promise<RecentWorkspace[]> {
    return this.readRecent();
  }

  private async readRecent(): Promise<RecentWorkspace[]> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.recentFile, "utf8")) as {
        entries?: RecentWorkspace[];
      };
      if (!Array.isArray(raw.entries)) return [];
      return raw.entries
        .filter(
          (entry): entry is RecentWorkspace =>
            typeof entry?.root === "string" &&
            typeof entry?.title === "string" &&
            typeof entry?.openedAt === "string",
        )
        .slice(0, RECENT_LIMIT);
    } catch {
      return [];
    }
  }

  private async writeRecent(entries: RecentWorkspace[]): Promise<void> {
    await fsp.mkdir(path.dirname(this.recentFile), { recursive: true });
    await writeFileAtomic(
      this.recentFile,
      JSON.stringify({ schemaVersion: 1, entries }, null, 2),
    );
  }

  private async remember(root: string, title: string): Promise<void> {
    const entries = (await this.readRecent()).filter((entry) => entry.root !== root);
    entries.unshift({ root, title, openedAt: new Date().toISOString() });
    await this.writeRecent(entries.slice(0, RECENT_LIMIT)).catch(() => undefined);
  }
}

export function isKnownImportError(
  error: unknown,
): error is WorkspaceError | ImportError | DecodeError | WorkspaceServiceError {
  return (
    error instanceof WorkspaceError ||
    error instanceof ImportError ||
    error instanceof DecodeError ||
    error instanceof WorkspaceServiceError
  );
}
