/**
 * 非安全上下文（HTTP + 非 localhost）下的 ID 兼容层。
 *
 * 背景：`crypto.randomUUID()` 只在安全上下文（HTTPS 或 localhost）存在。
 * 通过 `http://<IP>:<port>/learnbuddy/` 访问时它是 `undefined`，直接调用会抛
 * `TypeError`，在 React 渲染期击穿到 ErrorBoundary，页面只剩兜底文案。
 *
 * 这里给出两条互补的路径：
 * 1. `installRandomUUIDPolyfill()`：在 `main.tsx` 引导阶段幂等安装一次，
 *    原生缺失时用 `crypto.getRandomValues` 补一个符合 RFC4122 v4 的 `randomUUID`，
 *    因此所有（含未来新增的）`crypto.randomUUID()` 调用点无需改动即可用；
 * 2. `randomId()`：统一封装，已知调用点显式使用，不依赖引导顺序或模块求值时机。
 *
 * 原则：原生可用时绝不覆盖；任何情况下都不抛未捕获异常，最差也返回格式合法的 v4 ID。
 */

type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
};

const NO_CRYPTO_WARNING =
  "[learnbuddy] 当前环境没有可用的 Web Crypto API（crypto 不存在），无法安装 crypto.randomUUID 兼容实现；ID 将使用降级方案。";

const FALLBACK_WARNING =
  "[learnbuddy] 当前环境缺少 crypto.randomUUID 与 crypto.getRandomValues（HTTP + 非 localhost 属于非安全上下文），已降级为「时间戳 + Math.random」生成 ID。请改用 HTTPS 或 localhost 访问以恢复强随机 UUID。";

const POLYFILL_INSTALLED_WARNING =
  "[learnbuddy] 检测到当前为非安全上下文：crypto.randomUUID 缺失，已用 crypto.getRandomValues 安装 RFC4122 v4 兼容实现。";

const POLYFILL_FAILED_WARNING =
  "[learnbuddy] 安装 crypto.randomUUID 兼容实现失败（crypto 对象不可写），将改用 randomId() 的回落分支：";

const warned = new Set<string>();

/** 只告警一次的 console.warn；连控制台都不可用时也绝不抛错。 */
export function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  try {
    console.warn(message);
  } catch {
    /* 告警不是业务路径，静默忽略 */
  }
}

function getCrypto(scope: unknown = globalThis): CryptoLike | undefined {
  const candidate = (scope as { crypto?: unknown } | undefined)?.crypto;
  return candidate && typeof candidate === "object"
    ? (candidate as CryptoLike)
    : undefined;
}

/** 按 RFC4122 v4 输出：第 13 位十六进制固定为 4，变体位为 8/9/a/b。 */
export function formatUuidV4(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 用宿主 crypto 取 16 字节熵；不可用或抛错时返回 undefined（调用方负责回落）。 */
function randomBytes(crypto: CryptoLike): Uint8Array | undefined {
  if (typeof crypto.getRandomValues !== "function") return undefined;
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return bytes;
  } catch {
    return undefined;
  }
}

/** 极端环境（连 getRandomValues 都没有）的降级：时间戳低 48 位 + Math.random。 */
function fallbackUuidV4(): string {
  const bytes = new Uint8Array(16);
  const stamp = Date.now();
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Math.floor(stamp / 2 ** (8 * i)) & 0xff;
  }
  for (let i = 6; i < 16; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return formatUuidV4(bytes);
}

/**
 * 生成一个 ID：原生 `crypto.randomUUID`（安全上下文）→ `crypto.getRandomValues`
 * 拼 RFC4122 v4 → 时间戳 + Math.random 降级（带可读 warn，不抛异常）。
 */
export function randomId(): string {
  const crypto = getCrypto();
  if (crypto) {
    if (typeof crypto.randomUUID === "function") {
      try {
        const native = crypto.randomUUID();
        if (typeof native === "string" && native.length > 0) return native;
      } catch {
        /* 被策略禁用等情况：继续走回落，绝不冒泡 */
      }
    }
    const bytes = randomBytes(crypto);
    if (bytes) return formatUuidV4(bytes);
  }
  warnOnce(FALLBACK_WARNING);
  return fallbackUuidV4();
}

/**
 * 幂等安装 `crypto.randomUUID` 兼容实现。
 *
 * 返回 `true` 表示本次调用真的安装了 polyfill；原生已存在、作用域无 crypto
 * 或 crypto 不可写时返回 `false`（后两者会各自给出可读 warn）。
 * 重复调用不会覆盖已安装实现，也不会重复告警。
 */
export function installRandomUUIDPolyfill(scope: unknown = globalThis): boolean {
  const crypto = getCrypto(scope);
  if (!crypto) {
    warnOnce(NO_CRYPTO_WARNING);
    return false;
  }
  if (typeof crypto.randomUUID === "function") return false; // 原生优先

  const polyfill = (): string => {
    const bytes = randomBytes(crypto);
    if (bytes) return formatUuidV4(bytes);
    warnOnce(FALLBACK_WARNING);
    return fallbackUuidV4();
  };

  try {
    Object.defineProperty(crypto, "randomUUID", {
      value: polyfill,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch (error) {
    warnOnce(
      `${POLYFILL_FAILED_WARNING}${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  warnOnce(POLYFILL_INSTALLED_WARNING);
  return true;
}
