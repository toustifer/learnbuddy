/**
 * 预热脚本：把线上应用的构建产物灌进持久化 profile 的缓存。
 *
 * 背景：本机到 129.204.52.57:3088 的链路对"多连接并发"极不友好
 * （curl 单连接 10~23KB/s，Chrome 多连接只有 ~1.3KB/s）。
 * 资源带 `Cache-Control: immutable`，所以**只要成功下载一次**，
 * 后续在同一 profile 里都是缓存命中。
 *
 * 做法：不设任何超时，打开首页后每 15 秒打印一次进度，直到 React 真正挂载。
 * 运行： node warmup.cjs [最多分钟数]
 */
const PW = require("C:/Users/lanch/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

const CHROME = "C:/Users/lanch/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe";
const PROFILE = "C:/Users/lanch/.workbuddy/tmp/ui-shots/pw-profile";
const BASE = "http://129.204.52.57:3088/learnbuddy/";
const MAX_MIN = Number(process.argv[2] || 25);

(async () => {
  const ctx = await PW.chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
    proxy: { server: "http://127.0.0.1:7890", bypass: "localhost,127.0.0.1,::1" },
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(0); // 预热阶段不设超时

  const done = new Set();
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/learnbuddy/")) done.add(u.split("/").pop());
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (u.includes("/learnbuddy/")) console.log("  FAILED:", u.split("/").pop(), r.failure()?.errorText);
  });

  console.log("open:", BASE);
  await page.goto(BASE, { waitUntil: "commit", timeout: 0 }).catch((e) => console.log("goto err:", e.message));

  const t0 = Date.now();
  let last = 0;
  for (;;) {
    const mins = (Date.now() - t0) / 60000;
    if (mins > MAX_MIN) {
      console.log(`达到上限 ${MAX_MIN} 分钟，仍未挂载完成，退出`);
      break;
    }
    const st = await page
      .evaluate(() => {
        const r = document.getElementById("root");
        return {
          ready: document.readyState,
          kids: r ? r.children.length : -1,
          textLen: document.body ? document.body.innerText.trim().length : -1
        };
      })
      .catch((e) => ({ err: e.message }));
    const n = done.size;
    if (n !== last || Math.round(mins * 4) % 2 === 0) {
      console.log(`[${mins.toFixed(1)}min] ready=${st.ready} rootKids=${st.kids} textLen=${st.textLen} 已取资源=${n}`);
      last = n;
    }
    if (st.kids > 0 && st.textLen > 40) {
      console.log(`>>> 应用已挂载（耗时 ${mins.toFixed(1)} 分钟），缓存预热完成`);
      break;
    }
    await page.waitForTimeout(15000);
  }

  await ctx.close();
  console.log("已关闭浏览器（缓存保留在 pw-profile）");
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
