import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 这些用例真实加载 `./random-id.ts`（每次 `vi.resetModules()` 后动态 import），
 * 不复制实现逻辑，因此测到的就是 main.tsx 引导阶段与各调用点实际使用的那份代码。
 */

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type RandomIdModule = typeof import("./random-id");

async function loadModule(): Promise<RandomIdModule> {
  vi.resetModules(); // 清掉 warned 集合等模块级状态
  return await import("./random-id");
}

/** 真实 crypto，但按非安全上下文的样子抹掉 randomUUID。 */
function insecureCrypto() {
  const real = globalThis.crypto;
  return {
    getRandomValues: (array: Uint8Array) => real.getRandomValues(array),
  };
}

function assertV4(id: string) {
  expect(id).toMatch(UUID_V4);
  expect(id[14]).toBe("4"); // 版本位：第 13 位十六进制
  expect("89ab").toContain(id[19]); // 变体位
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("randomId 在非安全上下文（HTTP + 非 localhost）下不崩", () => {
  it("crypto.randomUUID 缺失时用 getRandomValues 生成合法 v4 UUID", async () => {
    vi.stubGlobal("crypto", insecureCrypto());
    const { randomId } = await loadModule();

    const id = randomId();

    assertV4(id);
  });

  it("crypto.randomUUID 缺失时反复调用仍然唯一且格式合法", async () => {
    vi.stubGlobal("crypto", insecureCrypto());
    const { randomId } = await loadModule();

    const ids = new Set(Array.from({ length: 200 }, () => randomId()));

    expect(ids.size).toBe(200);
    for (const id of ids) assertV4(id);
  });

  it("randomUUID 抛错（被策略禁用）时也不冒泡，回落 getRandomValues", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new TypeError("disabled by policy");
      },
      getRandomValues: (array: Uint8Array) => real.getRandomValues(array),
    });
    const { randomId } = await loadModule();

    expect(() => randomId()).not.toThrow();
    assertV4(randomId());
  });
});

describe("randomId 优先使用原生实现", () => {
  it("原生 crypto.randomUUID 可用时走原生，不碰 getRandomValues", async () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    const getRandomValues = vi.fn();
    vi.stubGlobal("crypto", { randomUUID, getRandomValues });
    const { randomId } = await loadModule();

    expect(randomId()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("spy 原生 crypto.randomUUID，确认它被真正调用且结果原样返回", async () => {
    const spy = vi.spyOn(globalThis.crypto, "randomUUID");
    const { randomId } = await loadModule();

    const id = randomId();

    expect(spy).toHaveBeenCalledTimes(1);
    assertV4(id);
  });
});

describe("installRandomUUIDPolyfill 引导阶段兼容层", () => {
  it("原生可用时绝不覆盖，返回 false", async () => {
    const native = vi.fn(() => "native-uuid");
    vi.stubGlobal("crypto", { randomUUID: native });
    const { installRandomUUIDPolyfill } = await loadModule();

    expect(installRandomUUIDPolyfill()).toBe(false);
    expect(globalThis.crypto.randomUUID).toBe(native);
  });

  it("非安全上下文下安装后，未改动的 crypto.randomUUID() 调用点直接可用", async () => {
    vi.stubGlobal("crypto", insecureCrypto());
    const { installRandomUUIDPolyfill } = await loadModule();

    expect(installRandomUUIDPolyfill()).toBe(true);

    // 这就是 8 处调用点原来的写法，一行都不用改
    assertV4(globalThis.crypto.randomUUID());
    assertV4(globalThis.crypto.randomUUID());
  });

  it("幂等：重复安装不覆盖已装实现，也不重复告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("crypto", insecureCrypto());
    const { installRandomUUIDPolyfill } = await loadModule();

    expect(installRandomUUIDPolyfill()).toBe(true);
    const installed = globalThis.crypto.randomUUID;
    expect(installRandomUUIDPolyfill()).toBe(false);
    expect(installRandomUUIDPolyfill()).toBe(false);

    expect(globalThis.crypto.randomUUID).toBe(installed);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(
      messages.filter((m) => m.includes("已用 crypto.getRandomValues")),
    ).toHaveLength(1);
  });

  it("crypto 存在但可写性受限时，安装失败也不抛，只给可读告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const frozen = Object.freeze({});
    vi.stubGlobal("crypto", frozen);
    const { installRandomUUIDPolyfill } = await loadModule();

    expect(() => installRandomUUIDPolyfill()).not.toThrow();
    expect(installRandomUUIDPolyfill()).toBe(false);
    expect(String(warn.mock.calls[0]?.[0])).toContain("兼容实现失败");
  });
});

describe("两级回退：getRandomValues 也没有时（极端环境）", () => {
  it("给出可读 warn 且返回格式合法的 ID，不抛未捕获异常", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("crypto", {});
    const { installRandomUUIDPolyfill, randomId } = await loadModule();
    installRandomUUIDPolyfill();

    let id = "";
    expect(() => {
      id = randomId();
    }).not.toThrow();
    assertV4(id);

    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(
      messages.some((m) => m.includes("非安全上下文") && m.includes("降级")),
    ).toBe(true);
  });

  it("连 crypto 对象都不存在时同样只有可读告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("crypto", undefined);
    const { installRandomUUIDPolyfill, randomId } = await loadModule();

    expect(installRandomUUIDPolyfill()).toBe(false);
    let id = "";
    expect(() => {
      id = randomId();
    }).not.toThrow();
    assertV4(id);
    expect(
      warn.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("Web Crypto API");
  });

  it("真实环境（Node/现代浏览器安全上下文）下走原生且格式合法", async () => {
    const { randomId } = await loadModule();

    assertV4(randomId());
  });
});
