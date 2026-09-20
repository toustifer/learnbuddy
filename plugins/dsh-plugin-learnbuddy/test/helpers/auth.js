/**
 * 测试侧认证辅助（身份绑定的配套）
 *
 * 背景：`routes/api.js` 改成「入口只认令牌」之后，测试不能再靠 `?userId=` 声明身份，
 * 否则一律 401。这里把「登录拿令牌」封装起来，让既有用例几乎不用改调用点。
 *
 * 为什么按端口缓存：一个测试文件里常会起多个 Server（各自的 store 不同），
 * 令牌只对签发它的那个 store 有效，跨端口复用会变成 401。
 *
 * 为什么自己发请求而不复用调用方的请求函数：调用方的请求函数会反过来带上令牌，
 * 用它登录会绕成死循环。这里用最小的原生 http 请求，保持独立。
 */
import http from "node:http";

/** 演示账号：种子数据里的教师，密码与 `DEMO_PASSWORD` 一致。 */
export const DEFAULT_TEST_ACCOUNT = { username: "teacher.chen", password: "123" };

const cache = new Map();

function postJson(port, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * 取某端口的访问令牌；首次调用会登录，之后复用同一个 Promise。
 *
 * 缓存键是 **端口 + 账号**：师生对照的用例要在同一台 Server 上分别以教师和学生身份取数，
 * 只按端口缓存会让第二个账号拿回第一个账号的令牌（实测会直接导致 401 / 拿错视角）。
 *
 * **刻意不抛错**：有些测试只挂静态托管、根本没注册业务路由（登录必然 404），
 * 那些用例本来就与身份无关。拿不到令牌就返回空串，请求照常发出、不带 Authorization。
 * 真正需要身份的用例会在服务端拿到 401，失败信息依然清晰。
 *
 * @param {number} port 测试服务器端口
 * @param {{username: string, password: string}} [account]
 * @returns {Promise<string>} 令牌；拿不到则为空串
 */
export function tokenFor(port, account = DEFAULT_TEST_ACCOUNT) {
  const key = `${port}::${account.username}`;
  if (!cache.has(key)) {
    const pending = postJson(port, "/api/learnbuddy/auth/login", account)
      .then((data) => {
        if (data && data.token) return data.token;
        if (process.env.LB_TEST_AUTH_DEBUG === "1") {
          console.warn(`[test-auth] 端口 ${port} 登录未拿到令牌，响应：${JSON.stringify(data).slice(0, 300)}`);
        }
        return "";
      })
      .catch((err) => {
        // 连不上一般意味着该端口没挂业务路由；仍然提示一声，便于排查
        console.warn(`[test-auth] 端口 ${port} 登录请求失败：${err.message}`);
        return "";
      });
    // **只缓存成功拿到的令牌**（同步占位，避免同一端口并发重复登录）。
    // 拿不到令牌时不缓存：操作系统会把已关闭用例的端口号回收给后面的用例，
    // 若把「空令牌」缓存下来，端口被真实服务复用时就会一直不带 Authorization，
    // 表现为莫名其妙的 401（实测踩到过）。
    cache.set(key, pending);
    pending.then((token) => {
      if (!token) cache.delete(key);
    });
    return pending;
  }
  return cache.get(key);
}

/**
 * 给请求头补上 Authorization。
 *
 * `headers.skipAuth === true` 时保持原样——用于刻意验证「未登录一律 401」的用例，
 * 用完即删，不会漏进真实请求。
 *
 * @param {number} port
 * @param {Record<string, string>} headers
 * @returns {Promise<Record<string, string>>}
 */
export async function withAuthHeaders(port, headers = {}) {
  if (headers.skipAuth === true) {
    const clean = { ...headers };
    delete clean.skipAuth;
    return clean;
  }
  const token = await tokenFor(port);
  return token ? { Authorization: `Bearer ${token}`, ...headers } : headers;
}

/**
 * 忘记某端口的所有令牌（该端口的服务器被重建时使用）。
 *
 * 缓存键是 `端口::账号`，所以要按前缀清，不能只删端口本身。
 */
export function forgetToken(port) {
  const prefix = `${port}::`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
