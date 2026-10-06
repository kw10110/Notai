// NotAI markdown parser — built for precise Notion export fidelity.
// Supports: headings, toggles (Notion format), code blocks with lang pills,
// tables (GFM), images (with notai-img:// vault protocol), todo, lists,
// blockquotes/callouts, inline formatting.
(function () {

  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ─── Syntax highlighting for fenced code blocks ────────────────────────────
  // Lightweight, dependency-free, single-pass tokenizer. Operates on the RAW
  // (unescaped) code text and escapes each fragment individually as it builds
  // the output, wrapping recognized tokens in <span class="tok-TYPE"> for CSS
  // styling. Unsupported languages fall back to plain escaped text.

  const LANG_ALIASES = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', py3: 'python',
    sh: 'bash', shell: 'bash', zsh: 'bash', bashrc: 'bash', bash_profile: 'bash',
    yml: 'yaml',
    cplusplus: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', 'c#': 'csharp',
    rb: 'ruby',
    rs: 'rust',
    golang: 'go',
    htm: 'html'
  };

  const CURLY_KEYWORDS = {
    javascript: ['const','let','var','function','return','if','else','for','while','do','switch','case','default','break','continue','class','extends','new','this','super','import','export','from','as','async','await','try','catch','finally','throw','typeof','instanceof','in','of','yield','static','get','set','void','delete','null','undefined','true','false'],
    typescript: ['const','let','var','function','return','if','else','for','while','do','switch','case','default','break','continue','class','extends','implements','new','this','super','import','export','from','as','async','await','try','catch','finally','throw','typeof','instanceof','in','of','yield','static','get','set','void','delete','null','undefined','true','false','interface','type','enum','namespace','declare','abstract','private','public','protected','readonly'],
    java: ['public','private','protected','class','interface','extends','implements','static','final','void','new','return','if','else','for','while','do','switch','case','default','break','continue','try','catch','finally','throw','throws','import','package','this','super','null','true','false','abstract','synchronized','volatile','enum','instanceof'],
    c: ['int','char','float','double','void','long','short','unsigned','signed','struct','union','enum','typedef','const','static','extern','return','if','else','for','while','do','switch','case','default','break','continue','goto','sizeof','include','define'],
    cpp: ['int','char','float','double','void','long','short','unsigned','signed','struct','union','enum','typedef','const','static','extern','return','if','else','for','while','do','switch','case','default','break','continue','goto','sizeof','namespace','class','public','private','protected','template','new','delete','this','virtual','override','nullptr','true','false','using','include'],
    csharp: ['public','private','protected','internal','class','interface','static','void','new','return','if','else','for','foreach','while','do','switch','case','default','break','continue','try','catch','finally','throw','using','namespace','this','base','null','true','false','var','async','await'],
    go: ['func','package','import','return','if','else','for','range','switch','case','default','break','continue','var','const','type','struct','interface','map','chan','go','defer','select','nil','true','false','make','len','cap'],
    rust: ['fn','let','mut','return','if','else','for','while','loop','match','break','continue','struct','enum','impl','trait','pub','use','mod','crate','self','Self','const','static','unsafe','async','await','move','where','true','false','None','Some','Ok','Err'],
    php: ['function','return','if','else','elseif','for','foreach','while','do','switch','case','default','break','continue','class','extends','implements','public','private','protected','static','new','echo','print','try','catch','finally','throw','use','namespace','true','false','null']
  };
  const PY_KEYWORDS   = ['def','return','if','elif','else','for','while','break','continue','class','import','from','as','try','except','finally','raise','with','pass','lambda','yield','global','nonlocal','del','assert','async','await','not','and','or','in','is','None','True','False','self'];
  const RUBY_KEYWORDS = ['def','end','return','if','elsif','else','unless','for','while','until','case','when','break','next','class','module','require','require_relative','do','begin','rescue','ensure','raise','yield','self','nil','true','false','and','or','not','then'];
  const BASH_KEYWORDS = ['if','then','else','elif','fi','for','while','do','done','case','esac','function','return','local','export','echo','read','exit','break','continue','in'];
  const SQL_KEYWORDS  = ['SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','ALTER','DROP','JOIN','INNER','LEFT','RIGHT','OUTER','ON','GROUP','BY','ORDER','HAVING','AS','AND','OR','NOT','NULL','IS','IN','LIKE','LIMIT','DISTINCT','UNION','PRIMARY','KEY','FOREIGN','REFERENCES','DEFAULT'];

  const LINE_COMMENT_LANGS  = new Set(['javascript','typescript','java','c','cpp','csharp','go','rust','php']);
  const HASH_COMMENT_LANGS  = new Set(['python','bash','ruby','yaml']);
  const BLOCK_COMMENT_LANGS = new Set(['javascript','typescript','java','c','cpp','csharp','go','rust','php','css']);

  function normalizeLang(lang) {
    const l = (lang || '').toLowerCase().trim();
    return LANG_ALIASES[l] || l;
  }

  function getKeywordSet(lang) {
    if (CURLY_KEYWORDS[lang]) return new Set(CURLY_KEYWORDS[lang]);
    if (lang === 'python') return new Set(PY_KEYWORDS);
    if (lang === 'ruby')   return new Set(RUBY_KEYWORDS);
    if (lang === 'bash')   return new Set(BASH_KEYWORDS);
    if (lang === 'sql')    return new Set(SQL_KEYWORDS);
    return null;
  }

  function highlightCode(code, rawLang) {
    const lang = normalizeLang(rawLang);
    if (lang === 'json') return highlightJson(code);
    if (lang === 'css')  return highlightCss(code);
    if (lang === 'html') return highlightHtml(code);
    const keywords = getKeywordSet(lang);
    if (!keywords) return esc(code); // unsupported language — plain escaped text
    return highlightGeneric(code, lang, keywords);
  }

  function highlightGeneric(code, lang, keywords) {
    const hasLineComment  = LINE_COMMENT_LANGS.has(lang);
    const hasHashComment  = HASH_COMMENT_LANGS.has(lang);
    const hasBlockComment = BLOCK_COMMENT_LANGS.has(lang);
    const isSql = lang === 'sql';

    let out = '', i = 0;
    const n = code.length;

    while (i < n) {
      const c = code[i];

      if (hasBlockComment && c === '/' && code[i+1] === '*') {
        const end = code.indexOf('*/', i + 2);
        const stop = end === -1 ? n : end + 2;
        out += `<span class="tok-comment">${esc(code.slice(i, stop))}</span>`;
        i = stop; continue;
      }
      if (hasLineComment && c === '/' && code[i+1] === '/') {
        let end = code.indexOf('\n', i); if (end === -1) end = n;
        out += `<span class="tok-comment">${esc(code.slice(i, end))}</span>`;
        i = end; continue;
      }
      if (hasHashComment && c === '#') {
        let end = code.indexOf('\n', i); if (end === -1) end = n;
        out += `<span class="tok-comment">${esc(code.slice(i, end))}</span>`;
        i = end; continue;
      }
      if (isSql && c === '-' && code[i+1] === '-') {
        let end = code.indexOf('\n', i); if (end === -1) end = n;
        out += `<span class="tok-comment">${esc(code.slice(i, end))}</span>`;
        i = end; continue;
      }

      if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        let j = i + 1;
        while (j < n && code[j] !== quote) { if (code[j] === '\\') j++; j++; }
        const end = Math.min(j + 1, n);
        out += `<span class="tok-string">${esc(code.slice(i, end))}</span>`;
        i = end; continue;
      }

      if (/[0-9]/.test(c) && !/[A-Za-z_$]/.test(code[i-1] || '')) {
        let j = i;
        while (j < n && /[0-9a-fA-Fx.]/.test(code[j])) j++;
        out += `<span class="tok-number">${esc(code.slice(i, j))}</span>`;
        i = j; continue;
      }

      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j++;
        const word = code.slice(i, j);
        const isKeyword = isSql ? keywords.has(word.toUpperCase()) : keywords.has(word);
        let k = j;
        while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
        const isFunctionCall = code[k] === '(' && !isKeyword;

        if (isKeyword) out += `<span class="tok-keyword">${esc(word)}</span>`;
        else if (isFunctionCall) out += `<span class="tok-function">${esc(word)}</span>`;
        else out += esc(word);
        i = j; continue;
      }

      out += esc(c);
      i++;
    }
    return out;
  }

  function highlightJson(code) {
    let out = '', i = 0;
    const n = code.length;
    while (i < n) {
      const c = code[i];
      if (c === '"') {
        let j = i + 1;
        while (j < n && code[j] !== '"') { if (code[j] === '\\') j++; j++; }
        const end = Math.min(j + 1, n);
        const str = code.slice(i, end);
        let k = end;
        while (k < n && /\s/.test(code[k])) k++;
        const isKey = code[k] === ':';
        out += `<span class="${isKey ? 'tok-property' : 'tok-string'}">${esc(str)}</span>`;
        i = end; continue;
      }
      if (/[0-9-]/.test(c)) {
        let j = i;
        while (j < n && /[0-9eE+.-]/.test(code[j])) j++;
        out += `<span class="tok-number">${esc(code.slice(i, j))}</span>`;
        i = j; continue;
      }
      if (code.slice(i, i+4) === 'true' || code.slice(i, i+5) === 'false' || code.slice(i, i+4) === 'null') {
        const word = code.slice(i, i+4) === 'null' ? 'null' : (code.slice(i, i+4) === 'true' ? 'true' : 'false');
        out += `<span class="tok-keyword">${esc(word)}</span>`;
        i += word.length; continue;
      }
      out += esc(c); i++;
    }
    return out;
  }

  function highlightCss(code) {
    let out = '', i = 0;
    const n = code.length;
    while (i < n) {
      const c = code[i];
      if (c === '/' && code[i+1] === '*') {
        const end = code.indexOf('*/', i + 2);
        const stop = end === -1 ? n : end + 2;
        out += `<span class="tok-comment">${esc(code.slice(i, stop))}</span>`;
        i = stop; continue;
      }
      if (c === '"' || c === "'") {
        const quote = c; let j = i + 1;
        while (j < n && code[j] !== quote) { if (code[j] === '\\') j++; j++; }
        const end = Math.min(j + 1, n);
        out += `<span class="tok-string">${esc(code.slice(i, end))}</span>`;
        i = end; continue;
      }
      if (/[A-Za-z-]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9-]/.test(code[j])) j++;
        const word = code.slice(i, j);
        let k = j;
        while (k < n && /\s/.test(code[k])) k++;
        if (code[k] === ':') out += `<span class="tok-property">${esc(word)}</span>`;
        else out += esc(word);
        i = j; continue;
      }
      out += esc(c); i++;
    }
    return out;
  }

  function highlightHtml(code) {
    let out = '', i = 0;
    const n = code.length;
    while (i < n) {
      if (code.slice(i, i+4) === '<!--') {
        const end = code.indexOf('-->', i);
        const stop = end === -1 ? n : end + 3;
        out += `<span class="tok-comment">${esc(code.slice(i, stop))}</span>`;
        i = stop; continue;
      }
      if (code[i] === '<') {
        let j = i + 1;
        while (j < n && code[j] !== '>') j++;
        const stop = Math.min(j + 1, n);
        out += highlightHtmlTag(code.slice(i, stop));
        i = stop; continue;
      }
      out += esc(code[i]); i++;
    }
    return out;
  }

  function highlightHtmlTag(tag) {
    let out = '', i = 0;
    const n = tag.length;
    out += esc(tag[0]); i = 1; // '<'
    if (tag[i] === '/') { out += esc('/'); i++; }
    let j = i;
    while (j < n && /[A-Za-z0-9-]/.test(tag[j])) j++;
    out += `<span class="tok-keyword">${esc(tag.slice(i, j))}</span>`;
    i = j;
    while (i < n) {
      const c = tag[i];
      if (c === '"' || c === "'") {
        const quote = c; let k = i + 1;
        while (k < n && tag[k] !== quote) k++;
        const end = Math.min(k + 1, n);
        out += `<span class="tok-string">${esc(tag.slice(i, end))}</span>`;
        i = end; continue;
      }
      if (/[A-Za-z-]/.test(c)) {
        let k = i;
        while (k < n && /[A-Za-z0-9-]/.test(tag[k])) k++;
        out += `<span class="tok-property">${esc(tag.slice(i, k))}</span>`;
        i = k; continue;
      }
      out += esc(c); i++;
    }
    return out;
  }

  function inline(s) {
    // NOTE: we escape & < > first, then handle block patterns.
    // For notai-img paths: capture BEFORE escaping so the path is raw.
    // We handle notai-img FIRST, before the global escape, to preserve the path.
    let out = s;

    // 1. Extract vault images before any escaping (path may contain raw chars)
    const vaultImgPlaceholders = [];
    out = out.replace(/!\[([^\]]*)\]\(notai-img:\/\/([^)]+)\)/g, (_, alt, vaultRel) => {
      const idx = vaultImgPlaceholders.length;
      vaultImgPlaceholders.push({ alt, vaultRel });
      return `\x00VAULTIMG${idx}\x00`;
    });

    // 2. Extract external images before escaping too
    const extImgPlaceholders = [];
    out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (_, alt, src) => {
      const idx = extImgPlaceholders.length;
      extImgPlaceholders.push({ alt, src });
      return `\x00EXTIMG${idx}\x00`;
    });

    // 2b. Extract underline and colored-span passthrough HTML before escaping.
    // Inner content is fully processed recursively (bold/italic/code/etc still
    // work inside an underlined or colored run) — without this, these two safe
    // HTML tags would have their < > escaped by step 3 below and show up as
    // literal visible text instead of being rendered.
    //
    // IMPORTANT: these two tag types are extracted in a SINGLE combined pass,
    // not two separate sequential passes. When one is nested inside the
    // other (e.g. a colored span wrapping an underlined run — exactly what
    // Notion produces for "bold + underline + color" combined formatting),
    // a two-pass approach breaks: the first pass (say, underline) replaces
    // its match with a placeholder token; the second pass (colorspan) then
    // captures THAT PLACEHOLDER TOKEN as its "inner" content and recursively
    // calls inline() on it — but that recursive call gets a brand new, EMPTY
    // underlinePlaceholders array (each inline() call is a fresh scope), so
    // it can't resolve the token from the outer call's array. Restoring an
    // out-of-bounds array index (`arr[0]` on an empty array) yields
    // JavaScript's `undefined`, which the template literal then coerces to
    // the literal string "undefined" — exactly the bug that was reported.
    // A single combined pass means a nested tag is always captured whole as
    // part of the OUTER tag's raw inner text, so the recursive inline() call
    // sees real, untouched markup and resolves everything within its own
    // self-contained scope, at any nesting depth or order.
    const wrapPlaceholders = [];
    out = out.replace(
      /<u>([\s\S]*?)<\/u>|<span style="(color|background-color):([^"]+)">([\s\S]*?)<\/span>/g,
      (_m, uInner, spanProp, spanCss, spanInner) => {
        const idx = wrapPlaceholders.length;
        if (uInner !== undefined) {
          wrapPlaceholders.push({ kind: 'u', html: inline(uInner) });
        } else {
          wrapPlaceholders.push({ kind: 'span', prop: spanProp, css: spanCss, html: inline(spanInner) });
        }
        return `\x00WRAP${idx}\x00`;
      }
    );

    // 3. Now escape HTML entities
    out = out.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // 4. Inline code, bold, italic, strike, links
    out = out
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<![*_])\*([^*\n]+)\*(?![*_])/g, '<em>$1</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a href="$2" target="_blank">$2</a>');

    // 5. Restore image placeholders with properly un-escaped paths
    out = out.replace(/\x00VAULTIMG(\d+)\x00/g, (_, i) => {
      const { alt, vaultRel } = vaultImgPlaceholders[+i];
      const safeAlt = alt.replace(/"/g, '&quot;');
      // data-loaded="0" is the guard used by loadVaultImages — NOT img.src
      return `<img class="vault-img" data-vault="${vaultRel}" data-loaded="0" alt="${safeAlt}" style="max-width:100%;border-radius:4px;margin:8px 0;display:block"/>`;
    });
    out = out.replace(/\x00EXTIMG(\d+)\x00/g, (_, i) => {
      const { alt, src } = extImgPlaceholders[+i];
      return `<img src="${src}" alt="${alt.replace(/"/g,'&quot;')}" style="max-width:100%;border-radius:4px;margin:8px 0;display:block"/>`;
    });
    out = out.replace(/\x00WRAP(\d+)\x00/g, (_, i) => {
      const w = wrapPlaceholders[+i];
      if (w.kind === 'u') return `<u>${w.html}</u>`;
      return `<span style="${w.prop}:${w.css}">${w.html}</span>`;
    });

    return out;
  }

  function getIndent(line) { return (line.match(/^(\s*)/) || ['',''])[1].length; }

  // Detect and parse a GFM table block starting at index i
  // Returns { html, nextIndex } or null if not a table
  function tryParseTable(lines, i, end, baseIndent) {
    const getLine = (idx) => baseIndent > 0 ? lines[idx].slice(baseIndent) : lines[idx];
    const l0 = getLine(i).trim();
    if (!l0.startsWith('|')) return null;
    if (i + 1 >= end) return null;
    const l1 = getLine(i + 1).trim();
    if (!/^\|[\s\-:|]+\|/.test(l1)) return null;

    // Parse header row
    const parseRow = (line) =>
      line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

    const headers = parseRow(l0);
    // Parse alignment from separator row
    const aligns = parseRow(l1).map(c => {
      if (/^:-+:$/.test(c)) return 'center';
      if (/^-+:$/.test(c)) return 'right';
      return 'left';
    });

    let j = i + 2;
    const dataRows = [];
    while (j < end) {
      const l = getLine(j).trim();
      if (!l.startsWith('|')) break;
      dataRows.push(parseRow(l));
      j++;
    }

    let html = '<div class="table-wrap"><table class="md-table"><thead><tr>';
    headers.forEach((h, ci) => {
      html += `<th style="text-align:${aligns[ci]||'left'}">${inline(h)}</th>`;
    });
    html += '</tr></thead><tbody>';
    dataRows.forEach(row => {
      html += '<tr>';
      headers.forEach((_, ci) => {
        const val = row[ci] !== undefined ? row[ci] : '';
        html += `<td style="text-align:${aligns[ci]||'left'}">${inline(val)}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return { html, nextIndex: j };
  }

  // Core recursive parser
  function parse(lines, start, end, baseIndent) {
    const out = [];
    let i = start;

    while (i < end) {
      const raw = lines[i];
      if (baseIndent > 0 && raw.trim() !== '' && getIndent(raw) < baseIndent) break;
      const line = baseIndent > 0 ? raw.slice(baseIndent) : raw;
      const trimmed = line.trim();

      // blank
      if (trimmed === '') { i++; continue; }

      // fenced code block
      if (/^```/.test(trimmed)) {
        const lang = trimmed.slice(3).trim();
        const buf = []; i++;
        while (i < end) {
          const cl = (baseIndent > 0 ? lines[i].slice(baseIndent) : lines[i]);
          if (/^```\s*$/.test(cl.trim())) { i++; break; }
          buf.push(cl); i++;
        }
        const langPill = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
        out.push(`<pre data-lang="${esc(lang)}">${langPill}<code>${highlightCode(buf.join('\n'), lang)}</code></pre>`);
        continue;
      }

      // Embedded database / linked sub-page (written by the Notion importer)
      const dbEmb = trimmed.match(/^::database\[(.+)\]$/);
      if (dbEmb) { out.push(`<div class="db-embed" contenteditable="false" data-db="${esc(dbEmb[1])}"></div>`); i++; continue; }
      const noteEmb = trimmed.match(/^::note\[(.+)\]$/);
      if (noteEmb) { out.push(`<div class="note-embed" contenteditable="false" data-rel="${esc(noteEmb[1])}"></div>`); i++; continue; }

      // GFM table
      if (trimmed.startsWith('|')) {
        const tbl = tryParseTable(lines, i, end, baseIndent);
        if (tbl) { out.push(tbl.html); i = tbl.nextIndex; continue; }
      }

      // headings
      const hm = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (hm) {
        const lvl = Math.min(hm[1].length, 3);
        out.push(`<h${lvl}>${inline(hm[2])}</h${lvl}>`);
        i++; continue;
      }

      // hr
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { out.push('<hr/>'); i++; continue; }

      // ordered list
      if (/^\d+\.\s+/.test(trimmed)) {
        const items = [];
        while (i < end) {
          const l = (baseIndent > 0 ? lines[i].slice(baseIndent) : lines[i]).trim();
          if (!/^\d+\.\s+/.test(l)) break;
          items.push(`<li>${inline(l.replace(/^\d+\.\s+/, ''))}</li>`);
          i++;
        }
        out.push(`<ol>${items.join('')}</ol>`); continue;
      }

      // bullet / toggle / todo
      if (/^[-*]\s/.test(trimmed)) {
        const bulletAbsIndent = getIndent(raw);
        const content = trimmed.replace(/^[-*]\s+/, '');

        // todo
        const todm = content.match(/^\[([ xX])\]\s+(.*)$/);
        if (todm) {
          const checked = todm[1].toLowerCase() === 'x' ? ' checked' : '';
          out.push(`<div class="todo"><input type="checkbox"${checked}/><span>${inline(todm[2])}</span></div>`);
          i++; continue;
        }

        // toggle detection — two conditions either of which makes it a toggle:
        // 1. Classic: a non-blank indented line follows (body has content)
        // 2. Heading-pattern bullet: "- # Heading" or "- ## Heading" (always a toggle even if empty)
        let j = i + 1;
        while (j < end && lines[j].trim() === '') j++;
        const hasIndentedBody = j < end && lines[j].trim() !== '' && getIndent(lines[j]) >= bulletAbsIndent + 4;
        const isHeadingBullet = /^#{1,6}\s/.test(content);
        const isToggle = hasIndentedBody || isHeadingBullet;

        if (isToggle) {
          let bodyEnd = j;
          while (bodyEnd < end) {
            const bl = lines[bodyEnd];
            if (bl.trim() === '') { bodyEnd++; continue; }
            if (getIndent(bl) >= bulletAbsIndent + 4) { bodyEnd++; continue; }
            break;
          }
          const bodyHtml = parse(lines, j, bodyEnd, bulletAbsIndent + 4);
          // Detect heading class: content starts with "#" through "######"
          const hm = content.match(/^(#{1,6})\s+(.*)$/);
          let cls = 'toggle', summaryContent = inline(content);
          if (hm) {
            const lvl = hm[1].length;
            cls = `toggle toggle-h${lvl}`;
            summaryContent = inline(hm[2]);
          }
          out.push(`<details class="${cls}" open><summary>${summaryContent}</summary><div class="toggle-body">${bodyHtml}</div></details>`);
          i = bodyEnd; continue;
        }

        // plain bullets
        const items = [];
        while (i < end) {
          const bl = (baseIndent > 0 ? lines[i].slice(baseIndent) : lines[i]);
          const blt = bl.trim();
          if (!/^[-*]\s/.test(blt)) break;
          if (/^[-*]\s+\[[ xX]\]/.test(blt)) break;
          const bi = getIndent(lines[i]);
          let nj = i + 1;
          while (nj < end && lines[nj].trim() === '') nj++;
          if (nj < end && lines[nj].trim() !== '' && getIndent(lines[nj]) >= bi + 4) break;
          items.push(`<li>${inline(blt.replace(/^[-*]\s+/, ''))}</li>`);
          i++;
        }
        if (items.length) out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      // blockquote / callout
      if (/^>/.test(trimmed)) {
        const buf = [];
        while (i < end) {
          const l = (baseIndent > 0 ? lines[i].slice(baseIndent) : lines[i]).trim();
          if (!/^>/.test(l)) break;
          buf.push(l.replace(/^>\s?/, '')); i++;
        }
        const joined = buf.join(' ');
        const emojiM = joined.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u);
        if (emojiM) {
          out.push(`<div class="callout">${emojiM[0].trim()}<span>${inline(joined.slice(emojiM[0].length))}</span></div>`);
        } else {
          out.push(`<blockquote>${inline(joined)}</blockquote>`);
        }
        continue;
      }

      // plain paragraph
      out.push(`<p>${inline(trimmed)}</p>`);
      i++;
    }
    return out.join('\n');
  }

  function mdToHtml(md) {
    const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
    return parse(lines, 0, lines.length, 0);
  }

  // After rendering HTML into the DOM, call this to lazy-load vault images via IPC.
  // Uses data-loaded="0"/"1" as the guard — NOT img.src, because browsers resolve
  // src="" to the current page URL making it always truthy.
  async function loadVaultImages(container) {
    const imgs = container.querySelectorAll('img.vault-img[data-vault]');
    for (const img of imgs) {
      if (img.dataset.loaded === '1') continue;   // already loaded
      const vaultRel = img.dataset.vault;
      if (!vaultRel) continue;
      img.dataset.loaded = '1';                   // mark immediately to prevent double-load
      try {
        const dataUri = await window.api.loadImage(vaultRel);
        if (dataUri) {
          img.src = dataUri;
        } else {
          img.outerHTML = `<div class="img-missing">⚠ Image not found: ${vaultRel}</div>`;
        }
      } catch (e) {
        img.outerHTML = `<div class="img-missing">⚠ Failed to load: ${vaultRel}</div>`;
      }
    }
  }

  // HTML → Markdown (save edited content back to .md)
  function htmlToMd(root) {
    const out = [];

    function inlineToMd(el) {
      let s = '';
      el.childNodes.forEach(c => {
        if (c.nodeType === 3) { s += c.textContent; return; }
        if (c.nodeType !== 1) return;
        const t = c.tagName.toLowerCase();
        const inner = inlineToMd(c);
        if (t === 'strong' || t === 'b') s += `**${inner}**`;
        else if (t === 'em' || t === 'i') s += `*${inner}*`;
        else if (t === 'code') s += `\`${inner}\``;
        else if (t === 'del') s += `~~${inner}~~`;
        else if (t === 'u') s += `<u>${inner}</u>`;
        else if (t === 'a') s += `[${inner}](${c.getAttribute('href') || ''})`;
        else if (t === 'br') s += '\n';
        else if (t === 'img') {
          const vault = c.dataset.vault;
          if (vault) s += `![${c.alt || ''}](notai-img://${vault})`;
          else if (c.src && !c.src.startsWith('data:')) s += `![${c.alt || ''}](${c.getAttribute('src') || ''})`;
          // skip data: URI imgs (they're vault images with src already filled in)
        }
        else if (t === 'span' && c.classList.contains('code-lang')) { /* skip pill */ }
        else if (t === 'span' && (c.style.color || c.style.backgroundColor)) {
          const prop = c.style.backgroundColor ? 'background-color' : 'color';
          const css  = c.style.backgroundColor || c.style.color;
          s += `<span style="${prop}:${css}">${inner}</span>`;
        }
        else s += inner;
      });
      return s.trim();
    }

    function walk(node, indent) {
      node.childNodes.forEach(n => {
        if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push(indent + t); return; }
        if (n.nodeType !== 1) return;
        const tag = n.tagName.toLowerCase();
        switch (tag) {
          case 'h1': out.push(indent + '# ' + inlineToMd(n)); break;
          case 'h2': out.push(indent + '## ' + inlineToMd(n)); break;
          case 'h3': out.push(indent + '### ' + inlineToMd(n)); break;
          case 'p': { const t = inlineToMd(n); out.push(t ? indent + t : ''); break; }
          case 'div': {
            if (n.classList.contains('db-embed')) {
              out.push(indent + `::database[${n.dataset.db || ''}]`);
            } else if (n.classList.contains('note-embed')) {
              out.push(indent + `::note[${n.dataset.rel || ''}]`);
            } else if (n.classList.contains('todo')) {
              const cb = n.querySelector('input[type="checkbox"]');
              const span = n.querySelector('span');
              out.push(indent + `- [${cb && cb.checked ? 'x' : ' '}] ${span ? inlineToMd(span) : ''}`);
            } else if (n.classList.contains('callout')) {
              const span = n.querySelector('span');
              const emoji = n.childNodes[0] ? n.childNodes[0].textContent.trim() : '';
              out.push(indent + `> ${emoji} ${span ? inlineToMd(span) : ''}`);
            } else if (n.classList.contains('table-wrap')) {
              // Tables: convert back to pipe format
              const rows = n.querySelectorAll('tr');
              rows.forEach((tr, ri) => {
                const cells = Array.from(tr.querySelectorAll('th,td')).map(c => inlineToMd(c));
                out.push(indent + '| ' + cells.join(' | ') + ' |');
                if (ri === 0) out.push(indent + '| ' + cells.map(() => '---').join(' | ') + ' |');
              });
            } else { const t = inlineToMd(n); if (t) out.push(indent + t); }
            break;
          }
          case 'ul': n.querySelectorAll(':scope > li').forEach(li => out.push(indent + '- ' + inlineToMd(li))); break;
          case 'ol': { let k = 1; n.querySelectorAll(':scope > li').forEach(li => out.push(indent + (k++) + '. ' + inlineToMd(li))); break; }
          case 'blockquote': out.push(indent + '> ' + inlineToMd(n)); break;
          case 'pre': {
            const lang = n.dataset.lang || '';
            const codeEl = n.querySelector('code');
            const code = codeEl ? codeEl.textContent : n.textContent;
            out.push(indent + '```' + lang);
            code.split('\n').forEach(l => out.push(indent + l));
            out.push(indent + '```');
            break;
          }
          case 'hr': out.push(indent + '---'); break;
          case 'details': {
            const sum  = n.querySelector(':scope > summary');
            const body = n.querySelector(':scope > .toggle-body');
            // Detect heading level from class then from injected h-child
            let hLevel = 0;
            if (n.classList.contains('toggle-h1')) hLevel = 1;
            else if (n.classList.contains('toggle-h2')) hLevel = 2;
            else if (n.classList.contains('toggle-h3')) hLevel = 3;
            else if (n.classList.contains('toggle-h4')) hLevel = 4;
            else if (n.classList.contains('toggle-h5')) hLevel = 5;
            else if (n.classList.contains('toggle-h6')) hLevel = 6;
            if (!hLevel && sum) {
              const hChild = sum.querySelector('h1,h2,h3,h4,h5,h6');
              if (hChild) hLevel = parseInt(hChild.tagName[1], 10);
            }
            let sumText = '';
            if (sum) {
              const hChild = sum.querySelector('h1,h2,h3,h4,h5,h6');
              sumText = hChild ? inlineToMd(hChild) : inlineToMd(sum);
            }
            const prefix = hLevel ? '#'.repeat(hLevel) + ' ' : '';
            out.push(indent + '- ' + prefix + sumText);
            out.push('');
            const beforeLen = out.length;
            if (body) walk(body, indent + '    ');
            // Empty body: emit a sentinel indented blank so the parser
            // can detect this bullet as a toggle (not a plain list item)
            if (out.length === beforeLen) out.push(indent + '    ');
            out.push('');
            break;
          }
          default: { const t = inlineToMd(n); if (t) out.push(indent + t); }
        }
      });
    }

    walk(root, '');
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  window.MD = { mdToHtml, htmlToMd, loadVaultImages };
})();
