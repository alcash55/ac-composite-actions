import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { scoreResume, hasPlausibleDate, entryDateStrings } from "./index.js";
import { extractPdfText, findName, findSummary, findExperienceEntries, hasDateRange } from "./pdf-text.js";

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

  it("with no readable PDF text, the API fallback counts 2 of 7 real-response entries as dated: 5/10", () => {
    const { breakdown, issues } = scoreResume(REAL_RESPONSE, "", NOW);

    expect(breakdown["Experience Date Ranges"], "real response, 2 of 7 plausible dates, no PDF text").toBe("5/10");
    expect(issues.join("\n")).toContain("5 of 7 experience entries have no date range");
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
  it("reaches 100 on the real response plus the PDF text: sections, jobs and name come from the text", () => {
    const { score, breakdown, issues } = scoreResume(REAL_RESPONSE, RESUME_TEXT, NOW);

    expect(breakdown["Contact Info"], "name null in the API, 'JANE DOE' in the text").toBe("15/15");
    expect(breakdown["Experience Date Ranges"], "3 jobs, each with a range in the text").toBe("10/10");
    expect(score, JSON.stringify(breakdown)).toBe(100);
    expect(issues).toEqual([]);
  });

  it("without the PDF text the same response loses the name and summary, and Issues says what was searched", () => {
    const { score, issues } = scoreResume(REAL_RESPONSE, "", NOW);

    // API fallback: dates 5/10 (2 of 7), no name, no summary.
    expect(score, "100 minus 5 dates, 5 name, 5 summary").toBe(85);
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

describe("date ranges read from the PDF text", () => {
  it.each([
    ["8/2024 - 9/2026", true],
    ["Apr 2023 - Jun 2024", true],
    ["April 2023 \u2013 June 2024", true],
    ["2021 \u2014 Present", true],
    ["2021 - Present", true],
    ["Jan 2020 to Mar 2022", true],
    ["Software Engineer  7/2021 - 4/2023", true],
    ["5/2021 Masters of Science", false], // one date, a graduation, not a range
    ["March 1978 - May 1979", false], // before 1990
    ["2030 - 2031", false], // after next year
    ["2024 - 2020", false], // ends before it starts
    ["+1 614 593 6899", false],
  ])("hasDateRange(%j) is %s", (line, expected) => {
    expect(hasDateRange(line, NOW), `line ${JSON.stringify(line)}`).toBe(expected);
  });

  it("finds every job in the real layout and its range, ignoring education and leadership dates", () => {
    const { entries } = findExperienceEntries(RESUME_TEXT, NOW);

    expect(entries.map((e) => e.label)).toEqual([
      "Software Engineer Example Energy",
      "Software Engineer II Sample Corporation",
      "Software Engineer Sample Corporation",
    ]);
    expect(entries.every((e) => e.hasDate && e.hasTitle), JSON.stringify(entries)).toBe(true);
  });

  it("reads the title-then-range layout, with the range on the title line or the next line", () => {
    const text = [
      "EXPERIENCE",
      "Backend Developer, Acme Corp  Jan 2020 - Mar 2022",
      "- Built the billing service",
      "Senior Developer Initech",
      "2022 - Present",
      "- Led the platform team",
      "EDUCATION",
      "State University 2016 - 2020",
    ].join("\n");
    const { entries } = findExperienceEntries(text, NOW);

    expect(entries, JSON.stringify(entries)).toHaveLength(2);
    expect(entries.every((e) => e.hasDate && e.hasTitle)).toBe(true);
  });

  it("loses date points when a job has no range, even though education and other jobs have dates", () => {
    const lines = RESUME_TEXT.split("\n").filter((l) => l !== "4/2023 - 6/2024");
    const text = lines.join("\n");
    const { score, breakdown, issues } = scoreResume(REAL_RESPONSE, text, NOW);

    expect(breakdown["Experience Date Ranges"], "3 jobs, the middle one has its range removed").toBe("5/10");
    expect(score, JSON.stringify(breakdown)).toBe(95);
    expect(issues.join("\n")).toContain("1 of 3 experience entries have no date range (Software Engineer II Sample Corporation)");
  });

  it("scores 0 date points when no job has a range", () => {
    const text = RESUME_TEXT.replace(/^\d{1,2}\/\d{4} - \d{1,2}\/\d{4}\n/gm, "");
    const { breakdown } = scoreResume(REAL_RESPONSE, text, NOW);

    expect(breakdown["Experience Date Ranges"], "all three job ranges removed").toBe("0/10");
  });

  it("loses title points when a range has no title beside it", () => {
    const text = RESUME_TEXT.replace("Software Engineer II Sample Corporation\n", "Sample Corporation\n");
    const { breakdown, issues } = scoreResume(REAL_RESPONSE, text, NOW);

    expect(breakdown["Experience Job Titles"]).toBe("5/10");
    expect(issues.join("\n")).toContain("1 of 3 experience entries have no job title");
  });
});

describe("sections and job entries come from the text, not the parser's inventions", () => {
  it("does not count the parser's junk entries (organization SUMMARY, CI) as work experience", () => {
    const text = RESUME_TEXT.replace(/EXPERIENCE[\s\S]*?EDUCATION/, "EDUCATION");
    const { breakdown, issues } = scoreResume(REAL_RESPONSE, text, NOW);

    expect(breakdown["Work Experience"], "7 API entries, no EXPERIENCE section in the text").toBe("0/20");
    expect(issues.join("\n")).toContain("No work experience entries detected. Looked for an EXPERIENCE");
  });

  it("does not count the parser's 'Middle School' education entry when there is no EDUCATION heading", () => {
    const text = RESUME_TEXT.replace(/EDUCATION[\s\S]*?LEADERSHIP/, "LEADERSHIP");
    const { breakdown } = scoreResume(REAL_RESPONSE, text, NOW);

    expect(breakdown["Education"], "API has education entries, the text has no EDUCATION section").toBe("0/15");
  });

  it("requires text under the SKILLS heading", () => {
    const text = RESUME_TEXT.replace(/SKILLS[\s\S]*?EXPERIENCE/, "SKILLS\nEXPERIENCE");
    const { breakdown } = scoreResume(REAL_RESPONSE, text, NOW);

    expect(breakdown["Skills"], "API has skills, the SKILLS section in the text is empty").toBe("0/15");
  });

  it("scores an image-only PDF (no text) from the API fallback and not as parseable by text", () => {
    const { breakdown } = scoreResume({}, "", NOW);

    expect(breakdown["Plain Text / Parseable"]).toBe("0/10");
  });
});
