// A faster drop-in for makefun-site 1.0.0 (make.fun's own static site generator).
// run(input) returns exactly makefun-site 1.0.0's answer for every input: the output
// tree (path -> text) as a JSON object, byte for byte. The pipeline below mirrors
// makefun-site's own (same plugin order, same rules, same report lines); only the
// internals are faster: no regex on hot paths, a merged lex+render Markdown pass,
// run-based inline escaping, a cached ASCII-fast slugify, and templates compiled
// to JavaScript functions (includes inlined at compile time, depth <= 8 exactly
// as the reference). Dependency-free ES module, no imports. All caches are created
// inside run(): nothing is carried from one case to the next.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const HAS_ESC = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
export function escapeHtml(text) {
  if (!HAS_ESC.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;

/**
 * The slug of `text` (see makefun-site's README "Text"), with a per-build cache.
 * NFKD + combining-mark removal are the identity on pure ASCII, so ASCII strings
 * skip both entirely.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a UTF-16 code unit is a JavaScript whitespace character (the `\s` set). */
function isWS(code) {
  if (code <= 0x20) return code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d || code === 0x20;
  if (code < 0xa0) return false;
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace (same count as /\S+/g). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) {
      inWord = false;
      continue;
    }
    if (c < 128) {
      if (!inWord) {
        n++;
        inWord = true;
      }
      continue;
    }
    if (isWS(c)) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. The closing "---" line is found first (an unclosed front matter is refused
 * before any line in it is read), then the lines between are parsed in order; the body is sliced, never
 * split and re-joined.
 */
function parseFrontMatter(text) {
  if (!text.startsWith('---') || (text.length > 3 && text[3] !== '\n')) return { error: 'no front matter' };
  const data = {};
  let pos = text.length === 3 ? 3 : 4; // start of line 2
  // Find the closing "---" line: a line that is exactly "---".
  let closePos = -1;
  let sp = pos;
  while (true) {
    const k = text.indexOf('---', sp);
    if (k === -1) break;
    if ((k === pos || text[k - 1] === '\n') && (k + 3 === text.length || text[k + 3] === '\n')) {
      closePos = k;
      break;
    }
    sp = k + 1;
  }
  if (closePos === -1) return { error: 'the front matter is not closed' };
  let lineNo = 2;
  while (pos < closePos) {
    const end = text.indexOf('\n', pos);
    const lineEnd = end === -1 || end > closePos ? closePos : end;
    const line = text.slice(pos, lineEnd);
    if (!/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = lineEnd + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closePos + 3 === text.length ? '' : text.slice(closePos + 4) };
}

// ---------------------------------------------------------------- Markdown
// Merged lex + render in one pass over the lines (no token objects, no regex on
// the block path). Every rule is makefun-site's own (README "Markdown"); the
// checks below are hand-written equivalents of the reference's regexes.

/** Whether `line` is blank: spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let k = 3; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < 6 && line[h] === '#') h++;
  if (h === 0) return null;
  let j = h;
  while (line[j] === ' ' || line[j] === '\t') j++;
  if (j === h) return null;
  let e = line.length;
  while (e > j && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  if (e === j) return null;
  return { depth: h, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHR(line) {
  if (line[0] !== '-' && line[0] !== '*') return false;
  if (line.slice(0, 3) !== '---' && line.slice(0, 3) !== '***') return false;
  for (let k = 3; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null. */
function orderedOf(line) {
  let j = 0;
  while (j < 9 && line[j] >= '0' && line[j] <= '9') j++;
  if (j === 0) return null;
  if (line[j] !== '.' || line[j + 1] !== ' ') return null;
  return { num: line.slice(0, j), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line[0] !== ' ' || line[1] !== ' ') return false;
  let j = 2;
  while (line[j] === ' ') j++;
  return j < line.length && !isWS(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line[0];
  if (c === ' ' || c === '\t') return isBlank(line);
  if (c === '`') return fenceOpen(line) !== null;
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return isHR(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * The reference scans char by char, skipping `\X` pairs; that is exactly "the
 * run of backslashes before the match is even", so indexOf + a parity check
 * returns the same index.
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let b = 0;
    let k = j - 1;
    while (k >= 0 && s[k] === '\\') { b++; k--; }
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let b = 0;
    let k = j - 1;
    while (k >= 0 && s[k] === '\\') { b++; k--; }
    if (b % 2 === 1) { j = s.indexOf('*', j + 1); continue; }
    if (s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

/** The inline metacharacters: a backslash, a backtick, a star or an open bracket. */
const META = /[\\`*[]/g;

/** The entities escapeHtml writes, back to the characters (the inverse of escapeHtml). */
const UNESC = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const UNESC_RE = /&(amp|lt|gt|quot|#39);/g;

/** Undo escapeHtml on `t` (exact, because escapeHtml only ever writes those five entities). */
function unescapeEntities(t) {
  if (t.indexOf('&') === -1) return t;
  return t.replace(UNESC_RE, (m, e) => UNESC[e]);
}

/**
 * `s` rendered inline, where `s` is already HTML-escaped (escapeHtml applied once to the whole block text).
 * The markers (`\`, `` ` ``, `*`, `[`, `]`, `(`, `)`) are never escaped, so the scan is unchanged; a raw `\>` reaches
 * here as `\` + `&gt;`, which the backslash handler turns back into `&gt;` (the only escapable character escapeHtml
 * also escapes); a link's target is unescaped before it is resolved, and its href escaped again.
 */
function inline(s, env) {
  META.lastIndex = 0;
  if (META.exec(s) === null) return s; // no `\`, backtick, `*` or `[`: the escaped text is already the HTML
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    META.lastIndex = i;
    const mm = META.exec(s);
    const j = mm === null ? n : mm.index;
    if (j > i) out += s.slice(i, j);
    if (j >= n) break;
    i = j;
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '&' && s.startsWith('&gt;', i + 1)) {
        out += '&gt;';
        i += 5;
      } else if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out += escapeHtml(s[i + 1]);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out += `<code>${s.slice(i + 1, k)}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        out += `<em>${inline(s.slice(i + 1, k), env)}</em>`;
        i = k + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : unescapeEntities(s.slice(k + 2, m));
    if (target !== '' && !/\s/.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      i = m + 1;
      continue;
    }
    out += '[';
    i++;
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, B) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line[0];
    if (c0 === ' ' || c0 === '\t') {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // An indented line is a paragraph line (indented lines are not code).
    } else if (c0 === '`') {
      const fenceLang = fenceOpen(line);
      if (fenceLang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fenceLang === '' ? '' : ` class="language-${escapeHtml(fenceLang)}"`;
        const code = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    } else if (c0 === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, B.slugCache), ids);
        const html = inline(escapeHtml(heading.text), env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHR(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const m = bulletOf(l);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
          if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
            continue;
          }
          break;
        }
        let html = '<ul>\n';
        for (const parts of items) html += `<li>${inline(escapeHtml(parts.join('\n')), env)}</li>\n`;
        html += '</ul>';
        blocks.push(html);
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const ls = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') ls.push(t);
      }
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(escapeHtml(ls.join('\n')), env)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= '0' && c0 <= '9') {
      const first = orderedOf(line);
      if (first !== null) {
        const items = [];
        const start = Number(first.num);
        while (i < n) {
          const l = lines[i];
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
          if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
            continue;
          }
          break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let html = `${open}\n`;
        for (const parts of items) html += `<li>${inline(escapeHtml(parts.join('\n')), env)}</li>\n`;
        html += '</ol>';
        blocks.push(html);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inline(escapeHtml(text), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates
// The dialect is makefun-site's own (README "Templates"). Parsing is the
// reference's parser verbatim (same nodes, same error messages). Rendering
// compiles each root template to a JavaScript function instead of walking the
// tree: includes are inlined at compile time (depth <= 8, exactly as the
// reference), and a path's first name is resolved lexically — a loop variable
// from the innermost enclosing `for`, `loop` from that same `for` (the
// reference's scope object puts `loop` after the element, so `loop` always
// wins, even for `{% for loop in … %}`), anything else from the page's values
// by own property. That is exactly the reference's innermost-scope lookup.

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- compiled rendering ----------------------------------------------------

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
const hasOwn = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const get1 = (v, a) => (v !== null && typeof v === 'object' && Object.hasOwn(v, a) ? v[a] : undefined);
const get2 = (v, a, b) => get1(get1(v, a), b);
const get3 = (v, a, b, c) => get1(get1(get1(v, a), b), c);

/** Helpers the generated template functions close over (via their H argument). */
const TH = { esc: escapeHtml, txt: textOf, tru: truthy, has: hasOwn, g1: get1, g2: get2, g3: get3 };

/** JavaScript source for the value at `path`, given the lexical `bindings` (innermost last). */
function pathCode(path, bindings) {
  const first = path[0];
  let base;
  if (first === 'loop') {
    if (bindings.length === 0) return 'undefined';
    base = bindings[bindings.length - 1].loop;
  } else {
    let found = null;
    for (let b = bindings.length - 1; b >= 0; b--) {
      if (bindings[b].name === first) { found = bindings[b].elem; break; }
    }
    base = found !== null ? found : `has(S,${JSON.stringify(first)})`;
  }
  if (path.length === 1) return base;
  if (path.length === 2) return `g1(${base},${JSON.stringify(path[1])})`;
  if (path.length === 3) return `g2(${base},${JSON.stringify(path[1])},${JSON.stringify(path[2])})`;
  if (path.length === 4) return `g3(${base},${JSON.stringify(path[1])},${JSON.stringify(path[2])},${JSON.stringify(path[3])})`;
  let expr = base;
  for (let k = 1; k < path.length; k++) expr = `g1(${expr},${JSON.stringify(path[k])})`;
  return expr;
}

/** Append the JavaScript for `nodes` to `ctx.out`, appending to the variable `ov` (includes inlined, depth-capped). */
function genNodes(nodes, depth, bindings, ctx, ov) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        ctx.out.push(`${ov}+=${JSON.stringify(n.text)};`);
        break;
      case 'var':
        ctx.out.push(`${ov}+=esc(txt(${pathCode(n.path, bindings)}));`);
        break;
      case 'raw':
        ctx.out.push(`${ov}+=txt(${pathCode(n.path, bindings)});`);
        break;
      case 'if': {
        ctx.out.push(`if(tru(${pathCode(n.path, bindings)})!==${n.not}){`);
        genNodes(n.then, depth, bindings, ctx, ov);
        if (n.else !== null) {
          ctx.out.push('}else{');
          genNodes(n.else, depth, bindings, ctx, ov);
        }
        ctx.out.push('}');
        break;
      }
      case 'for': {
        const id = ctx.counter++;
        const xs = `__xs${id}`;
        const k = `__k${id}`;
        const v = `__v${id}`;
        const l = `__l${id}`;
        ctx.out.push(`{const ${xs}=${pathCode(n.path, bindings)};if(Array.isArray(${xs})){for(let ${k}=0;${k}<${xs}.length;${k}++){if(!(${k} in ${xs}))continue;const ${v}=${xs}[${k}];const ${l}={index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length};`);
        bindings.push({ name: n.name, elem: v, loop: l });
        genNodes(n.body, depth, bindings, ctx, ov);
        bindings.pop();
        ctx.out.push('}}}');
        break;
      }
      case 'include': {
        if (depth < INCLUDE_DEPTH) {
          const t = ctx.templates.get(n.name);
          if (t !== undefined) {
            const memo = memoPlan(n.name, bindings, ctx, depth);
            if (memo === null) genNodes(t, depth + 1, bindings, ctx, ov);
            else emitMemo(ctx, ov, `${n.name}@${depth}`, memo, () => genNodes(t, depth + 1, bindings, ctx, memo.tmp));
          }
        }
        break;
      }
    }
  }
}

/** The first-names a template's tree reads that no `for` inside it binds (through its includes, depth-capped). */
function freeNames(nodes, templates, bound, depth, out) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if' || n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    }
    if (n.kind === 'for') {
      bound.set(n.name, (bound.get(n.name) ?? 0) + 1);
      freeNames(n.body, templates, bound, depth, out);
      const c = bound.get(n.name) - 1;
      if (c === 0) bound.delete(n.name);
      else bound.set(n.name, c);
    } else if (n.kind === 'if') {
      freeNames(n.then, templates, bound, depth, out);
      if (n.else !== null) freeNames(n.else, templates, bound, depth, out);
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const t = templates.get(n.name);
        if (t !== undefined) freeNames(t, templates, bound, depth + 1, out);
      }
    }
  }
}

/** The first-names template `name` reads from outside itself (cached per build). */
function freeNamesOf(name, ctx) {
  let free = ctx.freeCache.get(name);
  if (free === undefined) {
    free = new Set();
    const nodes = ctx.templates.get(name);
    if (nodes !== undefined) freeNames(nodes, ctx.templates, new Map(), 0, free);
    ctx.freeCache.set(name, free);
  }
  return free;
}

/**
 * Whether the include of `name` at this site may be memoised, and on what key.
 * Its render is a pure function of the page's `site`/`tags`/`recent` (the same
 * objects for every render in a build), at most one enclosing loop variable,
 * and the enclosing loop's position — so those, plus the include depth, key it.
 * Anything else (a `page`, `posts`, `pager`, `tag`, or a second loop variable)
 * makes it unmemoised. Returns null, or { keyExprs, tmp }.
 */
function memoPlan(name, bindings, ctx, depth) {
  const free = freeNamesOf(name, ctx);
  const boundNames = new Set(bindings.map((b) => b.name));
  const loopVars = [];
  let usesLoop = false;
  for (const n of free) {
    if (n === 'loop') {
      if (bindings.length > 0) usesLoop = true;
      else return null;
    } else if (boundNames.has(n)) loopVars.push(n);
    else if (n !== 'site' && n !== 'tags' && n !== 'recent') return null;
  }
  if (loopVars.length > 1) return null;
  const keyExprs = [];
  if (loopVars.length === 1) {
    for (let b = bindings.length - 1; b >= 0; b--) {
      if (bindings[b].name === loopVars[0]) {
        keyExprs.push(bindings[b].elem);
        break;
      }
    }
  }
  if (usesLoop) {
    const l = bindings[bindings.length - 1].loop;
    keyExprs.push(`${l}.index+":"+${l}.length`);
  }
  return { keyExprs, tmp: `__o${ctx.counter++}` };
}

/** Emit a memoised render of the nodes `renderFn` writes into `tmp`, appending the result to `ov`. */
function emitMemo(ctx, ov, nameKey, memo, renderFn) {
  const lines = ctx.out;
  const levels = [JSON.stringify(nameKey), ...memo.keyExprs];
  lines.push('{');
  let cur = 'M';
  for (let li = 0; li < levels.length; li++) {
    const isLast = li === levels.length - 1;
    if (isLast) {
      lines.push(`let __mv=${cur}.get(${levels[li]});if(__mv===undefined){let ${memo.tmp}="";`);
      renderFn();
      lines.push(`__mv=${memo.tmp};${cur}.set(${levels[li]},__mv);}`);
      lines.push(`${ov}+=__mv;}`);
    } else {
      const mv = `__m${ctx.counter++}`;
      lines.push(`let ${mv}=${cur}.get(${levels[li]});if(${mv}===undefined){${mv}=new Map();${cur}.set(${levels[li]},${mv});}`);
      cur = mv;
    }
  }
}

/** Compile the root template `name` to a function (H, S, M) => string, or null when it is missing. */
function compileRoot(name, templates, B) {
  const nodes = templates.get(name);
  if (nodes === undefined) return null;
  const ctx = { out: [], counter: 0, templates, freeCache: B.freeCache };
  genNodes(nodes, 0, [], ctx, 'out');
  const code = `"use strict";const {esc,txt,tru,has,g1,g2,g3}=H;let out="";\n${ctx.out.join('\n')}\nreturn out;`;
  return new Function('H', 'S', 'M', code);
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens on a scheme (`https:`, `mailto:` ...): the reference's /^[A-Za-z][A-Za-z0-9+.-]*:/. */
function hasScheme(target) {
  if (target.length < 2) return false;
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) continue;
    return false;
  }
  return false;
}

/** One site's output tree: path -> text. `B` holds this build's caches. */
function build(input, B) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, B.slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, B);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugify(name, B.slugCache);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, B.slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, B.slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  /** A page's link record as templates read it. */
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  /** A post's card, as lists show it. */
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    if (s.words === undefined) s.words = wordsOf(s.body);
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };

  /** A page as its layout reads it. */
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const render = (name, vars) => {
    let fn = B.compiled.get(name);
    if (fn === undefined) {
      fn = compileRoot(name, b.templates, B);
      B.compiled.set(name, fn);
    }
    if (fn === null) return null;
    return fn(TH, { site, tags: allTags, recent, ...vars }, B.memo);
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) } });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pagesCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const B = { slugCache: new Map(), compiled: new Map(), freeCache: new Map(), memo: new Map() };
  return build(input, B);
}
