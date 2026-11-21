// A faster drop-in for make.fun's csv-reader 1.0.0: readCsv's exact answers,
// computed with indexOf/split scans instead of one character at a time.
//
// Semantics (mirroring csv-reader 1.0.0 exactly):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote; each CRLF or lone CR inside it reads as LF;
//   what follows its closing quote, up to the next comma or line break, is
//   appended as it stands (quote_junk, when the field ends); a quote that never
//   closes is a literal character and the text after it is read again as
//   unquoted (unterminated_quote). A quote inside an unquoted field is literal.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds the
//   records after it, each padded (short_row, with fields: its field count) or
//   cut (long_row, with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met; line is the 1-based
//   line its record starts on (every LF, CRLF and lone CR inside quotes
//   counted), row its record's index in rows (null for the header).
//
// Speed: most records hold no quote and no stray CR, so a whole record is
// parsed by one split(',') on its line. Records that do hold a quote or a
// stray CR go through a field-by-field scan driven by indexOf, with a
// precomputed list of every '\r' position so stray-CR tests inside a bounded
// span cost O(1) amortised time.

const COMMA = 'comma';
const LINE_BREAK = 'line break';
const END = 'end';

/** csv-reader 1.0.0's answer for one case's input: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len !== 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // Every '\r' position, ascending. pos only moves forward, except for the
  // single backward step of an unterminated quote, so a pointer into this
  // list answers "is there a CR in [p, q)?" in amortised O(1).
  const crs = [];
  {
    let i = text.indexOf('\r');
    while (i !== -1) {
      crs.push(i);
      i = text.indexOf('\r', i + 1);
    }
  }
  const ncr = crs.length;
  let ci = 0; // crs[ci] is the first CR at or after pos
  const firstCrAtOrAfter = (p) => {
    while (ci < ncr && crs[ci] < p) ci += 1;
    while (ci > 0 && crs[ci - 1] >= p) ci -= 1;
    return ci < ncr ? crs[ci] : -1;
  };

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The next '\n' at or after pos, cached: unquoted fields end at a comma or
  // at this line break, so one lookup serves a whole run of unquoted fields.
  // leOk false means unknown; le -1 (once known) means no '\n' follows.
  let le = -1;
  let leOk = false;
  const ensureLe = () => {
    if (!leOk) {
      le = text.indexOf('\n', pos);
      leOk = true;
    } else if (le !== -1 && le < pos) {
      le = text.indexOf('\n', pos);
    }
  };

  const pushErr = (code) => {
    errors.push({ code, line: recordLine, row: recordRow });
  };

  // text[a..b) with every CRLF or lone CR turned into LF, counting the lines
  // crossed. Only called when the span is known to hold a line break.
  const appendWithBreaks = (value, a, b) =>
    value +
    text.slice(a, b).replace(/\r\n|\r|\n/g, () => {
      line += 1;
      return '\n';
    });

  // A quoted span text[a..b): plain slice when it holds no line break.
  const appendQuoted = (value, a, b) => {
    const nl = text.indexOf('\n', a);
    const cr = firstCrAtOrAfter(a);
    if ((nl === -1 || nl >= b) && (cr === -1 || cr >= b)) return value + text.slice(a, b);
    return appendWithBreaks(value, a, b);
  };

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept.
  const readUnquoted = (value, added) => {
    ensureLe();
    for (;;) {
      const cIdx = text.indexOf(',', pos);
      let end;
      let ended;
      if (cIdx !== -1 && (le === -1 || cIdx < le)) {
        end = cIdx;
        ended = COMMA;
      } else if (le !== -1) {
        end = le;
        ended = LINE_BREAK;
      } else {
        end = len;
        ended = END;
      }
      const cr = firstCrAtOrAfter(pos);
      if (cr !== -1 && cr < end) {
        if (ended === LINE_BREAK && cr === end - 1) {
          // CRLF ends the record.
          added += end - 1 - pos;
          value += text.slice(pos, end - 1);
          pos = end + 1;
          line += 1;
          return { value, ended, added };
        }
        // A stray CR: dropped, and the field goes on.
        added += cr - pos;
        value += text.slice(pos, cr);
        pushErr('stray_cr');
        pos = cr + 1;
        continue;
      }
      added += end - pos;
      value += text.slice(pos, end);
      if (ended === COMMA) pos = end + 1;
      else if (ended === LINE_BREAK) {
        pos = end + 1;
        line += 1;
      } else pos = end;
      return { value, ended, added };
    }
  };

  // Reads a quoted field whose opening quote is at pos.
  const readQuoted = () => {
    const open = pos;
    const openLine = line;
    let value = '';
    let start = pos + 1;
    for (;;) {
      const q = text.indexOf('"', start);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        leOk = false; // pos moved back: the cached line break is stale
        pushErr('unterminated_quote');
        return readUnquoted('"', 0);
      }
      if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
        value = appendQuoted(value, start, q);
        value += '"';
        start = q + 2;
        continue;
      }
      value = appendQuoted(value, start, q);
      pos = q + 1;
      break;
    }
    if (pos >= len) return { value, ended: END, added: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA, added: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK, added: 0 };
    }
    if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK, added: 0 };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value, 0);
    if (junk.added > 0) pushErr('quote_junk');
    return junk;
  };

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields = null;
    let quoted = false;

    // Fast path: this record's first line holds no quote and no stray CR, so
    // the whole record is that line, split on commas.
    const lineEnd = text.indexOf('\n', pos);
    const eol = lineEnd === -1 ? len : lineEnd;
    le = lineEnd;
    leOk = true;
    const qi = text.indexOf('"', pos);
    if (qi === -1 || qi >= eol) {
      const cr = firstCrAtOrAfter(pos);
      const isCrlf = eol < len && cr === eol - 1;
      if (cr === -1 || cr >= eol || isCrlf) {
        fields = text.slice(pos, isCrlf ? eol - 1 : eol).split(',');
        if (eol < len) {
          pos = eol + 1;
          line += 1;
        } else {
          pos = len;
        }
      }
    }

    if (fields === null) {
      fields = [];
      let field;
      do {
        quoted = text.charCodeAt(pos) === 34;
        field = quoted ? readQuoted() : readUnquoted('', 0);
        fields.push(field.value);
      } while (field.ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
