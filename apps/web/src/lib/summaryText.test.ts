import { describe, expect, it } from "vitest";

import { parseInline, parseSummary } from "./summaryText";

describe("summary text", () => {
  it("reads paragraphs, lists and bold", () => {
    const blocks = parseSummary("The venue moved to **Hall B**.\nNothing else changed.\n\n- Confirm by **Friday**\n- Bring the badge\n  printed\n1. First\n2. Second");
    expect(blocks).toEqual([
      {
        kind: "paragraph",
        lines: [
          [
            { text: "The venue moved to ", bold: false },
            { text: "Hall B", bold: true },
            { text: ".", bold: false },
          ],
          [{ text: "Nothing else changed.", bold: false }],
        ],
      },
      {
        kind: "list",
        ordered: false,
        items: [
          [
            { text: "Confirm by ", bold: false },
            { text: "Friday", bold: true },
          ],
          [
            { text: "Bring the badge", bold: false },
            { text: " printed", bold: false },
          ],
        ],
      },
      { kind: "list", ordered: true, items: [[{ text: "First", bold: false }], [{ text: "Second", bold: false }]] },
    ]);
  });

  it("keeps markup it doesn't know as text", () => {
    expect(parseInline("<b>hi</b> **open")).toEqual([{ text: "<b>hi</b> **open", bold: false }]);
    expect(parseSummary("\n\n")).toEqual([]);
  });
});
