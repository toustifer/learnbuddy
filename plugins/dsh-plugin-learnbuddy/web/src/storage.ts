import { freshState } from "./seed";
import type { DemoState } from "./types";

const STATE_KEY = "learnbuddy-demo-v1";
export function readState(): { state: DemoState; warning?: string } {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return { state: freshState() };
    const saved = JSON.parse(raw) as DemoState;
    if (
      saved.version !== 1 ||
      !Array.isArray(saved.materials) ||
      !Array.isArray(saved.assignments) ||
      !Array.isArray(saved.submissions) ||
      !saved.chats ||
      !saved.generatedFeedback
    )
      throw new Error("invalid state");
    saved.submissions = saved.submissions.map((s) =>
      s.status === "grading"
        ? {
            ...s,
            status: "failed",
            failure: "上次评阅被刷新中断，可以重新评阅。",
          }
        : s,
    );
    return { state: saved };
  } catch {
    return {
      state: freshState(),
      warning: "未能读取上次记录，已加载初始演示。",
    };
  }
}
export function writeState(state: DemoState) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("learnbuddy-demo-files", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("当前浏览器无法保存文件，请检查存储权限。"));
  });
}
export async function saveBlob(id: string, blob: Blob) {
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(new Error("文件保存失败，浏览器存储空间可能不足。"));
      tx.onabort = () => reject(new Error("文件保存被中断。"));
    });
  } finally {
    db.close();
  }
}
export async function getBlob(id: string): Promise<Blob | undefined> {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("files").objectStore("files").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("未能读取文件。"));
    });
  } finally {
    db.close();
  }
}
export async function clearBlobs() {
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("清理文件失败。"));
    });
  } finally {
    db.close();
  }
}
