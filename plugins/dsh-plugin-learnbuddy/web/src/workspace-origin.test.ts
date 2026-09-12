import { expect, it } from "vitest";
import { canUseConfiguredWorkspace } from "./workspace-origin";

it("keeps local previews usable without configuring a public site", () => {
  expect(canUseConfiguredWorkspace(undefined, { hostname: "127.0.0.1", origin: "http://127.0.0.1:5178" })).toBe(true);
});
it("requires the exact server-configured origin for a public course workspace", () => {
  const page = { hostname: "129.204.52.57", origin: "http://129.204.52.57:3088" };
  expect(canUseConfiguredWorkspace(undefined, page)).toBe(false);
  expect(canUseConfiguredWorkspace({ publicOrigin: page.origin }, page)).toBe(true);
  expect(canUseConfiguredWorkspace({ publicOrigin: "http://129.204.52.57:3092" }, page)).toBe(false);
  expect(canUseConfiguredWorkspace({ publicOrigin: page.origin }, { ...page, origin: "http://unrelated.example" })).toBe(false);
});
