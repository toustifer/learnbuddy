import { describe, expect, it } from "vitest";
import { buildDshHandoff } from "./dsh";
import { freshState } from "./seed";

describe("DSH material handoff", () => {
  const material = freshState().materials.find((m) => m.id === "mat-tcp")!;
  it("carries the actual example text and question without sending conversation history", () => {
    const handoff = buildDshHandoff({
      material,
      references: [],
      question: "为什么需要第三次握手？",
    });
    expect(handoff.text).toContain("SYN 标志会消耗一个序列号");
    expect(handoff.text).toContain("我的问题：为什么需要第三次握手？");
    expect(handoff.returnPath).toBe("/learnbuddy/#material/mat-tcp");
    expect(handoff).not.toHaveProperty("history");
  });
  it("keeps selected text in scope and does not imply the image was uploaded", () => {
    const handoff = buildDshHandoff({
      material,
      references: [
        {
          id: "selected",
          title: "图 3-1",
          kind: "image",
          detail: "客户端 → 服务器 SYN",
        },
      ],
      question: "解释这张图",
    });
    expect(handoff.text).toContain("图片文件尚未传入");
    expect(handoff.text).toContain("客户端 → 服务器 SYN");
    expect(handoff.text).not.toContain("Wireshark 常默认展示相对序列号");
  });
  it("preserves the question when a reference exceeds the message limit", () => {
    const handoff = buildDshHandoff({
      material,
      references: [
        {
          id: "long",
          title: "选中原文",
          kind: "selection",
          detail: "字".repeat(26000),
        },
      ],
      question: "最后这个问题必须保留",
    });
    expect(handoff.text.length).toBeLessThan(24000);
    expect(handoff.text).toContain("剩余内容未带入");
    expect(handoff.text).toContain("我的问题：最后这个问题必须保留");
  });
  it("does not invent file contents when the source has not been parsed", () => {
    const handoff = buildDshHandoff({
      material: { ...material, sampleKey: undefined, title: "真实课件.pdf" },
      references: [],
      question: "总结课件",
    });
    expect(handoff.text).toContain("原文件尚未通过后端传入 DSH");
    expect(handoff.text).not.toContain("SYN 标志");
  });
});
