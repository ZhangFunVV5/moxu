import { GenerateService } from "./services/generate-service";
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { writeFileAtomic } from "../core/workspace/atomic-file";
import { waitForCredentialKeyPersistence } from "./services/credential-persistence";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  configSchema,
  startSchema,
  identity,
  failure,
  type Config,
  type TaskEvent,
  type PublicConfig,
} from "../shared/contracts";
import { OpenAICompatible } from "../agent/model/openai-compatible";
import { run } from "../agent/runtime/loop";
import { profile } from "../agent/tools/dispatcher";
import { ModelError } from "../agent/model/model-adapter";
import { registerWorkspaceIpc } from "./ipc/workspace-ipc";
import { WorkspaceService } from "./services/workspace-service";
import { TaskService } from "./services/task-service";
import { FormatService } from "./services/format-service";
import { ProofreadService } from "./services/proofread-service";
import { PipelineService } from "./services/pipeline-service";
const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
let current: { taskId: string; controller: AbortController } | null = null;
let closeApproved = false;
const configFile = () =>
  path.join(app.getPath("userData"), "model-config.json");
async function load(): Promise<Config> {
  try {
    const data = JSON.parse(await readFile(configFile(), "utf8"));
    const { encryptedKey, ...rest } = data;
    return configSchema.parse({
      ...rest,
      apiKey: encryptedKey
        ? safeStorage.decryptString(Buffer.from(encryptedKey, "base64"))
        : "",
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return {
        baseUrl: "https://api.openai.com/v1",
        model: "",
        temperature: 0.2,
        stream: true,
      };
    throw new Error("模型配置无法读取，请重新保存设置");
  }
}
const publicConfig = (c: Config): PublicConfig => ({
  baseUrl: c.baseUrl,
  model: c.model,
  temperature: c.temperature,
  stream: c.stream,
  hasKey: !!c.apiKey,
});
function register() {
  ipcMain.handle("lifecycle:confirm-close", (_event, raw) => {
    const result = z.object({ action: z.enum(["close", "cancel"]) }).strict().safeParse(raw);
    if (!result.success) return failure("INVALID_REQUEST", "关闭操作非法");
    if (result.data.action === "close") {
      closeApproved = true;
      win?.close();
    }
    return { ok: true, data: null };
  });
  ipcMain.handle("config:get", async () => {
    try {
      return { ok: true, data: publicConfig(await load()) };
    } catch {
      return failure("CONFIG_READ", "配置无法读取");
    }
  });
  ipcMain.handle("config:save", async (_e, raw) => {
    const p = configSchema.safeParse(raw);
    if (!p.success)
      return failure(
        "INVALID_CONFIG",
        p.error.issues
          .map((i) => i.path.join(".") + ": " + i.message)
          .join("；"),
      );
    try {
      const c = { ...p.data, apiKey: p.data.apiKey ?? (await load()).apiKey };
      if (c.apiKey && !safeStorage.isEncryptionAvailable())
        return failure("CREDENTIAL_STORAGE", "系统凭据加密不可用");
      const { apiKey, ...rest } = c;
      await mkdir(app.getPath("userData"), { recursive: true });
      const encryptedKey = apiKey ? safeStorage.encryptString(apiKey).toString("base64") : "";
      if (apiKey) await waitForCredentialKeyPersistence(app.getPath("userData"));
      await writeFileAtomic(
        configFile(),
        JSON.stringify({
          ...rest,
          encryptedKey,
        }),
      );
      return { ok: true, data: publicConfig(c) };
    } catch (error) {
      // Return a visible failure without logging credentials or raw config.
      return failure("CONFIG_SAVE", "模型配置保存失败");
    }
  });
  ipcMain.handle("task:start", async (_e, raw) => {
    const p = startSchema.safeParse(raw);
    if (!p.success) return failure("INVALID_REQUEST", "任务参数非法");
    if (current) return failure("BUSY", "已有任务正在运行");
    let config: Config;
    try {
      config = await load();
      if (!config.model)
        return failure("CONFIG_REQUIRED", "请先在设置中配置模型");
    } catch {
      return failure("CONFIG_READ", "模型配置读取失败");
    }
    // Loading settings yields; a concurrent request may have acquired the slot.
    if (current) return failure("BUSY", "已有任务正在运行");
    const taskId = crypto.randomUUID(),
      controller = new AbortController();
    current = { taskId, controller };
    const emit = (
      type: TaskEvent["type"],
      message: string,
      state?: TaskEvent["state"],
    ) =>
      win?.webContents.send("task:event", {
        requestId: p.data.requestId,
        workspaceId: p.data.workspaceId,
        taskId,
        type,
        message,
        state,
      } satisfies TaskEvent);
    setTimeout(async () => {
      emit("taskStarted", "只读样例任务开始", "running");
      try {
        await run(
          new OpenAICompatible({ ...config }),
          profile,
          {
            workspaceId: "sample-book",
            chapterIds: [p.data.chapterId],
            source: "agent",
            allowWrite: false,
            version: 1,
          },
          `${p.data.prompt}\n指定 chapterId=${p.data.chapterId}`,
          controller.signal,
          (t, m) => emit(t, m),
        );
        emit("taskStateChanged", "只读模型→工具→反馈完成", "completed");
      } catch (e) {
        const cancelled = controller.signal.aborted;
        emit(
          "taskStateChanged",
          e instanceof ModelError ? `${e.code}：${e.message}` : "模型任务失败",
          cancelled ? "cancelled" : "failed",
        );
      } finally {
        if (current?.taskId === taskId) current = null;
      }
    }, 0);
    return { ok: true, data: { taskId } };
  });
  ipcMain.handle("task:cancel", (_e, raw) => {
    const p = identity
      .extend({ taskId: z.string().uuid() })
      .strict()
      .safeParse(raw);
    if (!p.success) return failure("INVALID_REQUEST", "取消参数非法");
    if (current?.taskId !== p.data.taskId)
      return failure("NOT_FOUND", "任务不存在");
    current.controller.abort();
    return { ok: true, data: null };
  });
}
function createWindow() {
  closeApproved = false;
  win = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 360,
    minHeight: 640,
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("close", (event) => {
    if (closeApproved) return;
    event.preventDefault();
    win?.webContents.send("lifecycle:close-requested");
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  if (process.argv.includes("--dev")) void win.loadURL("http://127.0.0.1:5173");
  else void win.loadFile(path.join(here, "../../dist/index.html"));
  win.on("closed", () => {
    current?.controller.abort();
    win = null;
  });
}
app.whenReady().then(async () => {
  const workspaceService = new WorkspaceService();
  await workspaceService.initialize().catch(() => undefined);
  register();
  const adapterProvider = async () => {
    const config = await load();
    if (!config.model) throw new Error("请先在设置中配置模型");
    return new OpenAICompatible(config);
  };
  const taskService = new TaskService(workspaceService);
  const proofreadService = new ProofreadService(
    workspaceService,
    taskService,
    adapterProvider,
    async () => (await load()).model || undefined,
  );
  proofreadService.onEvent((event) =>
    win?.webContents.send("proofread:event", event),
  );
  const generateService = new GenerateService(
    workspaceService,
    taskService,
    async () => {
      const config = await load();
      if (!config.model || !config.apiKey)
        throw new ModelError(
          "CONFIG_REQUIRED",
          "请先在模型设置中填写模型名和 API Key",
        );
      return new OpenAICompatible(config);
    },
    async () => (await load()).model || undefined,
  );
  generateService.onEvent((event) =>
    win?.webContents.send("generate:event", event),
  );
  const formatService = new FormatService(workspaceService, adapterProvider);
  const pipelineService = new PipelineService(workspaceService, proofreadService, generateService, formatService, () => win);
  for (const method of ["start", "list", "resume", "cancel", "propose"] as const) {
    ipcMain.handle(`pipeline:${method}`, async (_event, raw) => {
      try {
        const data = method === "list" ? await pipelineService.list()
          : method === "start" ? await pipelineService.start(raw)
          : method === "resume" ? await pipelineService.resume(raw)
          : method === "cancel" ? await pipelineService.cancel(raw)
          : await pipelineService.propose(raw);
        return { ok: true, data };
      } catch (error) {
        return failure(error instanceof z.ZodError ? "INVALID_REQUEST" : typeof error === "object" && error && "code" in error ? String(error.code) : "PIPELINE_FAILED", error instanceof z.ZodError ? "任务参数非法" : error instanceof Error ? error.message : "任务失败");
      }
    });
  }
  registerWorkspaceIpc(
    workspaceService,
    taskService,
    formatService,
    proofreadService,
    generateService,
  );
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});


