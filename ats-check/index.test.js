import { describe, expect, it } from "vitest";
import {
  scoreResume,
  buildMarkdownReport,
  parseThreshold,
  commentKeyFor,
  DEFAULT_PASSING_SCORE,
} from "./index.js";

// scoreResume and buildMarkdownReport are pure; parseResume and the top-level
// script are not exercised here (see the NODE_ENV/VITEST guard in index.js) —
// they need a live network call to the resume parser API which has no place
// in a unit suite.

const FULL_RESUME = {
  name: "Jane Doe",
  email: "jane@example.com",
  phone: "555-0100",
  experience: [
    { title: "Engineer", start_date: "2020", end_date: "2023" },
    { title: "Senior Engineer", start_date: "2023", end_date: "Present" },
  ],
  education: [{ school: "State University" }],
  skills: ["JavaScript", "Node.js"],
  summary: "Backend engineer with 5 years of experience.",
};

describe("scoreResume", () => {
  it("awards full marks for a fully-populated resume", () => {
    const { score, breakdown, issues } = scoreResume(FULL_RESUME);

    expect(score).toBe(100);
    expect(issues).toHaveLength(0);
    expect(breakdown).toEqual({
      "Contact Info": "15/15",
      "Work Experience": "20/20",
      Education: "15/15",
      Skills: "15/15",
      "Plain Text / Parseable": "10/10",
      "Experience Date Ranges": "10/10",
      "Experience Job Titles": "10/10",
      "Summary / Objective": "5/5",
    });
  });

  it("scores zero and reports every category missing for a blank parse", () => {
    const { score, breakdown, issues } = scoreResume({});

    expect(score).toBe(0);
    expect(breakdown["Contact Info"]).toBe("0/15");
    expect(breakdown["Work Experience"]).toBe("0/20");
    expect(issues.some((i) => i.startsWith("Missing candidate name. Looked for"))).toBe(true);
    expect(issues).toContain("Missing email address.");
    expect(issues).toContain("Missing phone number.");
    expect(issues).toContain("No work experience section detected.");
    expect(issues).toContain("No education section detected.");
    expect(issues).toContain(
      "No skills section detected — ATS systems rely heavily on keyword matching.",
    );
    expect(issues).toContain(
      "Resume may be image-based or heavily graphical — ATS systems cannot read it.",
    );
  });

  it("accepts email/phone as arrays (the API's actual shape) as well as strings", () => {
    const arrayForm = scoreResume({ ...FULL_RESUME, email: ["jane@example.com"], phone: ["555-0100"] });
    const stringForm = scoreResume(FULL_RESUME);

    expect(arrayForm.breakdown["Contact Info"]).toBe(stringForm.breakdown["Contact Info"]);
  });

  it("treats an empty email/phone array as missing, not present", () => {
    const { breakdown, issues } = scoreResume({ ...FULL_RESUME, email: [], phone: [] });

    expect(breakdown["Contact Info"]).toBe("5/15"); // name only
    expect(issues).toContain("Missing email address.");
    expect(issues).toContain("Missing phone number.");
  });

  it("gives partial credit for experience entries missing dates or titles", () => {
    const { breakdown, issues } = scoreResume({
      ...FULL_RESUME,
      experience: [
        { title: "Engineer", start_date: "2020" },
        { title: "Senior Engineer" }, // no dates at all
      ],
    });

    expect(breakdown["Experience Date Ranges"]).toBe("5/10");
    expect(issues.some((i) => i.startsWith("Only 1 of 2 experience entries have a date"))).toBe(true);
    expect(breakdown["Experience Job Titles"]).toBe("10/10"); // both have titles
  });

  it("scores zero date/title credit when no entry has either", () => {
    const { breakdown } = scoreResume({
      ...FULL_RESUME,
      experience: [{ role: "Engineer" }],
    });

    expect(breakdown["Experience Date Ranges"]).toBe("0/10");
    expect(breakdown["Experience Job Titles"]).toBe("0/10");
  });

  it("accepts objective as an alternative to summary", () => {
    const { score } = scoreResume({ ...FULL_RESUME, summary: undefined, objective: "Seeking a role." });

    expect(score).toBe(100);
  });
});

describe("buildMarkdownReport", () => {
  it("marks a passing score with the PASSED badge and omits the issues section", () => {
    const report = buildMarkdownReport(85, { "Contact Info": "15/15" }, [], true);

    expect(report).toContain("✅ PASSED");
    expect(report).toContain("**Overall Score: 85/100**");
    expect(report).toContain("## ✅ No Issues Found");
    expect(report).not.toContain("## Issues & Recommendations");
  });

  it("marks a failing score with the NEEDS WORK badge and lists every issue", () => {
    const report = buildMarkdownReport(40, { "Contact Info": "5/15" }, ["Missing email address."], false);

    expect(report).toContain("❌ NEEDS WORK");
    expect(report).toContain("## Issues & Recommendations");
    expect(report).toContain("- Missing email address.");
    expect(report).not.toContain("## ✅ No Issues Found");
  });

  it("renders the breakdown as a markdown table row per category", () => {
    const report = buildMarkdownReport(70, { Education: "15/15", Skills: "0/15" }, [], true);

    expect(report).toContain("| Education | 15/15 |");
    expect(report).toContain("| Skills | 0/15 |");
  });
});

describe("parseThreshold", () => {
  it("defaults to 70 when the input is empty or unset", () => {
    expect(parseThreshold(undefined)).toBe(DEFAULT_PASSING_SCORE);
    expect(parseThreshold("")).toBe(70);
    expect(parseThreshold("  ")).toBe(70);
  });

  it.each([
    ["0", 0],
    ["85", 85],
    ["100", 100],
    [" 90 ", 90],
  ])("accepts %j as %i", (raw, expected) => {
    expect(parseThreshold(raw), `ATS_THRESHOLD ${JSON.stringify(raw)}`).toBe(expected);
  });

  it.each(["101", "-1", "70.5", "abc", "1e2", "0x10", "70%"])(
    "rejects %j and names it in the error",
    (raw) => {
      expect(() => parseThreshold(raw)).toThrow(
        `ATS_THRESHOLD must be an integer from 0 to 100, received "${raw}"`,
      );
    },
  );
});

describe("threshold in the report", () => {
  it("prints the configured threshold", () => {
    const report = buildMarkdownReport(85, {}, [], true, 90);

    expect(report).toContain("_Passing threshold: 90/100_");
  });

  it("keeps 70 for callers that pass no threshold", () => {
    expect(buildMarkdownReport(85, {}, [], true)).toContain("_Passing threshold: 70/100_");
  });
});

describe("commentKeyFor", () => {
  it("uses the resume filename without its extension", () => {
    expect(commentKeyFor("/work/repo/resume/fullstack.pdf", "")).toBe("fullstack");
    expect(commentKeyFor("/work/repo/resume/frontend.pdf", undefined)).toBe("frontend");
  });

  it("prefers an explicit key", () => {
    expect(commentKeyFor("/work/repo/resume/fullstack.pdf", " mine ")).toBe("mine");
  });
});
