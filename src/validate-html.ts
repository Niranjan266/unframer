/**
 * HTML validation.
 *
 * A claim like "passes W3C validation" is worth making only if something checks
 * it, so this runs a real parser over every exported page.
 *
 * Framer's server-rendered markup is not ours and will carry warnings we cannot
 * fix without rewriting the design, so the gate is deliberately scoped to
 * *errors we could have introduced*: unclosed elements, duplicate ids, broken
 * nesting. Stylistic preferences are reported but do not fail the build.
 */

import { HtmlValidate, type Message } from 'html-validate';
import { readFile } from 'node:fs/promises';

/**
 * Rules that indicate genuinely malformed markup. Anything outside this set is
 * advisory — the exporter should not fail a build over Framer's house style.
 */
const STRUCTURAL_RULES = new Set([
  'close-order',
  'close-attr',
  'no-dup-id',
  'no-dup-attr',
  'element-permitted-content',
  'element-permitted-parent',
  'unclosed-element',
  'parser-error',
  'void-content',
  'no-raw-characters',
]);

export interface HtmlIssue {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  filesChecked: number;
  structuralErrors: HtmlIssue[];
  advisory: HtmlIssue[];
  pass: boolean;
}

function toIssue(file: string, m: Message): HtmlIssue {
  return {
    file,
    line: m.line,
    column: m.column,
    rule: m.ruleId,
    message: m.message,
    severity: m.severity === 2 ? 'error' : 'warning',
  };
}

/**
 * Signature identifying an issue independently of where it sits in the file.
 *
 * Line numbers shift as soon as anything is injected, so they cannot be part of
 * the identity — otherwise every pre-existing issue looks new.
 */
function signatureOf(issue: HtmlIssue): string {
  return `${issue.rule}::${issue.message}`;
}

/**
 * Validate an exported page against its source.
 *
 * Framer's own markup carries issues we neither caused nor can fix without
 * redesigning the page — it emits a `<style>` inside a `<div>`, for one, which
 * is present identically in the original. Failing a build on those would be
 * noise that trains people to ignore the check.
 *
 * So the gate is: issues present in the source are acknowledged but do not fail;
 * only issues the export *introduced* count as errors. That keeps the signal
 * about our transformations rather than about Framer's house style.
 */
export async function validateAgainstBaseline(
  exportedHtml: string,
  originalHtml: string,
  label = 'export',
): Promise<{ introduced: HtmlIssue[]; preExisting: HtmlIssue[] }> {
  const [exported, original] = await Promise.all([
    validateHtmlStrings([{ source: exportedHtml, name: label }]),
    validateHtmlStrings([{ source: originalHtml, name: 'original' }]),
  ]);

  const baseline = new Set(
    [...original.structuralErrors, ...original.advisory].map(signatureOf),
  );

  const all = [...exported.structuralErrors, ...exported.advisory];
  const introduced = all.filter((i) => !baseline.has(signatureOf(i)));
  const preExisting = all.filter((i) => baseline.has(signatureOf(i)));

  return { introduced, preExisting };
}

/** Validate HTML held in memory rather than on disk. */
export async function validateHtmlStrings(
  documents: ReadonlyArray<{ source: string; name: string }>,
): Promise<ValidationResult> {
  const validator = makeValidator();
  const structuralErrors: HtmlIssue[] = [];
  const advisory: HtmlIssue[] = [];

  for (const { source, name } of documents) {
    const report = await validator.validateString(source, name);
    for (const result of report.results) {
      for (const message of result.messages) {
        const issue = toIssue(name, message);
        if (issue.severity === 'error' && STRUCTURAL_RULES.has(issue.rule)) {
          structuralErrors.push(issue);
        } else {
          advisory.push(issue);
        }
      }
    }
  }

  return {
    filesChecked: documents.length,
    structuralErrors,
    advisory,
    pass: structuralErrors.length === 0,
  };
}

function makeValidator(): HtmlValidate {
  return new HtmlValidate({
    extends: ['html-validate:recommended'],
    rules: {
      // Framer inlines everything and names its own classes; neither is a defect.
      'no-inline-style': 'off',
      'attribute-boolean-style': 'off',
      'attr-quotes': 'off',
      'void-style': 'off',
      'long-title': 'off',
      'no-trailing-whitespace': 'off',
    },
  });
}

/** Validate a set of HTML files. */
export async function validateHtmlFiles(files: readonly string[]): Promise<ValidationResult> {
  const validator = makeValidator();
  const structuralErrors: HtmlIssue[] = [];
  const advisory: HtmlIssue[] = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const report = await validator.validateString(source, file);

    for (const result of report.results) {
      for (const message of result.messages) {
        const issue = toIssue(file, message);
        if (issue.severity === 'error' && STRUCTURAL_RULES.has(issue.rule)) {
          structuralErrors.push(issue);
        } else {
          advisory.push(issue);
        }
      }
    }
  }

  return {
    filesChecked: files.length,
    structuralErrors,
    advisory,
    pass: structuralErrors.length === 0,
  };
}
