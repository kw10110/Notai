// RFC4180 CSV parser — handles quoted fields, embedded commas/newlines, \r\n line endings
(function () {
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    text = text.replace(/^\uFEFF/, ''); // strip BOM
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }  // escaped quote
          else inQuotes = false;                            // end of field
        } else if (c === '\r') { /* drop \r inside quotes — \r\n becomes \n */ }
        else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip bare \r */ }
        else field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return { headers: [], records: [] };
    const headers = rows[0];
    const records = rows.slice(1).filter(r => r.some(v => v !== '')).map(r => {
      const o = {};
      headers.forEach((h, idx) => { o[h] = r[idx] !== undefined ? r[idx] : ''; });
      return o;
    });
    return { headers, records };
  }
  window.CSV = { parseCSV };
})();
