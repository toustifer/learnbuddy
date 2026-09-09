import { registerLearnBuddyRoutes } from "./routes/api.js";
import { registerLearnBuddySkills } from "./skills/index.js";

/**
 * LearnBuddy Cordis/DSH Plugin
 * 
 * 核心职责：
 * 1. 挂载 LearnBuddy 后端轻量 API 路由（课件管理、答疑卡检索、AutoGrader 评分）
 * 2. 注册 DSH Skills（课件伴学答疑、实验报告逐项多模态核查）
 * 3. 支撑单入口免密测试（user/123）与前后端解耦联调
 */

export const name = "learnbuddy";

// 声明 Cordis 服务依赖（不需要强绑定特定服务，保持解耦自举）
export const inject = [];


export function apply(ctx) {
  const logger = ctx.logger ? ctx.logger("learnbuddy") : console;
  logger.info("[LearnBuddy Plugin] Initializing LearnBuddy DSH Plugin v0.1.0...");

  // 1. 注册专属 Skills (提供给 Agent 伴学与 AutoGrader)
  try {
    registerLearnBuddySkills(ctx);
    logger.info("[LearnBuddy Plugin] Skills registered successfully.");
  } catch (err) {
    logger.warn("[LearnBuddy Plugin] Skills registration skipped or failed:", err.message);
  }

  // 2. 挂载 HTTP/REST 业务 API（供黄山的前端 Demo 直接调用）
  try {
    registerLearnBuddyRoutes(ctx);
    logger.info("[LearnBuddy Plugin] Web API routes mounted at /api/learnbuddy/*");
  } catch (err) {
    logger.warn("[LearnBuddy Plugin] Web API route mounting skipped or failed:", err.message);
  }
}
