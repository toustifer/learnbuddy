export interface EvidenceSpan {
  start: number;
  end: number;
}

/** Only highlight excerpts that occur verbatim in the parsed report. */
export function findEvidenceSpans(paragraph: string, evidence: string): EvidenceSpan[] {
  const source = paragraph.toLocaleLowerCase();
  const quote = evidence.trim().replace(/^[“"']+|[”"']+$/g, "");
  if (!source || !quote) return [];

  const locate = (part: string): EvidenceSpan | null => {
    const start = source.indexOf(part.toLocaleLowerCase());
    return start < 0 ? null : { start, end: start + part.length };
  };

  const whole = locate(quote);
  if (whole) return [whole];

  // Models often join several real but non-adjacent sentences into one evidence field.
  // Match each sentence independently; never mark text that is absent from the report.
  const fragments = quote.split(/(?<=[.;!?。；！？])\s+/).map((part) => part.trim()).filter((part) => part.length >= 12);
  const spans = fragments.map(locate).filter((span): span is EvidenceSpan => span !== null);
  return spans.sort((a, b) => a.start - b.start).filter((span, index, all) => index === 0 || span.start >= all[index - 1].end);
}
