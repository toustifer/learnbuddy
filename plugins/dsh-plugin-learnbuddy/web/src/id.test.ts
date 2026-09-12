import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createId } from "./id";

afterEach(() => vi.unstubAllGlobals());

it("uses the browser UUID implementation when available", () => {
  const randomUUID = vi.fn(() => "8926591f-095c-46b4-83d8-60d5b7e50f09");
  vi.stubGlobal("crypto", { randomUUID });
  expect(createId()).toBe("8926591f-095c-46b4-83d8-60d5b7e50f09");
  expect(randomUUID).toHaveBeenCalledOnce();
});

it("keeps reference and draft IDs usable on HTTP without randomUUID", () => {
  vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const ids = Array.from({ length: 1000 }, createId);
  expect(new Set(ids).size).toBe(1000);
  expect(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true);
});
