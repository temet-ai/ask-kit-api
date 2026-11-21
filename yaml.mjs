// A YAML reader for OpenAPI documents, with no dependency. It covers what such documents use:
// block maps and lists, plain, single-quoted and double-quoted scalars (also over several lines),
// block scalars (| and >, with chomping and an indentation digit), flow lists and maps, comments,
// anchors, aliases and the merge key (<<). It reads the first document of a file.
// Not covered: complex keys (? ), tags other than !!str, tabs as indentation.
// Scalars follow the YAML 1.2 core schema, so `yes` and `no` are strings.
// Errors name a line and never quote the file: a file that is not a spec may hold anything.

const SP = 32;

const unescapeDouble = (s) =>
  s.includes("\\")
    ? s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, e) => {
        const c = e[0];
        if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
        return { n: "\n", t: "\t", r: "\r", 0: "\0", b: "\b", f: "\f", e: "\x1b", a: "\x07", v: "\v", N: "\x85", _: "\xa0", L: " ", P: " ", "\t": "\t" }[c] ?? c;
      })
    : s;

/** The index of the quote that closes a string whose opening quote `q` (a char code) came before `from`, or -1. */
function closeFrom(s, from, q) {
  for (let p = from; p < s.length; p++) {
    const c = s.charCodeAt(p);
    if (q === 34 && c === 92) p++;
    else if (c === q) {
      if (q === 39 && s.charCodeAt(p + 1) === 39) p++;
      else return p;
    }
  }
  return -1;
}

const unquote = (inner, q) => (q === 34 ? unescapeDouble(inner) : inner.replaceAll("''", "'"));

function scalar(s) {
  switch (s) {
    case "":
    case "~":
    case "null":
    case "Null":
    case "NULL":
      return null;
    case "true":
    case "True":
    case "TRUE":
      return true;
    case "false":
    case "False":
    case "FALSE":
      return false;
  }
  const c = s.charCodeAt(0);
  if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
    if (/^[-+]?\d+$/.test(s) || /^0x[0-9a-fA-F]+$/.test(s) || /^0o[0-7]+$/.test(s)) return Number(s);
    if (/^[-+]?(\.\d+|\d+(\.\d*)?)([eE][-+]?\d+)?$/.test(s)) return Number(s);
    if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s[0] === "-" ? -Infinity : Infinity;
    if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  }
  return s;
}

const stripComment = (s) => {
  const h = s.indexOf(" #");
  return (h >= 0 ? s.slice(0, h) : s).trimEnd();
};

export function parseYaml(input) {
  let text = String(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  let N = lines.length;
  let i = 0;
  const anchors = new Map();
  const fail = (msg, at = i) => {
    throw new Error(`YAML line ${Math.min(at, N - 1) + 1}: ${msg}`);
  };

  const indentOf = (s) => {
    let n = 0;
    while (s.charCodeAt(n) === SP) n++;
    return n;
  };
  const blank = (s) => {
    const n = indentOf(s);
    if (n === s.length) return true;
    const c = s.charCodeAt(n);
    return c === 35 || ((c === 9 || c === 13) && !s.trim());
  };
  const skip = () => {
    while (i < N && blank(lines[i])) i++;
  };
  const isEntry = (s, n) => s.charCodeAt(n) === 45 && (n + 1 === s.length || s.charCodeAt(n + 1) === SP);

  /** The index of the colon that ends a key starting at column n, or -1 when the line is not `key: ...`. */
  function keyEnd(line, n) {
    const c = line.charCodeAt(n);
    if (c === 34 || c === 39) {
      const e = closeFrom(line, n + 1, c);
      if (e < 0) return -1;
      let j = e + 1;
      while (line.charCodeAt(j) === SP) j++;
      if (line.charCodeAt(j) !== 58) return -1;
      const a = line.charCodeAt(j + 1);
      return j + 1 === line.length || a === SP || a === 9 ? j : -1;
    }
    if (c === 91 || c === 123 || c === 38 || c === 42 || c === 33 || c === 124 || c === 62) return -1;
    let j = n;
    for (;;) {
      j = line.indexOf(":", j);
      if (j < 0) return -1;
      const a = line.charCodeAt(j + 1);
      if (j + 1 === line.length || a === SP || a === 9) break;
      j++;
    }
    const h = line.indexOf(" #", n);
    return h >= 0 && h < j ? -1 : j;
  }

  /** The node below a line: indented more than `parent`, or null. */
  function block(parent) {
    skip();
    if (i >= N) return null;
    const n = indentOf(lines[i]);
    return n > parent ? nodeAt(n, parent) : null;
  }

  function nodeAt(n, parent) {
    const line = lines[i];
    if (isEntry(line, n)) return seq(n);
    if (line.charCodeAt(n) === 63 && line.charCodeAt(n + 1) === SP) fail("complex keys (? ) are not supported");
    if (keyEnd(line, n) >= 0) return map(n);
    return inline(line.slice(n), parent);
  }

  function map(n) {
    const out = {};
    while (i < N) {
      const line = lines[i];
      const j = keyEnd(line, n);
      if (j < 0) fail("a key was expected here");
      const c = line.charCodeAt(n);
      let key = line.slice(n, j).trimEnd();
      if (c === 34 || c === 39) key = unquote(key.slice(1, -1), c);
      let rest = line.slice(j + 1).trim();
      let v;
      if (rest === "" || rest.charCodeAt(0) === 35) {
        i++;
        skip();
        v = null;
        if (i < N) {
          const n2 = indentOf(lines[i]);
          if (n2 > n) v = nodeAt(n2, n);
          else if (n2 === n && isEntry(lines[i], n)) v = seq(n);
        }
      } else v = inline(rest, n);
      if (key === "<<" && v && typeof v === "object") {
        for (const m of Array.isArray(v) ? v : [v]) if (m && typeof m === "object") for (const k of Object.keys(m)) if (!(k in out)) out[k] = m[k];
      } else if (key !== "__proto__") out[key] = v;
      skip();
      if (i >= N) break;
      const n3 = indentOf(lines[i]);
      if (n3 < n) break;
      if (n3 > n) fail("this line is indented more than the keys above it");
      if (isEntry(lines[i], n)) break;
    }
    return out;
  }

  function seq(n) {
    const out = [];
    while (i < N) {
      const line = lines[i];
      if (indentOf(line) !== n || !isEntry(line, n)) break;
      let k = n + 1;
      while (line.charCodeAt(k) === SP) k++;
      if (k >= line.length || line.charCodeAt(k) === 35) {
        i++;
        out.push(block(n));
      } else if (isEntry(line, k) || keyEnd(line, k) >= 0) {
        // The entry's content is a node of its own, indented where it stands.
        lines[i] = " ".repeat(k) + line.slice(k);
        out.push(nodeAt(k, n));
      } else out.push(inline(line.slice(k), n));
      skip();
    }
    if (i < N && indentOf(lines[i]) > n) fail("this line is indented more than the list above it");
    return out;
  }

  /** A value that starts on the current line as `rest`; its further lines are indented more than `parent`. */
  function inline(rest, parent) {
    let anchor = null;
    let str = false;
    for (;;) {
      const c = rest.charCodeAt(0);
      if (c === 38) {
        const m = /^&(\S+)\s*/.exec(rest);
        anchor = m[1];
        rest = rest.slice(m[0].length);
      } else if (c === 33) {
        const m = /^!\S*\s*/.exec(rest);
        if (m[0].trim() === "!!str") str = true;
        rest = rest.slice(m[0].length);
      } else break;
    }
    let v;
    const c = rest.charCodeAt(0);
    if (rest === "" || c === 35) {
      i++;
      v = block(parent);
    } else if (c === 42) {
      const name = stripComment(rest).slice(1);
      if (!anchors.has(name)) fail(`unknown alias *${name.slice(0, 40)}`);
      v = anchors.get(name);
      i++;
    } else if (c === 124 || c === 62) v = blockScalar(rest, parent);
    else if (c === 34 || c === 39) v = quoted(rest, c);
    else if (c === 91 || c === 123) v = flow(rest);
    else v = plain(rest, parent, str);
    if (anchor) anchors.set(anchor, v);
    return v;
  }

  function plain(rest, parent, str) {
    let s = stripComment(rest);
    i++;
    let multi = false;
    while (i < N) {
      let l = lines[i];
      let n = indentOf(l);
      let breaks = 0;
      if (n === l.length) {
        // Blank lines belong to the scalar only when it goes on after them.
        let k = i + 1;
        while (k < N && indentOf(lines[k]) === lines[k].length) k++;
        if (k >= N) break;
        breaks = k - i;
        l = lines[k];
        n = indentOf(l);
        if (n <= parent || l.charCodeAt(n) === 35) break;
        i = k;
      }
      if (n <= parent || l.charCodeAt(n) === 35) break;
      s += (breaks ? "\n".repeat(breaks) : " ") + stripComment(l.slice(n));
      multi = true;
      i++;
    }
    return multi || str ? s : scalar(s);
  }

  function quoted(rest, q) {
    const e = closeFrom(rest, 1, q);
    const tail = (t) => {
      const x = t.trim();
      if (x && x.charCodeAt(0) !== 35) fail("text after the end of a quoted string");
    };
    if (e >= 0) {
      tail(rest.slice(e + 1));
      i++;
      return unquote(rest.slice(1, e), q);
    }
    let s = rest.slice(1).trimEnd();
    let empty = false;
    const at = i;
    i++;
    for (;;) {
      if (i >= N) fail("a quoted string is not closed", at);
      const l = lines[i].trim();
      i++;
      const e2 = closeFrom(l, 0, q);
      const part = e2 >= 0 ? l.slice(0, e2) : l;
      if (part === "" && e2 < 0) {
        s += "\n";
        empty = true;
      } else {
        const cont = q === 34 && /(^|[^\\])(\\\\)*\\$/.test(s);
        if (cont) s = s.slice(0, -1) + part;
        else s += (empty ? "" : " ") + part;
        empty = false;
      }
      if (e2 >= 0) {
        tail(l.slice(e2 + 1));
        break;
      }
    }
    return unquote(s, q);
  }

  function blockScalar(header, parent) {
    const m = /^([|>])([+-]?)(\d?)([+-]?)\s*(#.*)?$/.exec(header);
    if (!m) fail("a block scalar header (| or >) with something else after it");
    const literal = m[1] === "|";
    const chomp = m[2] || m[4];
    let indent = m[3] ? Math.max(parent, 0) + Number(m[3]) : -1;
    i++;
    const out = [];
    while (i < N) {
      const l = lines[i];
      const n = indentOf(l);
      if (n === l.length || (indent >= 0 && n < indent && !l.trim())) {
        out.push(indent >= 0 && n > indent ? l.slice(indent) : "");
        i++;
        continue;
      }
      if (indent < 0) {
        if (n <= parent) break;
        indent = n;
      }
      if (n < indent) break;
      out.push(l.slice(indent));
      i++;
    }
    let trail = 0;
    while (out.length && out[out.length - 1].trim() === "") {
      out.pop();
      trail++;
    }
    let body;
    if (literal) body = out.join("\n");
    else {
      body = "";
      let prev = null;
      for (let k = 0; k < out.length; k++) {
        const line = out[k];
        const kind = line === "" ? "empty" : line.charCodeAt(0) === SP || line.charCodeAt(0) === 9 ? "more" : "text";
        if (k === 0) body = kind === "empty" ? "\n" : line;
        else if (kind === "empty") body += "\n";
        else if (prev === "empty") body += line;
        else if (kind === "more" || prev === "more") body += "\n" + line;
        else body += " " + line;
        prev = kind;
      }
    }
    if (!out.length) return chomp === "+" ? "\n".repeat(trail) : "";
    if (chomp === "-") return body;
    return body + (chomp === "+" ? "\n".repeat(trail + 1) : "\n");
  }

  /** A flow list or map, which may run over several lines. */
  function flow(rest) {
    let t = rest;
    let depth = 0;
    let q = 0;
    let p = 0;
    let last = 0; // the last character that was not a space, outside quotes
    const at = i;
    scan: for (;;) {
      for (; p < t.length; p++) {
        const c = t.charCodeAt(p);
        if (q) {
          if (q === 34 && c === 92) p++;
          else if (c === q) {
            if (q === 39 && t.charCodeAt(p + 1) === 39) p++;
            else q = 0;
          }
          continue;
        }
        if ((c === 34 || c === 39) && (last === 91 || last === 123 || last === 44 || last === 58)) q = c;
        else if (c === 91 || c === 123) depth++;
        else if (c === 93 || c === 125) {
          depth--;
          if (depth === 0) {
            p++;
            break scan;
          }
        } else if (c === 35 && (p === 0 || t.charCodeAt(p - 1) <= SP)) {
          const nl = t.indexOf("\n", p);
          t = t.slice(0, p) + (nl < 0 ? "" : t.slice(nl));
          p--;
          continue;
        }
        if (c > SP) last = c;
      }
      i++;
      if (i >= N) fail("a [ or { is not closed", at);
      t += "\n" + lines[i];
    }
    const after = t.slice(p).trim();
    if (after && after.charCodeAt(0) !== 35) fail("text after the end of a [ ] or { }");
    i++;
    return parseFlow(t.slice(0, p), at);
  }

  function parseFlow(t, at) {
    let p = 0;
    const ws = () => {
      while (p < t.length && t.charCodeAt(p) <= SP) p++;
    };
    const one = (inMap) => {
      ws();
      const c = t.charCodeAt(p);
      if (c === 91) {
        p++;
        const a = [];
        for (;;) {
          ws();
          if (p >= t.length) fail("a [ is not closed", at);
          if (t.charCodeAt(p) === 93) {
            p++;
            return a;
          }
          a.push(one(false));
          ws();
          if (t.charCodeAt(p) === 44) p++;
          else if (t.charCodeAt(p) !== 93) fail("a , or ] was expected in a flow list", at);
        }
      }
      if (c === 123) {
        p++;
        const o = {};
        for (;;) {
          ws();
          if (p >= t.length) fail("a { is not closed", at);
          if (t.charCodeAt(p) === 125) {
            p++;
            return o;
          }
          const k = String(one(true));
          ws();
          let v = null;
          if (t.charCodeAt(p) === 58) {
            p++;
            v = one(false);
          }
          if (k !== "__proto__") o[k] = v;
          ws();
          if (t.charCodeAt(p) === 44) p++;
          else if (t.charCodeAt(p) !== 125) fail("a , or } was expected in a flow map", at);
        }
      }
      if (c === 34 || c === 39) {
        const e = closeFrom(t, p + 1, c);
        if (e < 0) fail("a quoted string is not closed", at);
        const s = unquote(t.slice(p + 1, e).replace(/[ \t]*\n\s*/g, " "), c);
        p = e + 1;
        return s;
      }
      if (c === 42) {
        const m = /^\*([^\s,\]}]+)/.exec(t.slice(p));
        p += m[0].length;
        if (!anchors.has(m[1])) fail("unknown alias", at);
        return anchors.get(m[1]);
      }
      const s0 = p;
      while (p < t.length) {
        const ch = t.charCodeAt(p);
        if (ch === 44 || ch === 93 || ch === 125) break;
        if (ch === 58 && (p + 1 >= t.length || t.charCodeAt(p + 1) <= SP || (inMap && /[,\]}]/.test(t[p + 1])))) break;
        p++;
      }
      return scalar(t.slice(s0, p).trim().replace(/\s*\n\s*/g, " "));
    };
    return one(false);
  }

  // The first document: directives and its `---` are skipped, a second `---` or `...` ends it.
  skip();
  while (i < N && lines[i].charCodeAt(0) === 37) i++;
  skip();
  if (i < N && /^---(\s|$)/.test(lines[i])) {
    const restOf = lines[i].slice(3).trim();
    if (restOf && restOf.charCodeAt(0) !== 35) lines[i] = "    " + restOf;
    else i++;
  }
  for (let k = i; k < N; k++) {
    const l = lines[k];
    const c = l.charCodeAt(0);
    if ((c === 45 && /^---(\s|$)/.test(l)) || (c === 46 && /^\.\.\.(\s|$)/.test(l))) {
      N = k;
      break;
    }
  }
  const v = block(-1);
  skip();
  if (i < N) fail("this line does not belong to what is above it");
  return v;
}
