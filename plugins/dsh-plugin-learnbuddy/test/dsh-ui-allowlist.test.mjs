import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import vm from "node:vm";
import { apply, parseAllowedHosts } from "../web/dsh-ui/host.js";

const clientSource = await readFile(
  new URL("../web/dsh-ui/client.cjs", import.meta.url),
  "utf8",
);
const distUrl = new URL("../web/dsh-ui/dist/client.js", import.meta.url);
const PUBLIC = "learn1learn.stifer.xyz";
const PUBLIC_IP = "129.204.52.57";

/**
 * Load the browser bundle in a real V8 context. `client.cjs` is a classic
 * sloppy-mode script, so its top-level declarations land on the context's
 * globalThis: `isHostAllowed` and `canOpenPreviewWorkspace` are exactly the
 * functions the page runs. `location` is a WHATWG URL, which carries the same
 * hostname/port/protocol/origin readings the browser exposes.
 */
function loadClient({
  href = `https://${PUBLIC}/learnbuddy/?learnbuddy=embedded`,
  injected,
} = {}) {
  const exports = {};
  const context = vm.createContext({
    URL,
    require: (id) => {
      assert.equal(id, "react", `unexpected host module: ${id}`);
      return { createElement: () => null };
    },
    module: { exports },
    exports,
    window: { parent: {} },
    location: new URL(href),
  });
  if (injected !== undefined) context.__LEARNBUDDY_UI__ = injected;
  new vm.Script(clientSource, { filename: "client.cjs" }).runInContext(context);
  return context;
}

describe("LearnBuddy host allowlist: security default", () => {
  it("allows only the local hosts when the host injects nothing", () => {
    const client = loadClient();
    assert.equal(client.isHostAllowed("127.0.0.1"), true);
    assert.equal(client.isHostAllowed("localhost"), true);
    assert.equal(client.isHostAllowed(PUBLIC), false);
    assert.equal(client.isHostAllowed(PUBLIC_IP), false);
  });

  it("keeps the local-only default for an empty list", () => {
    const client = loadClient({ injected: { allowedHosts: [] } });
    assert.equal(client.isHostAllowed("localhost"), true);
    assert.equal(client.isHostAllowed(PUBLIC), false);
  });

  it("keeps the local-only default when every configured entry is invalid", () => {
    const client = loadClient({
      injected: {
        allowedHosts: ["", "   ", "https://evil.example", "evil.example:8443", "*", "*.stifer.xyz", "a b"],
      },
    });
    assert.equal(client.isHostAllowed("127.0.0.1"), true);
    assert.equal(client.isHostAllowed(PUBLIC), false);
    assert.equal(client.isHostAllowed("evil.example"), false);
    assert.equal(client.isHostAllowed("*.stifer.xyz"), false);
  });

  it("keeps the local-only default for a non-array configuration", () => {
    for (const allowedHosts of ["learn1learn.stifer.xyz", 42, null, {}]) {
      const client = loadClient({ injected: { allowedHosts } });
      assert.equal(client.isHostAllowed(PUBLIC), false, `allowedHosts=${String(allowedHosts)}`);
      assert.equal(client.isHostAllowed("localhost"), true);
    }
  });
});

describe("LearnBuddy host allowlist: configured hosts", () => {
  const injected = { allowedHosts: [PUBLIC, PUBLIC_IP] };

  it("allows an explicitly configured public host without dropping the local ones", () => {
    const client = loadClient({ injected });
    assert.equal(client.isHostAllowed(PUBLIC), true);
    assert.equal(client.isHostAllowed(PUBLIC_IP), true);
    assert.equal(client.isHostAllowed("127.0.0.1"), true);
    assert.equal(client.isHostAllowed("localhost"), true);
  });

  it("still rejects a host that is not in the configured list", () => {
    const client = loadClient({ injected });
    assert.equal(client.isHostAllowed("evil.example"), false);
    assert.equal(client.isHostAllowed("stifer.xyz"), false);
    assert.equal(client.isHostAllowed(`${PUBLIC}.evil.example`), false);
  });

  it("normalizes case, surrounding blanks, duplicates, and rejects ports", () => {
    const client = loadClient({
      injected: { allowedHosts: [`  ${PUBLIC.toUpperCase()}  `, PUBLIC, `${PUBLIC}:3088`, ""] },
    });
    assert.equal(client.isHostAllowed(PUBLIC), true);
    assert.equal(client.isHostAllowed(PUBLIC.toUpperCase()), true);
    assert.equal(client.isHostAllowed(` ${PUBLIC} `), true);
    assert.equal(client.isHostAllowed(PUBLIC_IP), false);
  });

  it("treats empty and non-string hostnames as denied", () => {
    const client = loadClient({ injected });
    for (const hostname of ["", "   ", undefined, null, 42, { hostname: PUBLIC }]) {
      assert.equal(client.isHostAllowed(hostname), false, `hostname=${String(hostname)}`);
    }
  });

  it("never accepts a scheme, port, or path smuggled into the hostname", () => {
    const client = loadClient({ injected });
    for (const hostname of [
      `https://${PUBLIC}`,
      `${PUBLIC}:443`,
      `${PUBLIC}/learnbuddy/`,
      `${PUBLIC}:3088`,
      PUBLIC_IP + ":3088",
    ])
      assert.equal(client.isHostAllowed(hostname), false, `hostname=${hostname}`);
  });
});

describe("LearnBuddy host allowlist: protocol and port independence", () => {
  const injected = {
    previewWorkspace: "/srv/learnbuddy/preview/workspace",
    allowedHosts: [PUBLIC, PUBLIC_IP],
  };

  it("decides on the hostname alone, whatever the deployment port or scheme is", () => {
    for (const href of [
      `http://${PUBLIC_IP}:3088/learnbuddy/?learnbuddy=embedded`,
      `https://${PUBLIC}/learnbuddy/?learnbuddy=embedded`,
      `http://${PUBLIC}:3089/learnbuddy/?learnbuddy=embedded`,
      `http://127.0.0.1:3089/learnbuddy/?learnbuddy=embedded`,
    ]) {
      const client = loadClient({ href, injected });
      assert.equal(client.canOpenPreviewWorkspace(), true, href);
    }
  });

  it("keeps denying a host outside the list on every port", () => {
    for (const href of [
      "http://other.example:3088/learnbuddy/?learnbuddy=embedded",
      "http://127.0.0.2:3089/learnbuddy/?learnbuddy=embedded",
      `https://${PUBLIC}/learnbuddy/?learnbuddy=embedded`,
    ]) {
      const client = loadClient({
        href,
        injected: { previewWorkspace: "/srv/learnbuddy/preview/workspace", allowedHosts: [PUBLIC_IP] },
      });
      assert.equal(client.canOpenPreviewWorkspace(), false, href);
    }
  });
});

describe("LearnBuddy preview workspace gate", () => {
  const previewWorkspace = "/srv/learnbuddy/preview/workspace";

  it("refuses the injected preview workspace on an unconfigured public host", () => {
    const client = loadClient({ injected: { previewWorkspace } });
    assert.equal(client.canOpenPreviewWorkspace(), false);
  });

  it("opens the injected preview workspace on an allowlisted public host", () => {
    const client = loadClient({ injected: { previewWorkspace, allowedHosts: [PUBLIC] } });
    assert.equal(client.canOpenPreviewWorkspace(), true);
  });

  it("still needs the injected workspace even on an allowlisted host", () => {
    for (const injected of [{ allowedHosts: [PUBLIC, "127.0.0.1"] }, { allowedHosts: [], previewWorkspace: 42 }]) {
      const client = loadClient({ injected });
      assert.equal(client.canOpenPreviewWorkspace(), false);
    }
  });

  it("keeps the local preview working without any configuration", () => {
    for (const href of ["http://127.0.0.1:3089/learnbuddy/", "http://localhost:3089/learnbuddy/"]) {
      const client = loadClient({ href, injected: { previewWorkspace } });
      assert.equal(client.canOpenPreviewWorkspace(), true, href);
    }
  });
});

describe("LearnBuddy host allowlist: source invariants", () => {
  it("routes every host decision through the shared predicate", () => {
    assert.doesNotMatch(clientSource, /location\.hostname\s*===/);
    assert.doesNotMatch(clientSource, /\.includes\(location\.hostname\)/);
    // The only hardcoded localhost pair left is the documented safety default.
    assert.equal((clientSource.match(/\["127\.0\.0\.1", "localhost"\]/g) || []).length, 1);
  });

  it("keeps the built bundle in sync with the source", async (t) => {
    let dist;
    try {
      dist = await readFile(distUrl, "utf8");
    } catch {
      t.skip("dist/client.js 尚未构建；运行 npm run build:dsh 后本用例校验产物与源码一致");
      return;
    }
    assert.ok(dist.includes(clientSource), "dist/client.js 与 client.cjs 不一致，请运行 npm run build:dsh");
    assert.match(dist, /function isHostAllowed/);
  });
});

describe("LearnBuddy allowed hosts from the environment", () => {
  const KEYS = ["LEARNBUDDY_ALLOWED_HOSTS", "LEARNBUDDY_PREVIEW_WORKSPACE"];

  function withEnv(env, run) {
    const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      return run();
    } finally {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  function injectedRows(env) {
    return withEnv(env, () => {
      const listeners = [];
      const ctx = {
        on: (event, handler) => listeners.push([event, handler]),
        effect: () => {},
        webServer: { register: () => {}, tapIndex: () => {} },
      };
      apply(ctx);
      const rows = [];
      for (const [event, handler] of listeners)
        if (event === "webserver/index-inject") handler(rows);
      return rows;
    });
  }

  it("parses a comma separated allowlist into normalized hostnames", () => {
    assert.deepEqual(parseAllowedHosts(`${PUBLIC}, ${PUBLIC_IP}`), [PUBLIC, PUBLIC_IP]);
    assert.deepEqual(parseAllowedHosts(`  ${PUBLIC.toUpperCase()}  `), [PUBLIC]);
    assert.deepEqual(parseAllowedHosts(`${PUBLIC},${PUBLIC}`), [PUBLIC]);
  });

  it("drops empty items and anything that is not a bare hostname", () => {
    assert.deepEqual(
      parseAllowedHosts(
        `,${PUBLIC},,   ,https://evil.example,evil.example:8443,*,*.stifer.xyz,a b,${PUBLIC_IP},`,
      ),
      [PUBLIC, PUBLIC_IP],
    );
  });

  it("returns an empty list for unset, blank, or non-string input", () => {
    for (const raw of [undefined, "", "   ", ",,,", 42, null, {}])
      assert.deepEqual(parseAllowedHosts(raw), [], `raw=${String(raw)}`);
  });

  it("injects nothing when the host configures nothing", () => {
    assert.deepEqual(injectedRows({}), []);
  });

  it("injects the configured allowlist next to the preview workspace", () => {
    const rows = injectedRows({
      LEARNBUDDY_PREVIEW_WORKSPACE: "/srv/learnbuddy/preview/workspace",
      LEARNBUDDY_ALLOWED_HOSTS: `${PUBLIC}, ${PUBLIC_IP}`,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "global");
    assert.equal(rows[0].name, "__LEARNBUDDY_UI__");
    assert.deepEqual(rows[0].value, {
      previewWorkspace: "/srv/learnbuddy/preview/workspace",
      allowedHosts: [PUBLIC, PUBLIC_IP],
    });
  });

  it("injects an allowlist without a preview workspace", () => {
    const rows = injectedRows({ LEARNBUDDY_ALLOWED_HOSTS: PUBLIC });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value.previewWorkspace, undefined);
    assert.deepEqual(rows[0].value.allowedHosts, [PUBLIC]);
  });

  it("keeps the preview-only injection unchanged when no allowlist is set", () => {
    const rows = injectedRows({ LEARNBUDDY_PREVIEW_WORKSPACE: "/srv/preview" });
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(rows[0].value)), {
      previewWorkspace: "/srv/preview",
      allowedHosts: [],
    });
  });

  it("drops a badly formatted allowlist instead of injecting the raw text", () => {
    for (const raw of ["https://" + PUBLIC, PUBLIC + ":3088", "*", "   "]) {
      const rows = injectedRows({ LEARNBUDDY_ALLOWED_HOSTS: raw });
      assert.deepEqual(rows, [], `raw=${raw}`);
    }
  });

  it("never turns an invalid configuration into a public allowlist", () => {
    const rows = injectedRows({ LEARNBUDDY_ALLOWED_HOSTS: "not a host,https://x.example" });
    assert.deepEqual(rows, []);
    const client = loadClient({ injected: { allowedHosts: [] } });
    assert.equal(client.isHostAllowed(PUBLIC), false);
  });
});
