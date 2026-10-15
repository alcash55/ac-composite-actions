import { extractText, getDocumentProxy } from "unpdf";

/**
 * Reads the text layer of a PDF, one string with a newline between lines.
 * The resume parser API never returns a name or summary (name is null on every
 * resume tried, there is no summary key), so those two checks read this text.
 * @param {Uint8Array | Buffer} buffer
 * @returns {Promise<string>}
 */
export async function extractPdfText(buffer) {
  // pdfjs takes ownership of the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/** How many non-empty lines from the top the name may sit in. */
export const NAME_SEARCH_LINES = 6;

const SUMMARY_HEADINGS = [
  "summary",
  "professional summary",
  "career summary",
  "executive summary",
  "profile",
  "professional profile",
  "objective",
  "career objective",
  "about",
  "about me",
];

const OTHER_HEADINGS = [
  "skills",
  "employment history",
  "work history",
  "career history",
  "professional background",
  "technical skills",
  "experience",
  "work experience",
  "professional experience",
  "employment",
  "education",
  "projects",
  "certifications",
  "awards",
  "languages",
  "references",
  "contact",
  "resume",
  "curriculum vitae",
];

const HEADINGS = new Set([...SUMMARY_HEADINGS, ...OTHER_HEADINGS]);

// A job title is two or three plain words too, so a title line printed above
// the name must not pass as one.
const TITLE_WORDS =
  /\b(engineer|developer|designer|manager|analyst|architect|consultant|specialist|director|intern|scientist|administrator)\b/i;

const CONTACT = /@|https?:|www\.|\.(com|io|dev|net|org)\b|linkedin|github|\d/i;

const NAME_WORD = /^\p{L}[\p{L}'.-]*$/u;

/** Lowercased, trimmed, trailing colon dropped: how headings are compared. */
function normalizeHeading(line) {
  return line.trim().replace(/:$/, "").trim().toLowerCase();
}

/**
 * @param {string} text
 * @returns {string[]} trimmed non-empty lines
 */
function linesOf(text) {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function looksLikeName(candidate) {
  if (HEADINGS.has(normalizeHeading(candidate))) return false;
  if (CONTACT.test(candidate) || TITLE_WORDS.test(candidate)) return false;
  const words = candidate.split(/\s+/);
  return (
    words.length >= 2 &&
    words.length <= 4 &&
    words.every((w) => NAME_WORD.test(w)) &&
    // "Jane Q Doe" has an initial; "a b" has no name in it.
    words.filter((w) => w.length >= 2).length >= 2
  );
}

/**
 * Finds the candidate's name among the first few lines of the PDF text: 2 to 4
 * alphabetic words (any case, so ALL CAPS passes) that are not a section
 * heading, contact info, or a job title. A first name and last name set on two
 * lines (a common template layout) are tried joined.
 * @param {string} text
 * @returns {string | null}
 */
export function findName(text) {
  const lines = linesOf(text).slice(0, NAME_SEARCH_LINES);
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeName(lines[i])) return lines[i];
    const next = lines[i + 1];
    const oneWordEach =
      next !== undefined && !/\s/.test(lines[i]) && !/\s/.test(next);
    if (oneWordEach && looksLikeName(`${lines[i]} ${next}`)) {
      return `${lines[i]} ${next}`;
    }
  }
  return null;
}

/**
 * Finds a summary: a line that is exactly a summary-type heading (SUMMARY,
 * PROFILE, OBJECTIVE, ABOUT, and variants, any case) followed by a line of
 * text that is not itself a section heading.
 * @param {string} text
 * @returns {string | null} the first line of the summary text
 */
export function findSummary(text) {
  const lines = linesOf(text);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!SUMMARY_HEADINGS.includes(normalizeHeading(lines[i]))) continue;
    if (!HEADINGS.has(normalizeHeading(lines[i + 1]))) return lines[i + 1];
  }
  return null;
}

const EXPERIENCE_HEADINGS = [
  "experience",
  "work experience",
  "professional experience",
  "employment",
  "employment history",
  "work history",
  "career history",
  "professional background",
];
const EDUCATION_HEADINGS = ["education", "academic background"];
const SKILLS_HEADINGS = ["skills", "technical skills", "core skills", "key skills"];

// Template headings are short ALL CAPS lines ("LEADERSHIP AND ATHLETICS"),
// so one ends a section even when it is not in HEADINGS.
function isHeading(line) {
  return (
    HEADINGS.has(normalizeHeading(line)) ||
    (/^[A-Z][A-Z&/ ]{3,40}$/.test(line) && line.split(/\s+/).length <= 4)
  );
}

/**
 * Lines under the first heading that matches `names`, up to the next heading.
 * @param {string} text
 * @param {string[]} names - lowercase heading names
 * @returns {string[] | null} null when the heading is absent
 */
export function sectionLines(text, names) {
  const lines = linesOf(text);
  const start = lines.findIndex((l) => names.includes(normalizeHeading(l)));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isHeading);
  return end === -1 ? rest : rest.slice(0, end);
}

/** True when the section exists and has at least one line of content. */
function hasSection(text, names) {
  return (sectionLines(text, names) ?? []).length > 0;
}
export const hasEducationSection = (text) => hasSection(text, EDUCATION_HEADINGS);
export const hasSkillsSection = (text) => hasSection(text, SKILLS_HEADINGS);
export const hasExperienceHeading = (text) => sectionLines(text, EXPERIENCE_HEADINGS) !== null;

const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
const DATE = `(?:\\d{1,2}\\s*[/.]\\s*\\d{4}|${MONTH}\\s+\\d{4}|\\d{4})`;
const END = `(?:${DATE}|Present|Current|Now|Today|Ongoing)`;
const RANGE = new RegExp(`(${DATE})\\s*(?:-|\u2013|\u2014|to)\\s*(${END})(?![\\w/])`, "i");

/** Oldest start year a real resume entry plausibly has. */
export const MIN_PLAUSIBLE_YEAR = 1990;

/**
 * True when the line holds a date range ("8/2024 - 9/2026", "Apr 2023 - Jun
 * 2024", "2021 - Present", with hyphen, en dash, em dash or "to"). Years must
 * fall from 1990 through next year and the end may not precede the start.
 * @param {string} line
 * @param {number} [now] - epoch ms, injectable for tests
 */
export function hasDateRange(line, now = Date.now()) {
  const m = RANGE.exec(line);
  if (!m) return false;
  const maxYear = new Date(now).getUTCFullYear() + 1;
  const year = (d) => Number(/\d{4}/.exec(d)?.[0]);
  const start = year(m[1]);
  const end = /^\d|^[A-Za-z]{3}/.test(m[2]) && /\d{4}/.test(m[2]) ? year(m[2]) : maxYear;
  return start >= MIN_PLAUSIBLE_YEAR && end <= maxYear && start <= end;
}

const JOB_TITLE =
  /\b(engineer|developer|designer|manager|analyst|architect|consultant|specialist|director|intern|scientist|administrator|coach|lead|officer|associate|assistant|technician|instructor|teacher|tutor|programmer|researcher|owner|founder)\b/i;
const BULLET = /^[-\u2022*\u2013\u00b7\u25aa>]\s/;

function isTitleLine(line) {
  return (
    !BULLET.test(line) &&
    /^\p{Lu}/u.test(line) &&
    line.split(/\s+/).length <= 8 &&
    !/[.,;:]$/.test(line) &&
    JOB_TITLE.test(line)
  );
}

/**
 * Splits the EXPERIENCE section into job entries and reports whether each has
 * a date range and a job title, from the printed text alone. A line that is a
 * date range or a short capitalised job-title line is an anchor. Anchors with
 * no bullet between them belong to one entry; a second range or a second title
 * starts the next entry, and a bullet closes the entry. That reads both
 * "range, type, title" and "title, range" layouts.
 * @param {string} text
 * @param {number} [now]
 * @returns {{ entries: { hasDate: boolean, hasTitle: boolean, label: string }[] } | null}
 *   null when the text has no experience heading
 */
export function findExperienceEntries(text, now = Date.now()) {
  const section = sectionLines(text, EXPERIENCE_HEADINGS);
  if (section === null) return null;

  const entries = [];
  let current = null;
  let gap = 0;
  const open = () => {
    current = { hasDate: false, hasTitle: false, label: "" };
    entries.push(current);
    gap = 0;
  };

  for (const line of section) {
    if (BULLET.test(line)) {
      current = null;
      continue;
    }
    const range = hasDateRange(line, now);
    const title = isTitleLine(line) || (range && JOB_TITLE.test(line));
    if (!range && !title) {
      if (current && ++gap > 2) current = null;
      continue;
    }
    if (!current || (range && current.hasDate) || (title && current.hasTitle)) open();
    gap = 0;
    if (range) current.hasDate = true;
    if (title) {
      current.hasTitle = true;
      current.label = line;
    }
  }
  return { entries };
}
