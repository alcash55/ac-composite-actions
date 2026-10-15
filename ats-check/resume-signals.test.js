import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { scoreResume, hasPlausibleDate, entryDateStrings } from "./index.js";
import { extractPdfText, findName, findSummary } from "./pdf-text.js";

// apilayer-fullstack.json is a real Resume Parser response (email and phone
// swapped for placeholders). It shows the parser's actual shape: name null, no
// summary key, dates under `dates`, and junk entries such as organization
// "SUMMARY" and a "March 1978" date made from phone digits.
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
const REAL_RESPONSE = JSON.parse(fixture("apilayer-fullstack.json"));
const RESUME_TEXT = fixture("resume-text.txt");
const NOW = Date.UTC(2026, 9, 14);

/** Builds a one-page text PDF, one line per entry, so extraction is tested on a real PDF. */
function buildPdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, "\\$&");
  const stream = `BT /F1 12 Tf 14 TL 50 750 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => (body += `${String(o).padStart(10, "0")} 00000 n \n`));
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, "latin1");
}

describe("experience dates from the real API shape", () => {
  it("reads `dates`, `date_start` and `date_end`, and still the old key names", () => {
    expect(entryDateStrings({ dates: ["February 2022"] })).toEqual(["February 2022"]);
    expect(entryDateStrings({ date_start: "May 2020", date_end: "Present" })).toEqual(["May 2020", "Present"]);
    expect(entryDateStrings({ start_date: "2019", date_range: "2019 - 2021" })).toEqual(["2019", "2019 - 2021"]);
    expect(entryDateStrings({ title: "Engineer" })).toEqual([]);
  });

  it.each([
    [["March 1978"], false, "phone digits parsed as a date, before 1990"],
    [["February 2002"], true, "in range"],
    [["January 2028"], false, "after next year (now is 2026)"],
    [["January 2027"], true, "next year is allowed"],
    [["Present"], false, "no year at all"],
  ])("hasPlausibleDate(%j) is %s (%s)", (dates, expected, why) => {
    expect(hasPlausibleDate({ dates }, NOW), `dates ${JSON.stringify(dates)}: ${why}`).toBe(expected);
  });

  it("scores the real response: 2 of 7 entries have a plausible date, so 5/10 with the count in Issues", () => {
    const { breakdown, issues } = scoreResume(REAL_RESPONSE, RESUME_TEXT);

    expect(breakdown["Experience Date Ranges"], "real response, 2 of 7 plausible dates").toBe("5/10");
    expect(issues.join("\n")).toContain("Only 2 of 7 experience entries have a date from 1990 to next year");
  });

  it("gives full date credit at 75% of entries even when the parser invents one junk entry", () => {
    const real = (dates) => ({ title: "Engineer", dates });
    const { breakdown } = scoreResume(
      {
        ...REAL_RESPONSE,
        experience: [real(["March 2020"]), real(["May 2021"]), real(["June 2022"]), real(["March 1978"])],
      },
      RESUME_TEXT,
    );

    expect(breakdown["Experience Date Ranges"], "3 of 4 plausible").toBe("10/10");
  });
});

describe("findName", () => {
  it.each([
    ["Jane Doe\njane@example.com", "Jane Doe"],
    ["JANE DOE\nSoftware Engineer", "JANE DOE"],
    ["JANE\nDOE\nSoftware Engineer\nSpringfield, IL", "JANE DOE"],
    ["Software Engineer\nJane Q Doe\n555 010 0100", "Jane Q Doe"],
    ["\n\n  Zoë O'Neil-Smith  \n", "Zoë O'Neil-Smith"],
  ])("finds the name in %j", (text, expected) => {
    expect(findName(text), `text ${JSON.stringify(text)}`).toBe(expected);
  });

  it.each([
    ["SUMMARY\nSoftware engineer who builds things"],
    ["jane@example.com\n+1 555 010 0100\ngithub.com/janedoe"],
    ["Springfield, IL\nWork Experience\nEducation"],
    ["a\nb\nc\nd\ne\nf\nJane Doe"],
    [""],
  ])("returns null for %j", (text) => {
    expect(findName(text), `text ${JSON.stringify(text)}`).toBeNull();
  });
});

describe("findSummary", () => {
  it.each([
    ["SUMMARY\nBuilds things.", "Builds things."],
    ["Profile:\nBuilds things.", "Builds things."],
    ["Professional Summary\nBuilds things.", "Builds things."],
    ["objective\nA role.", "A role."],
    ["ABOUT\nBuilds things.", "Builds things."],
  ])("finds the text under the heading in %j", (text, expected) => {
    expect(findSummary(text), `text ${JSON.stringify(text)}`).toBe(expected);
  });

  it.each([
    ["SUMMARY"], // heading with nothing under it
    ["SUMMARY\nSKILLS\n- Go"], // empty section
    ["I wrote a summary of my work here.\nGo"], // the word inside a sentence is not a heading
    ["EXPERIENCE\nEngineer"],
  ])("returns null for %j", (text) => {
    expect(findSummary(text), `text ${JSON.stringify(text)}`).toBeNull();
  });
});

describe("scoreResume with PDF text", () => {
  it("reaches 95 on the real response: name and summary come from the PDF text, dates stay at 5/10", () => {
    const { score, breakdown, issues } = scoreResume(REAL_RESPONSE, RESUME_TEXT);

    expect(breakdown["Contact Info"], "name null in the API, 'JANE DOE' in the text").toBe("15/15");
    expect(breakdown["Summary / Objective"]).toBe("5/5");
    expect(score, JSON.stringify(breakdown)).toBe(95);
    expect(issues.some((i) => i.startsWith("Missing candidate name"))).toBe(false);
  });

  it("without the PDF text the same response loses the name and summary, and Issues says what was searched", () => {
    const { score, issues } = scoreResume(REAL_RESPONSE, "");

    expect(score, "95 minus 5 for name and 5 for summary").toBe(85);
    expect(issues.join("\n")).toContain("Looked for the parser's name field, then 2 to 4 alphabetic words on one of the first 6 lines");
    expect(issues.join("\n")).toContain("SUMMARY, PROFILE, OBJECTIVE or ABOUT heading followed by text");
  });

  it("prefers a non-null API name over the text", () => {
    const { breakdown } = scoreResume({ ...REAL_RESPONSE, name: "Jane Doe" }, "");

    expect(breakdown["Contact Info"]).toBe("15/15");
  });
});

describe("extractPdfText on a real PDF", () => {
  it("returns the lines in order, and findName/findSummary work on them", async () => {
    const pdf = buildPdf(["JANE DOE", "jane@example.com", "SUMMARY", "Builds trading software.", "SKILLS", "Go"]);
    const text = await extractPdfText(pdf);

    expect(findName(text), `extracted text ${JSON.stringify(text)}`).toBe("JANE DOE");
    expect(findSummary(text), `extracted text ${JSON.stringify(text)}`).toBe("Builds trading software.");
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(extractPdfText(Buffer.from("not a pdf"))).rejects.toThrow();
  });
});
