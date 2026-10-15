import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import fetch from "node-fetch";
import { extractPdfText, findName, findSummary, NAME_SEARCH_LINES } from "./pdf-text.js";

const RESUME_PATH = process.env.RESUME;
const API_KEY = process.env.RESUME_PARSER_API_KEY;
const API_URL = "https://api.apilayer.com/resume_parser/upload";

/** Minimum score to be considered ATS-passing when the caller sets no threshold */
export const DEFAULT_PASSING_SCORE = 70;

/**
 * Reads the ATS_THRESHOLD input. Empty means the default, so callers that
 * never heard of the input keep passing at 70.
 * @param {string | undefined} raw
 * @returns {number} integer 0-100
 * @throws {Error} naming the bad value
 */
export function parseThreshold(raw) {
  const text = (raw ?? "").trim();
  if (text === "") {
    return DEFAULT_PASSING_SCORE;
  }
  const value = Number(text);
  if (!/^\d+$/.test(text) || value > 100) {
    throw new Error(
      `ATS_THRESHOLD must be an integer from 0 to 100, received "${raw}"`,
    );
  }
  return value;
}

/**
 * Name that tells this resume's PR comment apart from other resumes' on the
 * same PR: the explicit COMMENT_KEY, else the filename without its extension.
 * pr-comment slugifies it into the marker.
 * @param {string} resumePath
 * @param {string | undefined} commentKey
 * @returns {string}
 */
export function commentKeyFor(resumePath, commentKey) {
  if (commentKey?.trim()) {
    return commentKey.trim();
  }
  return path.basename(resumePath ?? "", path.extname(resumePath ?? ""));
}

/**
 * Uploads the resume PDF to the APILayer Resume Parser and returns the parsed data.
 * @see https://blog.apilayer.com/everything-you-need-to-know-for-the-resume-parser-api/
 * @returns {Promise<{ data: Object, fileBuffer: Buffer }>} Parsed resume JSON from the API, and the PDF bytes
 */
async function parseResume() {
  if (!RESUME_PATH || !fs.existsSync(RESUME_PATH)) {
    core.setFailed(`Resume file not found at path: ${RESUME_PATH}`);
    process.exit(1);
  }

  if (!API_KEY) {
    core.setFailed("RESUME_PARSER_API_KEY is not set.");
    process.exit(1);
  }

  const fileBuffer = fs.readFileSync(RESUME_PATH);

  core.info(`Uploading resume: ${path.basename(RESUME_PATH)}`);

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      apikey: API_KEY,
      "Content-Type": "application/octet-stream",
    },
    body: fileBuffer,
  });

  if (!response.ok) {
    const errText = await response.text();
    core.setFailed(`Resume Parser API error (${response.status}): ${errText}`);
    process.exit(1);
  }

  return { data: await response.json(), fileBuffer };
}

/** Oldest start year a real resume entry plausibly has. */
export const MIN_PLAUSIBLE_YEAR = 1990;

/** Share of experience entries that must carry a plausible date for full date credit. */
export const DATE_FULL_CREDIT_SHARE = 0.75;

/**
 * Every date string the parser may attach to an experience entry. The API
 * returns `dates` (array), `date_start` and `date_end`; the older
 * start_date/end_date/date_range names stay as fallbacks.
 * @param {Object} entry
 * @returns {string[]}
 */
export function entryDateStrings(entry) {
  const raw = [
    ...(Array.isArray(entry?.dates) ? entry.dates : [entry?.dates]),
    entry?.date_start,
    entry?.date_end,
    entry?.start_date,
    entry?.end_date,
    entry?.date_range,
  ];
  return raw.filter((d) => typeof d === "string" && d.trim() !== "");
}

/**
 * True when an entry has a date a person could have written: a four-digit
 * year from MIN_PLAUSIBLE_YEAR through next year. The parser turns phone
 * digits and stray numbers into dates like "March 1978", so a bare "has a
 * date" check passes junk.
 * @param {Object} entry
 * @param {number} [now] - epoch ms, injectable for tests
 * @returns {boolean}
 */
export function hasPlausibleDate(entry, now = Date.now()) {
  const maxYear = new Date(now).getUTCFullYear() + 1;
  return entryDateStrings(entry).some((d) =>
    [...d.matchAll(/\b(19|20)\d{2}\b/g)].some((m) => {
      const year = Number(m[0]);
      return year >= MIN_PLAUSIBLE_YEAR && year <= maxYear;
    }),
  );
}

/**
 * Scores the parsed resume data for ATS compatibility.
 *
 * Scoring rubric (100 points total):
 *   - Contact info present (name, email, phone)   → 15 pts
 *   - Work experience section present              → 20 pts
 *   - Education section present                    → 15 pts
 *   - Skills section present                       → 15 pts
 *   - No graphics / images detected (plain text)  → 10 pts  (inferred from parse quality)
 *   - Date ranges on experience entries            → 10 pts  (full at 75% of entries with a plausible date, 5 for any)
 *   - Job titles present on experience entries     → 10 pts
 *   - Summary / objective section present          → 5 pts
 *
 * The API returns no summary and a null name, so those two read the PDF's own
 * text (`pdfText`) when the API fields are empty.
 *
 * @param {Object} data - Parsed resume data from the API
 * @param {string} [pdfText] - Text extracted from the PDF
 * @returns {{ score: number, breakdown: Object, issues: string[] }}
 */
export function scoreResume(data, pdfText = "") {
  let score = 0;
  const issues = [];
  const breakdown = {};

  // Contact info (15 pts)
  const hasName = Boolean(data.name?.trim() || findName(pdfText));
  const hasEmail = Array.isArray(data.email)
    ? data.email.length > 0
    : Boolean(data.email?.trim());
  const hasPhone = Array.isArray(data.phone)
    ? data.phone.length > 0
    : Boolean(data.phone?.trim());
  const contactScore =
    (hasName ? 5 : 0) + (hasEmail ? 5 : 0) + (hasPhone ? 5 : 0);
  score += contactScore;
  breakdown["Contact Info"] = `${contactScore}/15`;
  if (!hasName)
    issues.push(
      `Missing candidate name. Looked for the parser's name field, then 2 to 4 alphabetic words on one of the first ${NAME_SEARCH_LINES} lines of the PDF text.`,
    );
  if (!hasEmail) issues.push("Missing email address.");
  if (!hasPhone) issues.push("Missing phone number.");

  // Work experience (20 pts)
  const experience = data.experience ?? [];
  const hasExperience = experience.length > 0;
  const expScore = hasExperience ? 20 : 0;
  score += expScore;
  breakdown["Work Experience"] = `${expScore}/20`;
  if (!hasExperience) issues.push("No work experience section detected.");

  // Education (15 pts)
  const education = data.education ?? [];
  const hasEducation = education.length > 0;
  const eduScore = hasEducation ? 15 : 0;
  score += eduScore;
  breakdown["Education"] = `${eduScore}/15`;
  if (!hasEducation) issues.push("No education section detected.");

  // Skills (15 pts)
  const skills = data.skills ?? [];
  const hasSkills = skills.length > 0;
  const skillsScore = hasSkills ? 15 : 0;
  score += skillsScore;
  breakdown["Skills"] = `${skillsScore}/15`;
  if (!hasSkills)
    issues.push(
      "No skills section detected — ATS systems rely heavily on keyword matching.",
    );

  // Plain-text parseable (10 pts) — inferred: if API returned structured data, it's text-based
  const parseable = hasName || hasExperience || hasEducation || hasSkills;
  const parseScore = parseable ? 10 : 0;
  score += parseScore;
  breakdown["Plain Text / Parseable"] = `${parseScore}/10`;
  if (!parseable)
    issues.push(
      "Resume may be image-based or heavily graphical — ATS systems cannot read it.",
    );

  // Date ranges on experience entries (10 pts)
  const entriesWithDates = experience.filter((e) => hasPlausibleDate(e));
  const dateShare = hasExperience ? entriesWithDates.length / experience.length : 0;
  const dateScore =
    dateShare >= DATE_FULL_CREDIT_SHARE ? 10 : entriesWithDates.length > 0 ? 5 : 0;
  score += dateScore;
  breakdown["Experience Date Ranges"] = `${dateScore}/10`;
  if (hasExperience && dateScore < 10) {
    issues.push(
      `Only ${entriesWithDates.length} of ${experience.length} experience entries have a date from ${MIN_PLAUSIBLE_YEAR} to next year (looked at the parser's dates, date_start and date_end). Full credit needs ${DATE_FULL_CREDIT_SHARE * 100}%.`,
    );
  }

  // Job titles on experience entries (10 pts)
  const entriesWithTitles = experience.filter((e) => e.title?.trim());
  const titleScore =
    hasExperience && entriesWithTitles.length === experience.length
      ? 10
      : hasExperience && entriesWithTitles.length > 0
        ? 5
        : 0;
  score += titleScore;
  breakdown["Experience Job Titles"] = `${titleScore}/10`;
  if (hasExperience && entriesWithTitles.length < experience.length) {
    issues.push("Some experience entries are missing job titles.");
  }

  // Summary / objective (5 pts)
  const hasSummary = Boolean(
    data.summary?.trim() || data.objective?.trim() || findSummary(pdfText),
  );
  const summaryScore = hasSummary ? 5 : 0;
  score += summaryScore;
  breakdown["Summary / Objective"] = `${summaryScore}/5`;
  if (!hasSummary)
    issues.push(
      "Consider adding a professional summary or objective (not required but helps ATS ranking). Looked for a SUMMARY, PROFILE, OBJECTIVE or ABOUT heading followed by text in the PDF.",
    );

  return { score, breakdown, issues };
}

/**
 * Builds a markdown report from the score results.
 * @param {number} score
 * @param {Object} breakdown
 * @param {string[]} issues
 * @param {boolean} passed
 * @param {number} [threshold] - minimum passing score
 * @returns {string}
 */
export function buildMarkdownReport(
  score,
  breakdown,
  issues,
  passed,
  threshold = DEFAULT_PASSING_SCORE,
) {
  const badge = passed ? "✅ PASSED" : "❌ NEEDS WORK";
  const lines = [
    `# ATS Compatibility Report ${badge}`,
    "",
    `**Overall Score: ${score}/100**`,
    "",
    "## Score Breakdown",
    "",
    "| Category | Score |",
    "|---|---|",
    ...Object.entries(breakdown).map(([k, v]) => `| ${k} | ${v} |`),
    "",
  ];

  if (issues.length > 0) {
    lines.push("## Issues & Recommendations", "");
    issues.forEach((issue) => lines.push(`- ${issue}`));
    lines.push("");
  } else {
    lines.push(
      "## ✅ No Issues Found",
      "",
      "Your resume is well-structured for ATS systems.",
      "",
    );
  }

  lines.push(`_Passing threshold: ${threshold}/100_`);
  return lines.join("\n");
}

// --- Main ---
// Only self-execute as the action entrypoint; importing this module for tests
// must not fire a live network request against the resume parser API. Same
// guard as markdown-checks/spellcheck/index.js.
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  try {
    const threshold = parseThreshold(process.env.ATS_THRESHOLD);
    const { data, fileBuffer } = await parseResume();

    core.info("Resume parsed successfully. Scoring ATS compatibility...");

    // The API gives no name or summary, so read the PDF's text. A PDF pdfjs
    // cannot read falls back to the API fields alone rather than failing.
    let pdfText = "";
    try {
      pdfText = await extractPdfText(fileBuffer);
    } catch (e) {
      core.warning(`Could not read text from the PDF: ${e}`);
    }

    const { score, breakdown, issues } = scoreResume(data, pdfText);
    const passed = score >= threshold;
    const report = buildMarkdownReport(
      score,
      breakdown,
      issues,
      passed,
      threshold,
    );

    core.info(`\n${report}`);

    core.setOutput("ATS_SCORE", String(score));
    core.setOutput("ATS_REPORT", report);
    core.setOutput("ATS_PASSED", String(passed));
    // Not declared as action outputs: they ride along in the outputs JSON
    // that pr-comment reads, naming the resume in the heading and the marker.
    core.setOutput("ATS_RESUME", path.basename(RESUME_PATH));
    core.setOutput(
      "ATS_COMMENT_KEY",
      commentKeyFor(RESUME_PATH, process.env.COMMENT_KEY),
    );

    if (!passed) {
      core.warning(
        `ATS score ${score}/100 is below the passing threshold of ${threshold}.`,
      );
    } else {
      core.notice(`ATS score ${score}/100 — passed!`);
    }
  } catch (e) {
    core.setFailed(`ATS Check action failed: ${e}`);
    console.error("Error:", e);
  }
}
