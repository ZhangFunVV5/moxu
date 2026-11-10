import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dialog, type BrowserWindow } from "electron";
import type { WorkspaceService } from "./workspace-service";
import { readChapterFile } from "../../core/workspace/book-store";
import { writeFileAtomic } from "../../core/workspace/atomic-file";
import { sha256Hex } from "../../core/text/hash";
import { formatBook, encodeFormatted } from "../../core/format/format-book";
import { buildEpub } from "../../core/format/epub/export";
import {
  canonicalExportPath,
  isProtectedWorkspacePath,
} from "../../core/format/export-path";
import {
  defaultFormatOptions,
  formatOptionsSchema,
  type FormatOptions,
} from "../../shared/format-options";
import type {
  EpubPreview,
  FormatPreview,
  FormatPreviewRequest,
} from "../../shared/format-contracts";
import type { BookMetadata, ExportFormat } from "../../shared/book";
import { bodyFormatOf, bookMetadataOf } from "../../shared/book";
import {
  dispatch,
  formatRulesProfile,
  type Context,
  type Profile,
} from "../../agent/tools/dispatcher";
import { run } from "../../agent/runtime/loop";
import type { Adapter } from "../../agent/model/model-adapter";

type Frozen = {
  root: string;
  workspaceId: string;
  preview: FormatPreview;
  versions: Record<string, string>;
  /** EPUB 预览冻结的完整字节；导出写这一份，不重新构建。 */
  epubBytes?: Uint8Array;
};

export class FormatServiceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const guiProfile: Profile = {
  ...formatRulesProfile,
  tools: ["preview_format", "export_book", "save_format_preset"],
};

const OUTPUT_EXTENSIONS: Record<ExportFormat, string> = {
  txt: "txt",
  markdown: "md",
  epub: "epub",
};

const OUTPUT_LABELS: Record<ExportFormat, string> = {
  txt: "TXT 文本",
  markdown: "Markdown",
  epub: "EPUB 3 书籍",
};

function frozenBytesFor(outputFormat: ExportFormat, f: Frozen): Uint8Array {
  if (outputFormat === "epub") {
    if (!f.epubBytes)
      throw new FormatServiceError("STALE_PREVIEW", "EPUB 预览内容缺失，请刷新");
    return f.epubBytes;
  }
  return encodeFormatted(f.preview.text, f.preview.options);
}

export class FormatService {
  private previews = new Map<string, Frozen>();
  constructor(
    private workspace: WorkspaceService,
    private adapter: () => Promise<Adapter>,
  ) {}
  private current() {
    const w = this.workspace.currentWorkspace();
    if (!w) throw new Error("尚未打开作品");
    return w;
  }
  async getPreset() {
    const w = this.current();
    try {
      return formatOptionsSchema.parse(
        JSON.parse(await readFile(path.join(w.root, "presets", "format.json"), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return {
          ...defaultFormatOptions,
          paragraphMode: w.book.importSettings.paragraphMode,
        };
      throw e;
    }
  }
  async savePreset(options: FormatOptions) {
    const w = this.current();
    const value = formatOptionsSchema.parse(options);
    const result = await dispatch(
      "save_format_preset",
      { options: value },
      {
        workspaceId: w.book.workspaceId,
        chapterIds: [],
        source: "gui",
        allowWrite: true,
        version: 1,
        format: {
          validate: async () =>
            this.workspace.currentWorkspace()?.book.workspaceId ===
            w.book.workspaceId,
          execute: async () => {
            await writeFileAtomic(
              path.join(w.root, "presets", "format.json"),
              JSON.stringify(value, null, 2),
            );
            return value;
          },
        },
      },
      guiProfile,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.data as FormatOptions;
  }
  private version(c: {
    bodyHash: string;
    bodyRevision: number;
    titleRevision: number;
    title: { current: string };
  }) {
    return sha256Hex(
      JSON.stringify([
        c.bodyHash,
        c.bodyRevision,
        c.titleRevision,
        c.title.current,
      ]),
    );
  }
  async preview(request: FormatPreviewRequest) {
    const w = this.current();
    const ids = w.book.chapterOrder.filter((id) =>
      request.chapterIds.includes(id),
    );
    if (ids.length !== request.chapterIds.length)
      throw new Error("章节范围无效或重复");
    const chapters = await Promise.all(
      ids.map((id) => readChapterFile(w.root, w.book, id)),
    );
    const versions = Object.fromEntries(
      chapters.map((c) => [c.chapterId, this.version(c)]),
    );
    const bodyFormat = bodyFormatOf(w.book);
    const metadata: BookMetadata = request.metadata
      ? { ...request.metadata }
      : bookMetadataOf(w.book);
    const fingerprint = sha256Hex(
      JSON.stringify({
        workspaceId: w.book.workspaceId,
        chapterIds: ids,
        versions,
        bodyFormat,
        outputFormat: request.outputFormat,
        options: request.options,
        metadata,
      }),
    );
    const preview: FormatPreview = {
      ...request,
      chapterIds: ids,
      options: structuredClone(request.options),
      metadata,
      token: randomUUID(),
      inputFingerprint: fingerprint,
      text: "",
    };
    let epubBytes: Uint8Array | undefined;
    if (request.outputFormat === "epub") {
      const built = buildEpub({
        chapters,
        bodyFormat,
        options: request.options,
        metadata,
        identifier: `urn:uuid:${w.book.workspaceId}`,
        modifiedAt: new Date(),
      });
      epubBytes = built.bytes;
      const epub: EpubPreview = {
        html: built.previewHtml,
        chapters: built.chapters,
        byteLength: built.bytes.byteLength,
        warnings: built.warnings,
      };
      preview.epub = epub;
    } else {
      preview.text = formatBook(
        chapters,
        bodyFormat,
        request.outputFormat,
        request.options,
      );
    }
    const frozen: Frozen = {
      root: w.root,
      workspaceId: w.book.workspaceId,
      versions,
      preview,
      ...(epubBytes ? { epubBytes } : {}),
    };
    const result = await dispatch(
      "preview_format",
      {},
      this.context(frozen, async () => frozen.preview),
      guiProfile,
    );
    if (!result.ok) throw new Error(result.error.message);
    this.previews.set(frozen.preview.token, frozen);
    if (this.previews.size > 20)
      this.previews.delete(this.previews.keys().next().value!);
    return frozen.preview;
  }
  private frozen(token: string) {
    const f = this.previews.get(token);
    if (!f) throw new Error("预览已失效，请刷新");
    return f;
  }
  async status(token: string) {
    const f = this.frozen(token);
    return { stale: !(await this.valid(f)) };
  }
  private async valid(f: Frozen) {
    const w = this.workspace.currentWorkspace();
    if (!w || w.root !== f.root || w.book.workspaceId !== f.workspaceId)
      return false;
    for (const id of f.preview.chapterIds) {
      const c = await readChapterFile(w.root, w.book, id);
      if (this.version(c) !== f.versions[id]) return false;
    }
    return true;
  }
  private context(
    f: Frozen,
    execute: (name: string, args: unknown) => Promise<unknown>,
  ): Context {
    return {
      workspaceId: f.workspaceId,
      chapterIds: f.preview.chapterIds,
      source: "gui",
      allowWrite: true,
      version: 1,
      format: { validate: () => this.valid(f), execute },
    };
  }
  async export(token: string, parent: BrowserWindow | null) {
    const f = this.frozen(token);
    if (!(await this.valid(f)))
      throw new FormatServiceError("STALE_PREVIEW", "预览已过期，请刷新");
    const outputFormat = f.preview.outputFormat;
    const extension = OUTPUT_EXTENSIONS[outputFormat];
    const options = {
      title: "导出排版结果",
      defaultPath: `${f.preview.metadata?.title ?? this.current().book.bookTitle}.${extension}`,
      filters: [{ name: OUTPUT_LABELS[outputFormat], extensions: [extension] }],
    };
    const chosen = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    const target = path.resolve(chosen.filePath);
    const w = this.current();
    const canonical = await canonicalExportPath(target);
    const root = await realpath(w.root);
    const existing = await readFile(target).catch(() => null);
    if (existing && sha256Hex(existing) === w.book.source.sha256)
      throw new Error("不能覆盖原输入文件，请另存");
    if (isProtectedWorkspacePath(root, canonical))
      throw new Error("不能覆盖工作区源文件、正文或配置");
    const result = await dispatch(
      "export_book",
      {},
      this.context(f, async () => {
        await writeFileAtomic(target, frozenBytesFor(outputFormat, f));
        return { cancelled: false, path: target };
      }),
      guiProfile,
    );
    if (!result.ok)
      throw new FormatServiceError(
        result.error.code === "VERSION_MISMATCH"
          ? "STALE_PREVIEW"
          : result.error.code,
        result.error.message,
      );
    return result.data as { cancelled: boolean; path?: string };
  }
  async propose(request: {
    chapterIds: string[];
    prompt: string;
    options: FormatOptions;
  }) {
    const w = this.current();
    if (
      new Set(request.chapterIds).size !== request.chapterIds.length ||
      request.chapterIds.some((id) => !w.book.chapterOrder.includes(id))
    )
      throw new Error("章节范围无效");
    let candidate: FormatOptions | undefined;
    const context: Context = {
      workspaceId: w.book.workspaceId,
      chapterIds: request.chapterIds,
      source: "agent",
      allowWrite: false,
      version: 1,
      format: {
        validate: async () =>
          this.workspace.currentWorkspace()?.book.workspaceId ===
          w.book.workspaceId,
        execute: async (_name, args) => {
          candidate = formatOptionsSchema.parse(
            (args as { options: unknown }).options,
          );
          await writeFileAtomic(
            path.join(
              w.root,
              "generated",
              `format-proposal-${randomUUID()}.json`,
            ),
            JSON.stringify({
              options: candidate,
              chapterIds: request.chapterIds,
              createdAt: new Date().toISOString(),
            }),
          );
          return { options: candidate, status: "pending-review" };
        },
      },
    };
    const result = await run(
      await this.adapter(),
      formatRulesProfile,
      context,
      `当前规则：${JSON.stringify(request.options)}\n需求：${request.prompt}`,
      new AbortController().signal,
      () => undefined,
    );
    if (!candidate) throw new Error("模型未提交排版规则");
    return { options: candidate, feedback: result.feedback };
  }
}
