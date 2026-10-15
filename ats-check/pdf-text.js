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
