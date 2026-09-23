import { describe, expect, it } from "vitest";
import { findEvidenceSpans } from "./evidence-highlight";

describe("evidence highlighting", () => {
  it("locates separate verbatim sentences without highlighting omitted text", () => {
    const report = "Environment: Ubuntu 22.04, Python 3.11. A setup note follows. Run command: python3 lab.py --capacity 5.";
    const quote = "Environment: Ubuntu 22.04, Python 3.11. Run command: python3 lab.py --capacity 5.";
    const spans = findEvidenceSpans(report, quote);
    expect(spans.map(({ start, end }) => report.slice(start, end))).toEqual([
      "Environment: Ubuntu 22.04, Python 3.11.",
      "Run command: python3 lab.py --capacity 5.",
    ]);
  });

  it("does not invent a location for absent evidence", () => {
    expect(findEvidenceSpans("Only observed SYN.", "Observed RST and ACK.")).toEqual([]);
  });
});
