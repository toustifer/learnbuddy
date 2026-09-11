import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAX_BYTES = 8 * 1024 * 1024;

export function registerSpeechRoutes(server, { sendJson, env = process.env }) {
  let busy = false;
  server.use(async (req, res, next) => {
    const url = new URL(req.url, "http://localhost");
    const status = req.method === "GET" && url.pathname === "/api/learnbuddy/speech/status";
    const transcribe = req.method === "POST" && url.pathname === "/api/learnbuddy/speech/transcribe";
    if (!status && !transcribe) return next();
    const command = env.LEARNBUDDY_STT_COMMAND || "";
    const ready = !!command && await access(command, constants.X_OK).then(() => true, () => false);
    if (status) return sendJson(res, 200, { ok: true, ready, provider: "local-whisper", maxSeconds: 60, busy });
    if (!ready) return sendJson(res, 503, { ok: false, error: "免费语音服务尚未配置。" });
    if (busy) return sendJson(res, 429, { ok: false, error: "语音服务正在处理另一段录音，请稍后重试。" });
    const contentType = (req.headers["content-type"] || "").split(";")[0];
    const extensions = { "audio/webm": ".webm", "audio/mp4": ".m4a", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3" };
    if (!extensions[contentType]) return sendJson(res, 415, { ok: false, error: "不支持这种录音格式。" });
    if (Number(req.headers["content-length"]) > MAX_BYTES) return sendJson(res, 413, { ok: false, error: "录音过大，请分段听写。" });
    busy = true;
    let directory;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error("录音过大，请分段听写。");
        chunks.push(chunk);
      }
      if (size < 32) throw new Error("录音为空，请重试。");
      directory = await mkdtemp(path.join(tmpdir(), "learnbuddy-voice-"));
      const input = path.join(directory, "recording" + extensions[contentType]);
      const output = path.join(directory, "transcript.json");
      await writeFile(input, Buffer.concat(chunks), { mode: 0o600 });
      await execute(command, ["--input", input, "--model", env.LEARNBUDDY_STT_MODEL || "small", "--device", env.LEARNBUDDY_STT_DEVICE || "cpu", "--language", "zh", "--output", output], { timeout: 110000, maxBuffer: 2 * 1024 * 1024 });
      const result = JSON.parse(await readFile(output, "utf8"));
      if (typeof result.text !== "string" || !result.text.trim()) throw new Error("没有识别到清晰语音，请重试。");
      if (result.duration > 65) throw new Error("每次最多听写 60 秒，请分段录音。");
      return sendJson(res, 200, { ok: true, text: result.text.slice(0, 12000), duration: result.duration, provider: "local-whisper" });
    } catch (error) {
      const safeMessage = ["录音过大，请分段听写。", "录音为空，请重试。", "没有识别到清晰语音，请重试。", "每次最多听写 60 秒，请分段录音。"].includes(error.message) ? error.message : "语音转写未完成，请检查本地语音服务后重试。";
      if (!res.destroyed) return sendJson(res, 400, { ok: false, error: safeMessage });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      busy = false;
    }
  });
}
