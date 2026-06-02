import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import FormData from "form-data";
import fetch from "node-fetch";

const RESUME_PATH = process.env.RESUME;
const API_KEY = process.env.RESUME_PARSER_API_KEY;
const API_URL = "https://api.apilayer.com/resume_parser/upload";

/** Minimum score to be considered ATS-passing */
const PASSING_SCORE = 70;

/**
 * Uploads the resume PDF to the APILayer Resume Parser and returns the parsed data.
 * @see https://blog.apilayer.com/everything-you-need-to-know-for-the-resume-parser-api/
 * @returns {Promise<Object>} Parsed resume JSON from the API
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
  const form = new FormData();
  form.append("file", fileBuffer, {
    filename: path.basename(RESUME_PATH),
    contentType: "application/octet-stream",
  });

  core.info(`Uploading resume: ${path.basename(RESUME_PATH)}`);

  const response = await fetch(API_URL, {
    method: "POST",
    headers: /** @type {Record<string, string>} */ ({
      apikey: API_KEY,
      ...form.getHeaders(),
    }),
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text();
    core.setFailed(`Resume Parser API error (${response.status}): ${errText}`);
    process.exit(1);
  }

  return response.json();
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
 *   - Date ranges on experience entries            → 10 pts
 *   - Job titles present on experience entries     → 10 pts
 *   - Summary / objective section present          → 5 pts
 *
 * @param {Object} data - Parsed resume data from the API
 * @returns {{ score: number, breakdown: Object, issues: string[] }}
 */
export function scoreResume(data) {
  let score = 0;
  const issues = [];
  const breakdown = {};

  // Contact info (15 pts)
  const hasName = Boolean(data.name?.trim());
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
  if (!hasName) issues.push("Missing candidate name.");
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
  const entriesWithDates = experience.filter(
    (e) => e.start_date || e.end_date || e.date_range,
  );
  const dateScore =
    hasExperience && entriesWithDates.length === experience.length
      ? 10
      : hasExperience && entriesWithDates.length > 0
        ? 5
        : 0;
  score += dateScore;
  breakdown["Experience Date Ranges"] = `${dateScore}/10`;
  if (hasExperience && entriesWithDates.length < experience.length) {
    issues.push("Some experience entries are missing date ranges.");
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
  const hasSummary = Boolean(data.summary?.trim() || data.objective?.trim());
  const summaryScore = hasSummary ? 5 : 0;
  score += summaryScore;
  breakdown["Summary / Objective"] = `${summaryScore}/5`;
  if (!hasSummary)
    issues.push(
      "Consider adding a professional summary or objective (not required but helps ATS ranking).",
    );

  return { score, breakdown, issues };
}

/**
 * Builds a markdown report from the score results.
 * @param {number} score
 * @param {Object} breakdown
 * @param {string[]} issues
 * @param {boolean} passed
 * @returns {string}
 */
export function buildMarkdownReport(score, breakdown, issues, passed) {
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

  lines.push(`_Passing threshold: ${PASSING_SCORE}/100_`);
  return lines.join("\n");
}

// --- Main ---
try {
  const data = await parseResume();

  core.info("Resume parsed successfully. Scoring ATS compatibility...");

  const { score, breakdown, issues } = scoreResume(data);
  const passed = score >= PASSING_SCORE;
  const report = buildMarkdownReport(score, breakdown, issues, passed);

  core.info(`\n${report}`);

  core.setOutput("ATS_SCORE", String(score));
  core.setOutput("ATS_REPORT", report);
  core.setOutput("ATS_PASSED", String(passed));

  if (!passed) {
    core.warning(
      `ATS score ${score}/100 is below the passing threshold of ${PASSING_SCORE}.`,
    );
  } else {
    core.notice(`ATS score ${score}/100 — passed!`);
  }
} catch (e) {
  core.setFailed(`ATS Check action failed: ${e}`);
  console.error("Error:", e);
}
