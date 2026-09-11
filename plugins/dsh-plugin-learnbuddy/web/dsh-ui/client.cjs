const React = require("react");
const h = React.createElement;
const ID = "@learnbuddy/dsh-ui";
const embedded =
  window.parent !== window &&
  new URL(location.href).searchParams.get("learnbuddy") === "embedded";

const tokens = {
  "--dsw-alias-bg-base": { light: "#ffffff", dark: "#191d19" },
  "--dsw-alias-bg-layer-1": { light: "#ffffff", dark: "#222822" },
  "--dsw-alias-bg-layer-2": { light: "#f4f6f5", dark: "#2a3229" },
  "--dsw-alias-bg-overlay": { light: "#ffffff", dark: "#262d25" },
  "--dsw-specific-sidebar-fill": { light: "#f1f3ed", dark: "#171c17" },
  "--dsw-alias-brand-primary": { light: "#28785a", dark: "#afcd94" },
  "--dsw-alias-brand-text": { light: "#506e3d", dark: "#bad9a3" },
  "--dsw-alias-button-primary-fill": { light: "#597445", dark: "#afcd94" },
  "--dsw-alias-button-primary-hover": { light: "#4a6636", dark: "#c0dda8" },
  "--dsw-alias-button-primary-dimmed": { light: "#dbe5d1", dark: "#46523e" },
  "--dsw-alias-button-ghost-active-fill": { light: "#e8efdf", dark: "#34402d" },
  "--dsw-alias-button-ghost-active-hover": {
    light: "#dde8d1",
    dark: "#43533a",
  },
  "--dsw-specific-sidebar-nav-item-active": {
    light: "#e3eada",
    dark: "#34412b",
  },
  "--dsw-specific-sidebar-nav-item-active-accent": {
    light: "#4c6939",
    dark: "#bcdda0",
  },
  "--dsw-alias-link": { light: "#4e703d", dark: "#b7d99a" },
  "--dsw-alias-label-primary": { light: "#30362d", dark: "#e9eee5" },
  "--dsw-alias-label-secondary": { light: "#70796a", dark: "#b1bba9" },
  "--dsw-alias-border-l1": { light: "#e3e8dc", dark: "#343e30" },
  "--dsw-alias-border-l2": { light: "#cdd7c3", dark: "#4b5a44" },
};
const css = `
/* Compatibility surface for DSH 0.1.5-rc.1: use public slot markers rather than hashed class names. */
div:has(> span > [data-slot="conversation.hero.brand.mark"]) > span:has(> [data-slot="conversation.hero.brand.mark"]) {width:auto;height:auto;display:block;overflow:visible}
div:has(> span > [data-slot="conversation.hero.brand.mark"]) > span:not(:has(> [data-slot="conversation.hero.brand.mark"])) {display:none}
div:has(> span > [data-slot="conversation.hero.brand.mark"]) {display:block;white-space:normal;text-align:center}
.lb-dsh-hero{display:flex;flex-direction:column;align-items:center;gap:12px;padding:10px 14px}
.lb-dsh-hero h2{font-size:26px;line-height:1.5;letter-spacing:-.6px;font-weight:550;margin:0;color:var(--dsw-alias-label-primary)}
.lb-dsh-hero p{font-size:13px;font-weight:400;line-height:1.8;letter-spacing:0;white-space:normal;max-width:340px;margin:0;color:var(--dsw-alias-label-secondary)}
body.lb-dsh-embedded [data-slot="root"]>div{grid-template-columns:0 minmax(0,1fr) 0!important}
body.lb-dsh-embedded [data-slot="root"]>div>div:has(>[data-slot="sidebar"]),
body.lb-dsh-embedded [data-slot="root"]>div>div:has(>[data-slot="rightbar"]){display:none}
body.lb-dsh-embedded [data-slot="root"]>div>div:has(>[data-slot="main"]){grid-column:2;min-width:0}
body.lb-dsh-embedded [data-slot="root"]>div>[data-side],
body.lb-dsh-embedded [data-width-handle]{display:none}
body.lb-dsh-embedded [data-slot="main.conversation"]>div{--dsh-chat-content-width:100%;--dsh-composer-side-clearance:12px;min-width:0}
body.lb-dsh-embedded [data-phase="hero"] [data-conversation-scroll]{justify-content:flex-start!important}
body.lb-dsh-embedded [data-composer-seat]{flex-shrink:0}
body.lb-dsh-embedded [data-slot="conversation.composer.bar"] button[aria-label="发送消息"]{background:var(--dsw-alias-brand-primary)}
body.lb-dsh-embedded [data-slot="conversation.session.header"]>header{padding:7px 10px 0;min-height:48px}
body.lb-dsh-embedded [data-slot="conversation.session.header.utilities"]{display:none!important}
body.lb-dsh-embedded div:has(>[data-slot="conversation.hero.workspace"]){display:none}
body.lb-dsh-embedded .lb-dsh-hero{padding:20px 18px 12px;gap:14px}
body.lb-dsh-embedded .lb-dsh-hero h2{font-size:21px;max-width:230px}
body.lb-dsh-embedded .lb-dsh-hero p{font-size:12px;max-width:240px}
body.lb-dsh-embedded [data-slot="conversation.input.dock"] .lb-dsh-context{margin:0 12px 5px;padding:10px 12px}
body.lb-dsh-embedded .lb-dsh-context p{font-size:11px;line-height:1.65}
body.lb-dsh-embedded .lb-dsh-context pre{max-height:120px}
body.lb-dsh-embedded .lb-dsh-context strong{font-size:12px}
body.lb-dsh-embedded .lb-dsh-status{font-size:10px;padding:0 6px}
body.lb-dsh-embedded [data-slot="conversation.composer.bar"] [role="textbox"]{font-size:13px;min-height:92px;max-height:230px}
body.lb-dsh-embedded [data-slot="conversation.composer.bar"] button{max-width:100%}
@media(max-height:540px){
body.lb-dsh-embedded .lb-dsh-hero{gap:5px;padding:10px 0 5px}
body.lb-dsh-embedded .lb-dsh-hero .lb-dsh-mark svg{width:24px;height:24px}
body.lb-dsh-embedded .lb-dsh-hero h2{font-size:18px;max-width:none}
body.lb-dsh-embedded .lb-dsh-hero p,body.lb-dsh-embedded .lb-dsh-context p{display:none}
body.lb-dsh-embedded [data-slot="conversation.composer.bar"] [role="textbox"]{min-height:52px;max-height:180px}
body.lb-dsh-embedded .lb-dsh-context details{margin-top:3px}
}

.lb-dsh-mark{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);flex-shrink:0}
.lb-dsh-name{font-size:17px;font-weight:650;letter-spacing:-.5px;color:var(--dsw-alias-label-primary)}
.lb-dsh-link,.lb-dsh-action{display:inline-flex;align-items:center;gap:7px;text-decoration:none;font:inherit;cursor:pointer;color:var(--dsw-alias-brand-primary);border:0;background:transparent;padding:8px;border-radius:8px}
.lb-dsh-link:hover,.lb-dsh-action:hover{background:var(--dsw-alias-bg-layer-2)}
.lb-dsh-link:focus-visible,.lb-dsh-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.lb-dsh-action:disabled{opacity:.5;cursor:not-allowed}
.lb-dsh-context{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;padding:13px 16px;margin-bottom:12px;max-width:100%;font-size:13px;color:var(--dsw-alias-label-primary)}
.lb-dsh-context-head{display:flex;gap:8px;align-items:center;justify-content:space-between}
.lb-dsh-context strong{font-weight:600;overflow-wrap:anywhere}
.lb-dsh-context p{font-size:12px;line-height:1.8;color:var(--dsw-alias-label-secondary);margin:6px 0 0}
.lb-dsh-context details{font-size:12px;line-height:1.7;margin-top:8px}
.lb-dsh-context pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font:inherit;margin:8px 0}
.lb-dsh-status{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);padding:7px 0}
.lb-dsh-status-dot{width:5px;height:5px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-brand-primary)}
.lb-dsh-context-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:5px -8px -5px}
.lb-dsh-landing{height:100%;overflow:auto;padding:clamp(24px,7vw,84px);color:var(--dsw-alias-label-primary)}
.lb-dsh-landing-inner{max-width:760px;margin:0 auto}
.lb-dsh-eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-brand-primary);margin-bottom:25px}
.lb-dsh-landing h1{font-size:clamp(27px,3vw,38px);line-height:1.45;font-weight:560;letter-spacing:-1px;margin:20px 0 15px}
.lb-dsh-intro{font-size:14px;line-height:1.9;color:var(--dsw-alias-label-secondary);max-width:550px;margin-bottom:32px}
.lb-dsh-start{display:inline-flex;align-items:center;gap:8px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:13px;border:0;border-radius:9px;padding:12px 17px;cursor:pointer}
.lb-dsh-start:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px}
.lb-dsh-start-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:24px 0 40px}
.lb-dsh-guide{border-top:.5px solid var(--dsw-alias-border-l1);padding:21px 0;display:flex;gap:20px;align-items:baseline}
.lb-dsh-guide > span{font-size:11px;color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums}
.lb-dsh-guide h3{font-size:14px;font-weight:550;margin:0 0 7px}
.lb-dsh-guide p{font-size:12px;line-height:1.8;color:var(--dsw-alias-label-secondary);margin:0}
@media(max-width:600px){.lb-dsh-landing{padding:27px 20px}.lb-dsh-guide{gap:12px}.lb-dsh-context-head{align-items:flex-start}.lb-dsh-name{font-size:15px}}

/* Embedded reading mode: one conversation, one composer, one compact reference. */
body.lb-dsh-embedded [data-slot="conversation.session.header"] {display:none!important}
body.lb-dsh-embedded .lb-dsh-hero{padding:22px 18px 12px;gap:6px;align-items:flex-start;text-align:left}
body.lb-dsh-embedded .lb-dsh-hero .lb-dsh-mark{display:none}
body.lb-dsh-embedded .lb-dsh-hero h2{font-size:16px;line-height:1.55;font-weight:600;max-width:none;letter-spacing:0}
body.lb-dsh-embedded .lb-dsh-hero p{font-size:12px;max-width:none;line-height:1.7}
body.lb-dsh-embedded [data-slot="conversation.composer.bar"] [role="textbox"]{font-size:14px;line-height:1.65;min-height:56px;max-height:150px}
body.lb-dsh-embedded [data-slot="conversation.input.dock"] .lb-dsh-context{padding:7px 9px;margin:0 10px 5px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);border:0}
.lb-dsh-context details{min-width:0;flex:1;margin:0}
.lb-dsh-context summary{cursor:pointer;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;color:var(--dsw-alias-label-primary)}
.lb-dsh-context-actions{margin:2px 0 0;gap:8px}
.lb-dsh-context-actions .lb-dsh-action{padding:4px 0;font-size:11px}
.lb-dsh-context .lb-dsh-context-head>.lb-dsh-action{padding:2px 4px;line-height:1}
.lb-dsh-voice{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 12px 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.lb-dsh-voice button{display:inline-flex;align-items:center;gap:5px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;padding:5px 2px;cursor:pointer}
.lb-dsh-voice button[aria-pressed="true"]{color:#a23d3d}
.lb-dsh-voice button:disabled{opacity:.5;cursor:wait}
.lb-dsh-voice span{line-height:1.6}
`;

function Mark({ size = 28, className = "" }) {
  return h(
    "span",
    { className: `lb-dsh-mark ${className}` },
    h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 32 32",
        fill: "none",
        "aria-hidden": true,
      },
      h("path", {
        d: "M16 26V12M16 18C8 18 5 12 6 5c7 0 11 5 10 13ZM16 23c8 0 12-6 11-13-7 0-12 5-11 13Z",
        stroke: "currentColor",
        strokeWidth: "2.2",
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
    ),
  );
}

function allowedOrigins() {
  const origins = [location.origin];
  if (
    location.port === "3089" &&
    ["127.0.0.1", "localhost"].includes(location.hostname)
  )
    origins.push(`${location.protocol}//${location.hostname}:5178`);
  return origins;
}
function validatedPayload(value) {
  if (
    !value ||
    value.type !== "learnbuddy:context" ||
    typeof value.requestId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.text !== "string" ||
    typeof value.returnPath !== "string"
  )
    return null;
  if (
    value.requestId.length > 100 ||
    value.title.length > 300 ||
    value.text.length > 24000 ||
    !/^\/learnbuddy\/#(?:material|report)\/[A-Za-z0-9_-]+$/.test(
      value.returnPath,
    )
  )
    return null;
  return {
    requestId: value.requestId,
    title: value.title,
    text: value.text,
    returnPath: value.returnPath,
  };
}

exports.inject = [
  "theme",
  "slots",
  "layout",
  "uiWorkspace",
  "workspaces",
  "sessions",
];
exports.apply = function apply(ctx) {
  let pending = null;
  let activeContext = null;
  let initializing = null;
  let boundContext = null;
  const received = new Set();
  async function initialize(contextKey) {
    if (boundContext && boundContext !== contextKey)
      throw new Error("课程材料已变化，请重新打开学习助手。");
    boundContext = contextKey;
    if (activeContext === contextKey) return;
    if (initializing) return initializing;
    initializing = (async () => {
      const previewPath = globalThis.__LEARNBUDDY_UI__?.previewWorkspace;
      if (
        typeof previewPath !== "string" ||
        !["127.0.0.1", "localhost"].includes(location.hostname)
      )
        throw new Error("尚未关联课程学习会话，请先由后台完成课程工作区接入。");
      await ctx.sessions.refresh();
      const storageKey = `learnbuddy.dsh.session.v1:${contextKey}`;
      let sessionId;
      try {
        sessionId = localStorage.getItem(storageKey);
      } catch {}
      if (!sessionId || !ctx.sessions.list.getSnapshot().byId[sessionId]) {
        const workspace = await ctx.workspaces.create({ path: previewPath });
        sessionId = await ctx.sessions.create({
          workspaceId: workspace.workspaceId,
        });
        try {
          localStorage.setItem(storageKey, sessionId);
        } catch {}
      }
      ctx.uiWorkspace.openSession(sessionId);
      activeContext = contextKey;
      setPending(null);
    })();
    try {
      await initializing;
    } finally {
      initializing = null;
    }
  }
  const listeners = new Set();
  const source = {
    getSnapshot: () => pending,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const setPending = (value) => {
    pending = value;
    listeners.forEach((fn) => fn());
  };
  const origins = allowedOrigins();
  const workbench = () =>
    (pending?.origin || location.origin) +
    (pending?.returnPath || "/learnbuddy/");
  const clear = () => setPending(null);

  ctx.effect(
    () => ctx.theme.overrideTokens(ID, tokens),
    "learnbuddy: light and dark palette",
  );
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.learnbuddy = "ui";
    style.textContent = css;
    if (embedded) document.body.classList.add("lb-dsh-embedded");
    document.head.append(style);
    return () => {
      style.remove();
      document.body.classList.remove("lb-dsh-embedded");
    };
  }, "learnbuddy: component styles");

  // This DSH version exposes the brand slot but no composer-copy slot. Adapt
  // only the presentation attributes; keep the native editor and every input state.
  ctx.effect(() => {
    const original = "描述你想要构建的内容, / 调用指令, @ 文件或对话";
    const replacement = "关于这份材料，你想问什么？";
    const adapt = () => {
      document
        .querySelectorAll("[data-composer-input][data-placeholder]")
        .forEach((input) => {
          if (input.getAttribute("data-placeholder") === original)
            input.setAttribute("data-placeholder", replacement);
          if (input.getAttribute("aria-label") === original)
            input.setAttribute("aria-label", replacement);
        });
      document
        .querySelectorAll("[data-composer-placeholder]")
        .forEach((node) => {
          if (node.textContent === original) node.textContent = replacement;
        });
    };
    const observer = new MutationObserver(adapt);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-placeholder", "aria-label"],
    });
    adapt();
    return () => {
      observer.disconnect();
      document.querySelectorAll("[data-composer-input]").forEach((input) => {
        if (input.getAttribute("data-placeholder") === replacement)
          input.setAttribute("data-placeholder", original);
        if (input.getAttribute("aria-label") === replacement)
          input.setAttribute("aria-label", original);
      });
      document
        .querySelectorAll("[data-composer-placeholder]")
        .forEach((node) => {
          if (node.textContent === replacement) node.textContent = original;
        });
    };
  }, "learnbuddy: learning composer copy");

  ctx.effect(() => {
    if (embedded) ctx.sessions.clear();
    let disposed = false;
    const receive = async (event) => {
      const expected = embedded ? window.parent : window.opener;
      if (!origins.includes(event.origin) || event.source !== expected) return;
      const value = event.data;
      if (
        embedded &&
        (typeof value?.contextKey !== "string" ||
          !/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(value.contextKey) ||
          value.contextKey.length > 180)
      )
        return;
      const reply = (type, message) => {
        if (!disposed)
          event.source.postMessage(
            {
              type,
              requestId: value.requestId,
              contextKey: value.contextKey,
              ...(message ? { message } : {}),
            },
            event.origin,
          );
      };
      if (embedded && value?.type === "learnbuddy:init") {
        if (typeof value.requestId !== "string" || value.requestId.length > 100)
          return;
        try {
          await initialize(value.contextKey);
          reply("learnbuddy:ready");
        } catch (error) {
          reply(
            "learnbuddy:error",
            error instanceof Error ? error.message : "学习会话初始化失败。",
          );
        }
        return;
      }
      if (embedded && value?.contextKey !== activeContext) return;
      const payload = validatedPayload(value);
      if (!payload) return;
      if (!received.has(payload.requestId)) {
        setPending({ ...payload, origin: event.origin });
        received.add(payload.requestId);
        if (received.size > 200)
          received.delete(received.values().next().value);
        if (!embedded) ctx.layout.selectPanel("learnbuddy");
      }
      reply("learnbuddy:received");
    };
    window.addEventListener("message", receive);
    return () => {
      disposed = true;
      window.removeEventListener("message", receive);
      listeners.clear();
    };
  }, "learnbuddy: explicit workbench handoff");

  function ReturnLink({ wide = true }) {
    if (embedded) return null;
    return h(
      "a",
      { href: workbench(), className: "lb-dsh-link", title: "返回课程工作台" },
      h(Mark, { size: 17 }),
      wide && "课程工作台",
    );
  }
  function ContextCard({ value, actions }) {
    if (!value) return null;
    return h(
      "section",
      { className: "lb-dsh-context", "aria-label": "从课程工作台带入的材料" },
      h(
        "div",
        { className: "lb-dsh-context-head" },
        h("details", null, h("summary", { title: value.title }, `引用 · ${value.title}`), h("pre", null, value.text)),
        h(
          "button",
          {
            className: "lb-dsh-action",
            onClick: clear,
            "aria-label": "移除带入材料",
          },
          "×",
        ),
      ),
      actions,
    );
  }
  function Landing({ useMaterial, start }) {
    const value = useMaterial((x) => x);
    const [starting, setStarting] = React.useState(false);
    const [error, setError] = React.useState("");
    return h(
      "div",
      { className: "lb-dsh-landing" },
      h(
        "div",
        { className: "lb-dsh-landing-inner" },
        h("div", { className: "lb-dsh-eyebrow" }, "LearnBuddy / 学习助手"),
        h(Mark, { size: 46 }),
        h("h1", null, "带着材料，", h("br"), "把问题一起想明白。"),
        h(
          "p",
          { className: "lb-dsh-intro" },
          "从课件中的一句话、一张图或一条评阅反馈开始。在连续对话中澄清疑问，再回到原文验证自己的理解。",
        ),
        h(ContextCard, { value }),
        h(
          "div",
          { className: "lb-dsh-start-row" },
          h(
            "button",
            {
              className: "lb-dsh-start",
              disabled: starting,
              onClick: async () => {
                setStarting(true);
                setError("");
                try {
                  await start();
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "暂时无法开始对话，请重试。",
                  );
                } finally {
                  setStarting(false);
                }
              },
            },
            starting ? "正在打开…" : "进入学习对话",
            " ↗",
          ),
          h(ReturnLink, {}),
        ),
        error && h("p", { role: "alert" }, error),
        [
          [
            "01",
            "让提问带上依据",
            "在课程工作台引用原文，带入当前阅读内容。原文件仍保留在工作台。",
          ],
          [
            "02",
            "保留完整的讨论过程",
            "会话、附件、生成过程与停止操作由 DSH 原生界面承接。",
          ],
          [
            "03",
            "理解之后，再回到材料",
            "对照来源阅读与复习。评分与教师复核继续在报告页面完成。",
          ],
        ].map(([n, t, d]) =>
          h(
            "div",
            { key: n, className: "lb-dsh-guide" },
            h("span", null, n),
            h("div", null, h("h3", null, t), h("p", null, d)),
          ),
        ),
      ),
    );
  }
  function NativeVoice({ draft, inputActions, disabled }) {
    const [phase, setPhase] = React.useState("idle");
    const [hint, setHint] = React.useState("");
    const current = React.useRef({ draft, inputActions });
    current.current = { draft, inputActions };
    const controller = React.useRef(null);
    React.useEffect(() => {
      controller.current = createDictation({ onState: setPhase, onError: setHint, onText: (text) => {
        current.current.inputActions.setDraft([current.current.draft, text].filter(Boolean).join("\n"));
        setHint("已填入输入框");
      }});
      return () => controller.current?.destroy();
    }, []);
    React.useEffect(() => { if (disabled) controller.current?.stop(); }, [disabled]);
    return h("div", { className: "lb-dsh-voice" }, h("button", {
      type: "button", disabled: disabled || phase === "requesting" || phase === "transcribing",
      "aria-pressed": phase === "recording", title: "免费本地语音转写，最长 60 秒",
      onClick: () => { setHint(""); if (phase === "recording") controller.current?.stop(); else void controller.current?.start(); },
    }, h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, "aria-hidden": true },
      h("rect", { x: 9, y: 2, width: 6, height: 12, rx: 3 }), h("path", { d: "M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" })),
    phase === "recording" ? "结束录音" : phase === "transcribing" ? "正在转写…" : phase === "requesting" ? "打开麦克风…" : "语音输入"), hint && h("span", { role: "status" }, hint));
  }
  function Dock({ useMaterial, useInput, inputActions }) {
    const value = useMaterial((x) => x);
    const draft = useInput((s) => s.draft);
    const phase = useInput((s) => s.phase);
    const [inserted, setInserted] = React.useState(null);
    return h(React.Fragment, null, h(ContextCard, {
      value,
      actions:
        value &&
        h(
          "div",
          { className: "lb-dsh-context-actions" },
          h(
            "button",
            {
              className: "lb-dsh-action",
              disabled: phase !== "plain" || inserted === value.requestId,
              onClick: () => {
                inputActions.setDraft(
                  [draft, value.text].filter(Boolean).join("\n\n"),
                );
                setInserted(value.requestId);
              },
            },
            inserted === value.requestId ? "已加入问题" : "加入当前问题",
          ),
          h(ReturnLink, {}),
        ),
    }), h(NativeVoice, { draft, inputActions, disabled: phase !== "plain" }));
  }
  const register = (name, options, component) =>
    ctx.slots.inject(name, () =>
      ctx.slots.register({ name, ...options }, component),
    );
  const materialInject = () => ({ hooks: { material: source } });
  register("sidebar.brand.mark", { priority: -20 }, Mark);
  register("sidebar.brand.name", { priority: -20 }, () =>
    h("span", { className: "lb-dsh-name" }, "LearnBuddy"),
  );
  register("conversation.hero.brand.mark", { priority: -20 }, () =>
    h(
      "div",
      { className: "lb-dsh-hero" },
      h(Mark, { size: embedded ? 34 : 42 }),
      h("h2", null, embedded ? "围绕这份材料继续讨论" : "一起把问题想明白"),
      h("p", null, embedded ? "带入原文，也可以直接写下问题。" : "从原文出发，逐步理解。"),
    ),
  );
  if (globalThis.__LEARNBUDDY_UI__?.previewWorkspace) {
    // A UI-only local preview needs no provider credentials; native model settings stay available.
    register(
      "settings.onboarding",
      { id: "deepseek-official", priority: -20 },
      () => null,
    );
  }
  register(
    "sidebar.footer.action",
    { id: "learnbuddy-return", order: -10 },
    ReturnLink,
  );
  register(
    "sidebar.panellist",
    { id: "learnbuddy", label: "学习助手", order: -100 },
    Mark,
  );
  register(
    "main",
    {
      key: "learnbuddy",
      inject: () => ({
        ...materialInject(),
        start: async () => {
          const previewPath = globalThis.__LEARNBUDDY_UI__?.previewWorkspace;
          if (
            typeof previewPath === "string" &&
            location.hostname === "127.0.0.1"
          ) {
            const workspace = await ctx.workspaces.create({
              path: previewPath,
            });
            if (workspace.title === "workspace")
              await ctx.workspaces.rename(workspace.workspaceId, "学习预览");
            await ctx.uiWorkspace.openWorkspace(workspace.workspaceId);
          } else ctx.uiWorkspace.startSession();
        },
      }),
    },
    Landing,
  );
  register(
    "conversation.input.dock",
    { id: "learnbuddy-material", order: -100, inject: materialInject },
    Dock,
  );
  register(
    "conversation.composer.dock",
    { id: "learnbuddy-runtime", order: 100 },
    () => embedded ? null :
      h(
        "div",
        { className: "lb-dsh-status" },
        h("span", { className: "lb-dsh-status-dot" }),
        embedded
          ? "LearnBuddy · 学习对话"
          : "DSH 原生会话 · 模型以当前选择为准",
      ),
  );
};
