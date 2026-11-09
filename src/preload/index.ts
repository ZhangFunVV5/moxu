import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, TaskEvent } from "../shared/contracts";
const api: DesktopApi = {
  lifecycle: {
    confirmClose: (request) => ipcRenderer.invoke("lifecycle:confirm-close", request),
    onCloseRequested(callback) {
      const listener = () => callback();
      ipcRenderer.on("lifecycle:close-requested", listener);
      return () => ipcRenderer.removeListener("lifecycle:close-requested", listener);
    },
  },
  pipeline: {
    start: (r) => ipcRenderer.invoke("pipeline:start", r),
    list: () => ipcRenderer.invoke("pipeline:list"),
    resume: (r) => ipcRenderer.invoke("pipeline:resume", r),
    cancel: (r) => ipcRenderer.invoke("pipeline:cancel", r),
    propose: (r) => ipcRenderer.invoke("pipeline:propose", r),
  },
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (value) => ipcRenderer.invoke("config:save", value),
  start: (value) => ipcRenderer.invoke("task:start", value),
  cancel: (value) => ipcRenderer.invoke("task:cancel", value),
  onEvent(callback) {
    const listener = (_event: unknown, value: TaskEvent) => callback(value);
    ipcRenderer.on("task:event", listener);
    return () => ipcRenderer.removeListener("task:event", listener);
  },
  workspace: {
    state: () => ipcRenderer.invoke("workspace:state"),
    chooseSource: () => ipcRenderer.invoke("workspace:choose-source"),
    preview: (request) => ipcRenderer.invoke("workspace:preview", request),
    create: (request) => ipcRenderer.invoke("workspace:create", request),
    open: () => ipcRenderer.invoke("workspace:open"),
    close: () => ipcRenderer.invoke("workspace:close"),
    recent: () => ipcRenderer.invoke("workspace:recent"),
  },
  chapters: {
    get: (request) => ipcRenderer.invoke("chapter:get", request),
    save: (request) => ipcRenderer.invoke("chapter:save", request),
    rename: (request) => ipcRenderer.invoke("chapter:rename", request),
  },
  tasks: {
    prepare: (request) => ipcRenderer.invoke("task:prepare", request),
  },
  proofread: {
    start: (request) => ipcRenderer.invoke("proofread:start", request),
    cancel: (request) => ipcRenderer.invoke("proofread:cancel", request),
    resume: (request) => ipcRenderer.invoke("proofread:resume", request),
    chapter: (request) => ipcRenderer.invoke("proofread:chapter", request),
    batches: (request) => ipcRenderer.invoke("proofread:batches", request),
    summary: () => ipcRenderer.invoke("proofread:summary"),
    apply: (request) => ipcRenderer.invoke("proofread:apply", request),
    batch: (request) => ipcRenderer.invoke("proofread:batch", request),
    undo: (request) => ipcRenderer.invoke("proofread:undo", request),
    locate: (request) => ipcRenderer.invoke("proofread:locate", request),
    exportReport: (request) =>
      ipcRenderer.invoke("proofread:export-report", request),
    recover: () => ipcRenderer.invoke("proofread:recover"),
    onEvent(callback) {
      const listener = (
        _event: unknown,
        value: import("../shared/proofread-contracts").ProofreadEventDto,
      ) => callback(value);
      ipcRenderer.on("proofread:event", listener);
      return () => ipcRenderer.removeListener("proofread:event", listener);
    },
  },
  generate: {
    start: (r) => ipcRenderer.invoke("generate:start", r),
    resume: (r) => ipcRenderer.invoke("generate:resume", r),
    cancel: (r) => ipcRenderer.invoke("generate:cancel", r),
    chapter: (r) => ipcRenderer.invoke("generate:chapter", r),
    summary: () => ipcRenderer.invoke("generate:summary"),
    selectTitle: (r) => ipcRenderer.invoke("generate:select-title", r),
    exportSummaries: (r) => ipcRenderer.invoke("generate:export-summaries", r),
    recover: () => ipcRenderer.invoke("generate:recover"),
    onEvent(callback) {
      const listener = (
        _event: unknown,
        value: import("../shared/generate-contracts").GenerateEventDto,
      ) => callback(value);
      ipcRenderer.on("generate:event", listener);
      return () => ipcRenderer.removeListener("generate:event", listener);
    },
  },
  format: {
    getPreset: () => ipcRenderer.invoke("format:preset"),
    savePreset: (r) => ipcRenderer.invoke("format:save-preset", r),
    preview: (r) => ipcRenderer.invoke("format:preview", r),
    status: (r) => ipcRenderer.invoke("format:status", r),
    export: (r) => ipcRenderer.invoke("format:export", r),
    propose: (r) => ipcRenderer.invoke("format:propose", r),
  },
};
contextBridge.exposeInMainWorld("desktop", api);
