package com.notai.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.Normalizer

class NotionImporter(
    private val vaultDir: File,
    private val exportRoot: File,
    private val onProgress: (String) -> Unit
) {
    private val NOTION_ID = Regex("""\s+[a-f0-9]{32}($|\.[^.]+$)""", RegexOption.IGNORE_CASE)
    private val IMAGE_FOLDER = Regex("""\s+[a-f0-9]{32}$""", RegexOption.IGNORE_CASE)

    fun scan(): JSONObject {
        val result = JSONObject()
            .put("ok", true)
            .put("databases", JSONArray())
            .put("pages", 0)
            .put("images", 0)
            .put("orphans", 0)
        scanDir(exportRoot, result)
        return result
    }

    private fun scanDir(dir: File, acc: JSONObject) {
        val entries = dir.listFiles() ?: return
        val csvFiles = entries.filter { it.isFile && it.name.endsWith(".csv") && !it.name.endsWith("_all.csv") }

        for (csvFile in csvFiles) {
            val csvBasename = csvFile.nameWithoutExtension
            val dbName = stripId(csvBasename)
            onProgress("Importing \"$dbName\"…")

            val pageDir = entries.firstOrNull { it.isDirectory && (it.name == csvBasename || stripId(it.name) == dbName) }
            val allMds = mutableListOf<MdEntry>()
            if (pageDir != null) collectMds(pageDir, pageDir, allMds)

            val mdByName = buildMdIndex(allMds)

            val csvRows = parseCsv(csvFile.readText())
            if (csvRows.isEmpty()) continue
            val headers = csvRows[0]
            val dataRows = csvRows.drop(1)

            val attColIdx = headers.indexOfFirst { h ->
                listOf("attachment", "files & media", "files", "script/tools", "resources")
                    .any { h.lowercase().contains(it) }
            }

            val vaultDbFolder = safeName(dbName)
            val enrichedRows  = JSONArray()
            val matched       = mutableSetOf<String>()

            for (row in dataRows) {
                if (row.all { it.isBlank() }) continue
                val fields = JSONObject()
                headers.forEachIndexed { i, h -> if (i < row.size) fields.put(h, row[i].trim()) }
                // Notion CSV exports always put the title column first, whatever it is called.
                val pageName  = (fields.optString(headers[0], fields.optString("Name", "")) ?: "").trim()
                val vaultPage = safeName(pageName)
                val found     = findBestMatch(pageName, mdByName)
                if (found != null) matched.add(found.fullPath)

                var mdRel: String? = null

                if (found != null) {
                    val raw     = found.file.readText()
                    val cleaned = stripMetaBlock(raw)
                    val conv    = convertHeadingsToToggles(cleaned)
                    val rewritten = rewriteImagePaths(conv, vaultDbFolder, vaultPage)
                    mdRel       = "$vaultDbFolder/$vaultPage.md"
                    val mdFile  = File(vaultDir, mdRel)
                    mdFile.parentFile?.mkdirs()
                    mdFile.writeText(rewritten)
                    acc.put("pages", acc.getInt("pages") + 1)

                    // Copy image folder
                    val mdDir   = found.file.parentFile ?: pageDir
                    val mdBase  = stripId(found.file.nameWithoutExtension)
                    val imgDir  = mdDir!!.listFiles()
                        ?.firstOrNull { it.isDirectory && isImgFolder(it.name) &&
                            (it.name == mdBase || stripId(it.name) == mdBase) }
                    if (imgDir != null) {
                        val dst = File(vaultDir, "$vaultDbFolder/$vaultPage")
                        copyDir(imgDir, dst)
                        acc.put("images", acc.getInt("images") + imgDir.listFiles()?.size?.coerceAtLeast(0).let { it ?: 0 })
                    }
                }

                // Attachments
                val atts = JSONArray()
                if (attColIdx >= 0 && attColIdx < row.size) {
                    val raw = row[attColIdx].trim()
                    raw.split(",").filter { it.isNotBlank() }.forEach { enc ->
                        try {
                            val decoded  = java.net.URLDecoder.decode(enc.trim(), "UTF-8")
                            val filename = File(decoded).name
                            val src      = File(exportRoot, decoded.replace('/', File.separatorChar))
                            val destRel  = "$vaultDbFolder/_attachments/$filename"
                            val dest     = File(vaultDir, destRel)
                            dest.parentFile?.mkdirs()
                            val exists   = if (src.exists()) { src.copyTo(dest, overwrite = true); true } else false
                            atts.put(JSONObject().put("filename", filename).put("vaultRel", destRel).put("exists", exists))
                        } catch (_: Exception) {}
                    }
                }

                val rowObj = JSONObject()
                headers.forEachIndexed { i, h -> if (i < row.size) rowObj.put(h, row[i].trim()) }
                if (mdRel != null) rowObj.put("_mdRel", mdRel)
                rowObj.put("_attachments", atts)
                enrichedRows.put(rowObj)
            }

            // Orphan MDs
            for (md in allMds) {
                if (matched.contains(md.fullPath)) continue
                val base      = stripId(md.file.nameWithoutExtension)
                val vaultPage = safeName(base)
                val relDir    = File(md.relToBase).parentFile?.path?.replace('\\', '/') ?: ""
                val prefix    = if (relDir.isNotEmpty() && relDir != ".") "$vaultDbFolder/$relDir" else vaultDbFolder
                val raw       = md.file.readText()
                val rewritten = rewriteImagePaths(convertHeadingsToToggles(stripMetaBlock(raw)), prefix, vaultPage)
                val mdFile    = File(vaultDir, "$prefix/$vaultPage.md")
                mdFile.parentFile?.mkdirs()
                mdFile.writeText(rewritten)
                acc.put("orphans", acc.getInt("orphans") + 1)
            }

            // Build DB JSON
            val colTypes = JSONObject()
            headers.filter { it.matches(Regex("^(url|link|href|website|site|reference|ref)s?$", RegexOption.IGNORE_CASE)) }
                .forEach { colTypes.put(it, "url") }

            val db = JSONObject()
                .put("name", dbName)
                .put("headers", JSONArray(headers))
                .put("titleCol", headers[0])
                .put("rows", enrichedRows)
                .put("colTypes", colTypes)

            val dbFile = File(vaultDir, ".notai/databases/${safeName(dbName)}.json")
            dbFile.parentFile?.mkdirs()
            dbFile.writeText(db.toString(2))
            (acc.getJSONArray("databases")).put(dbName)
        }

        // Recurse into non-paired dirs
        val paired = csvFiles.map { it.nameWithoutExtension }.toSet()
        for (e in entries.filter { it.isDirectory && !paired.contains(it.name) }) {
            scanDir(e, acc)
        }
    }

    // ── CSV parser ─────────────────────────────────────────────────────────────

    private fun parseCsv(raw: String): List<List<String>> {
        val text  = raw.trimStart('\uFEFF').replace("\r\n", "\n").replace("\r", "\n")
        val rows  = mutableListOf<MutableList<String>>()
        var row   = mutableListOf<String>()
        var field = StringBuilder()
        var inQ   = false
        var i     = 0
        while (i < text.length) {
            val c = text[i]
            if (inQ) {
                when {
                    c == '"' && i + 1 < text.length && text[i + 1] == '"' -> { field.append('"'); i++ }
                    c == '"'  -> inQ = false
                    c == '\r' -> { /* skip */ }
                    else      -> field.append(c)
                }
            } else {
                when (c) {
                    '"'  -> inQ = true
                    ','  -> { row.add(field.toString()); field = StringBuilder() }
                    '\n' -> { row.add(field.toString()); rows.add(row); row = mutableListOf(); field = StringBuilder() }
                    else -> field.append(c)
                }
            }
            i++
        }
        if (field.isNotEmpty() || row.isNotEmpty()) { row.add(field.toString()); rows.add(row) }
        return rows
    }

    // ── MD file collection ─────────────────────────────────────────────────────

    private data class MdEntry(val file: File, val relToBase: String, val fullPath: String, val depth: Int)

    private fun collectMds(dir: File, base: File, out: MutableList<MdEntry>) {
        dir.listFiles()?.forEach { f ->
            if (f.isFile && f.name.endsWith(".md")) {
                val rel   = f.relativeTo(base).path.replace('\\', '/')
                val depth = rel.count { it == '/' }
                out.add(MdEntry(f, rel, f.absolutePath, depth))
            } else if (f.isDirectory) {
                collectMds(f, base, out)
            }
        }
    }

    private fun buildMdIndex(mds: List<MdEntry>): Map<String, MdEntry> {
        val map = mutableMapOf<String, MdEntry>()
        for (md in mds) {
            val key = stripId(md.file.nameWithoutExtension).lowercase()
            val existing = map[key]
            if (existing == null || md.depth < existing.depth) map[key] = md
        }
        return map
    }

    private fun findBestMatch(csvName: String, index: Map<String, MdEntry>): MdEntry? {
        val candidates = listOf(
            notionNameToFilename(csvName),
            pythonStyle(csvName),
            csvName.replace(Regex("[^a-zA-Z0-9\\s\\-&()]"), " ")
                   .replace(Regex("\\s{2,}"), " ").trim().take(50)
        ).distinct()

        for (c in candidates) {
            val hit = index[c.lowercase()]
            if (hit != null) return hit
        }
        // Fuzzy
        var bestScore = 0.82
        var best: MdEntry? = null
        for ((key, entry) in index) {
            for (c in candidates) {
                val score = similarity(c, key)
                if (score > bestScore) { bestScore = score; best = entry }
            }
        }
        return best
    }

    private fun notionNameToFilename(name: String): String {
        val r = name.replace(":", "").replace("/", " ")
            .replace(Regex("\\.\\s"), " ")
            .replace(Regex("\\s{2,}"), " ").trim()
        return r.take(50).trimEnd()
    }

    private fun pythonStyle(name: String) =
        name.replace(":", "").replace("/", " ").replace(".", " ")
            .replace("[", " ").replace("]", " ").replace("\"", "")
            .replace("C#", "CSharp").replace("C++", "Cpp")
            .replace(Regex("\\s{2,}"), " ").trim().take(50).trimEnd()

    private fun similarity(a: String, b: String): Double {
        val al = a.lowercase(); val bl = b.lowercase()
        if (al == bl) return 1.0
        if (al.isEmpty() || bl.isEmpty()) return 0.0
        var matches = 0
        val used = BooleanArray(bl.length)
        for (ch in al) {
            val idx = bl.indices.firstOrNull { i -> !used[i] && bl[i] == ch } ?: continue
            matches++; used[idx] = true
        }
        return (2.0 * matches) / (al.length + bl.length)
    }

    // ── MD transformations ─────────────────────────────────────────────────────

    private fun stripMetaBlock(md: String): String {
        val metaPat = Regex(
            "^(Attachments?|Categories?|Contents?|ID|Last edited time|Type|Status|Tags?|Date|Author|URL|Due|Priority|Module|Source|Exam|Certifications?)\\s*:",
            RegexOption.IGNORE_CASE
        )
        val lines = md.replace("\r\n", "\n").split("\n").toMutableList()
        var i = 0
        while (i < lines.size && !lines[i].startsWith("# ")) i++
        if (i < lines.size) i++ // skip title line
        while (i < lines.size && lines[i].isBlank()) i++ // skip blank after title
        val start = i
        while (i < lines.size && (metaPat.containsMatchIn(lines[i]) || lines[i].isBlank())) i++
        if (i > start) repeat(i - start) { lines.removeAt(start) }
        return lines.joinToString("\n").replace(Regex("\n{3,}"), "\n\n")
    }

    private fun convertHeadingsToToggles(md: String): String {
        val lines = md.replace("\r\n", "\n").split("\n")
        return convertLevel(lines, 0).joinToString("\n").replace(Regex("\n{3,}"), "\n\n")
    }

    // Mark every line that is a fenced-code-block delimiter or sits inside one,
    // so heading detection can skip them. Without this, a code block
    // containing lines like "# Exploit Title: ..." gets misread as markdown
    // headings and the code block's content is destroyed.
    private fun computeFenceMask(lines: List<String>): BooleanArray {
        val mask = BooleanArray(lines.size)
        var fenceChar: Char? = null
        var fenceLen = 0
        for (i in lines.indices) {
            val s = lines[i].trimStart()
            val m = Regex("^(`{3,}|~{3,})").find(s)
            if (fenceChar != null) {
                mask[i] = true
                if (m != null && m.groupValues[1][0] == fenceChar && m.groupValues[1].length >= fenceLen) {
                    fenceChar = null; fenceLen = 0
                }
            } else if (m != null) {
                mask[i] = true
                fenceChar = m.groupValues[1][0]
                fenceLen = m.groupValues[1].length
            }
        }
        return mask
    }

    private fun convertLevel(lines: List<String>, minLevel: Int): List<String> {
        val fenceMask = computeFenceMask(lines)
        val out = mutableListOf<String>()
        var i = 0
        while (i < lines.size) {
            if (fenceMask[i]) { out.add(lines[i]); i++; continue }
            val line = lines[i]
            val hm = Regex("^(#{1,6})\\s+(.+)$").matchEntire(line)
            if (hm == null) { out.add(line); i++; continue }
            val hashes = hm.groupValues[1]
            val title  = hm.groupValues[2]
            val level  = hashes.length
            val body   = mutableListOf<String>()
            i++
            while (i < lines.size) {
                if (fenceMask[i]) { body.add(lines[i]); i++; continue }
                val next = lines[i]
                val nextHm = Regex("^(#{1,6})\\s+").find(next)
                if (nextHm != null && nextHm.groupValues[1].length <= level) break
                body.add(next)
                i++
            }
            while (body.isNotEmpty() && body.last().isBlank()) body.removeLast()
            val converted = if (body.isNotEmpty()) convertLevel(body, level + 1) else emptyList()
            out.add("- $hashes $title")
            out.add("")
            for (bl in converted) out.add(if (bl.isEmpty()) "" else "    $bl")
            out.add("")
        }
        return out
    }

    // ─── Notion "Enhanced Markdown" support (from the live Notion API) ────────
    // The API's markdown flavor represents toggle LISTS as explicit balanced
    // <details><summary>...</summary>...</details> tags, and toggle HEADINGS as
    // a heading line with a trailing {toggle="true" ...} attribute. Unlike the
    // classic ZIP export (which flattens toggle nesting permanently before we
    // ever see it), this format preserves full nesting — we just convert its
    // representation into our internal "- # Heading" / "- Toggle" bullet syntax.
    //
    // Notion INDENTS child content that sits inside a <details> block (its own
    // docs: "Children must be indented"). That means a toggle HEADING nested
    // inside a toggle LIST is itself an indented line in the raw source — not
    // at column 0. A naive column-0-anchored heading scan never recognizes
    // such a line as a heading, so its {toggle="true"} attribute never gets
    // stripped and it never becomes a nested toggle — it just leaks through
    // as raw text. convertEnhancedBlock below handles both <details> blocks
    // AND headings in one recursive pass, dedenting each block's children to
    // a clean baseline before recursing — so headings are always evaluated
    // relative to their own containing block, at whatever depth.

    // Strip Notion placeholder tags with no useful content of their own:
    // <empty-block/> marks a genuinely empty block and can just be dropped;
    // <unknown url="..." alt="block_type"/> marks an unsupported block type —
    // replaced with a readable note instead of leaking raw tag syntax.
    private fun stripUnsupportedTags(md: String): String {
        var out = md.replace(Regex("<empty-block\\s*/>"), "")
        out = Regex("<unknown\\s+url=\"([^\"]*)\"\\s+alt=\"([^\"]*)\"\\s*/>").replace(out) { m ->
            val url = m.groupValues[1]
            val alt = m.groupValues[2].ifBlank { "content" }
            if (url.isNotBlank()) "*(unsupported $alt — [view in Notion]($url))*" else "*(unsupported $alt)*"
        }
        return out
    }

    // Notion's named text/background colors -> approximate CSS hex values
    // (matches Notion's own UI palette closely enough to be recognizable).
    private val NOTION_COLOR_MAP = mapOf(
        "gray" to "#9B9A97", "brown" to "#64473A", "orange" to "#D9730D", "yellow" to "#DFAB01",
        "green" to "#0F7B6C", "blue" to "#0B6E99", "purple" to "#6940A5", "pink" to "#AD1A72", "red" to "#E03E3E",
        "gray_background" to "#EBECED", "brown_background" to "#E9E5E3", "orange_background" to "#FAEBDD",
        "yellow_background" to "#FBF3DB", "green_background" to "#DDEDEA", "blue_background" to "#DDEBF1",
        "purple_background" to "#EAE4F2", "pink_background" to "#F4DFEB", "red_background" to "#FBE4E4"
    )

    // Notion represents inline text decoration it has no native markdown
    // syntax for as <span attr="value">text</span> — e.g.
    // <span underline="true">text</span> and <span color="Color">text</span>.
    // Our own markdown.js escapes raw < > characters before applying its own
    // formatting rules, so these tags previously leaked through as literal
    // visible text (exactly what was reported). Convert them here into the
    // small, safe subset of raw HTML (<u>, <span style="...">) that
    // markdown.js's inline() parser is taught to recognize and pass through.
    private fun convertInlineSpans(text: String): String =
        Regex("<span([^>]*)>([\\s\\S]*?)</span>").replace(text) { m ->
            val attrs = m.groupValues[1]
            val inner = m.groupValues[2]
            var result = inner
            if (Regex("underline=\"true\"").containsMatchIn(attrs)) result = "<u>$result</u>"
            val colorMatch = Regex("color=\"([^\"]+)\"").find(attrs)
            if (colorMatch != null) {
                val colorName = colorMatch.groupValues[1]
                val css = NOTION_COLOR_MAP[colorName.lowercase()]
                if (css != null) {
                    val prop = if (colorName.lowercase().endsWith("_background")) "background-color" else "color"
                    result = "<span style=\"$prop:$css\">$result</span>"
                }
            }
            result
        }

    // <callout icon="🎯" color="blue_bg">content</callout> -> our existing
    // "> emoji text" callout syntax (markdown.js already recognizes a
    // blockquote whose first line starts with an emoji as a callout).
    private fun convertCallouts(text: String): String =
        Regex("<callout([^>]*)>([\\s\\S]*?)</callout>").replace(text) { m ->
            val attrs = m.groupValues[1]
            val inner = m.groupValues[2]
            val iconMatch = Regex("icon=\"([^\"]*)\"").find(attrs)
            val icon = iconMatch?.groupValues?.get(1) ?: "💡"
            val innerLines = inner.trim().split("\n").map { it.trim() }.filter { it.isNotEmpty() }
            if (innerLines.isEmpty()) "> $icon"
            else innerLines.mapIndexed { idx, l -> if (idx == 0) "> $icon $l" else "> $l" }.joinToString("\n")
        }

    // A real, clickable destination — as opposed to Notion's internal
    // mention reference format confirmed in their own docs example:
    // <mention-user url="{{user://abc123}}">Ada</mention-user>. That "url"
    // is not a web address at all; wrapping it in a markdown link produces
    // an anchor that's syntactically valid but goes nowhere when clicked.
    // Only treat http(s) URLs as real, navigable links.
    private fun isNavigableUrl(url: String): Boolean =
        Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url)

    // <mention-user url="...">Name</mention-user>, <mention-page url="...">Title</mention-user>,
    // and similar mention tags. Mentions can carry either a REAL destination
    // URL (e.g. a bookmark/link mention pointing at an external page) or an
    // internal Notion object reference like {{user://abc123}} / {{page://...}}
    // which is not something a browser can navigate to. Only the former
    // becomes a clickable markdown link — the latter just keeps its plain
    // display text, since a link to a broken internal reference is worse
    // than no link at all. Also guards against Notion serving a broken/
    // unresolvable mention (a deleted page, a removed workspace member)
    // with a literal "undefined" as its display text.
    private fun convertMentions(text: String): String =
        Regex("<mention-(\\w+)([^>]*)>([\\s\\S]*?)</mention-\\1>").replace(text) { m ->
            val type  = m.groupValues[1]
            val attrs = m.groupValues[2]
            val inner = m.groupValues[3]
            val urlMatch = Regex("url=\"([^\"]*)\"").find(attrs)
            val url = urlMatch?.groupValues?.get(1) ?: ""
            val navigable = isNavigableUrl(url)
            var display = inner.trim()
            if (display.isEmpty() || display.lowercase() in setOf("undefined", "null")) {
                display = if (navigable) url.replace(Regex("^https?://", RegexOption.IGNORE_CASE), "").trimEnd('/') else "($type mention)"
            }
            if (navigable) "[$display]($url)" else display
        }

    // Defensive: Notion may also represent some links as raw
    // <a href="...">text</a> HTML rather than standard markdown syntax.
    // Convert any that appear into markdown link syntax. Same
    // navigable-URL guard as mentions — an href that isn't a real web
    // address renders as plain text instead of a dead link.
    private fun convertAnchorTags(text: String): String =
        Regex("<a\\s+([^>]*)>([\\s\\S]*?)</a>").replace(text) { m ->
            val attrs = m.groupValues[1]
            val inner = m.groupValues[2]
            val hrefMatch = Regex("href=\"([^\"]*)\"").find(attrs)
            val url = hrefMatch?.groupValues?.get(1) ?: ""
            val display = inner.trim().ifEmpty { url }
            if (isNavigableUrl(url)) "[$display]($url)" else display
        }

    // Wrapper tags for features we don't render specially (columns, sync
    // blocks, table of contents, etc.) — drop just the tags, keep their
    // inner content so it still goes through normal processing.
    private fun stripPassthroughWrapperTags(text: String): String =
        Regex("</?(?:column-list|column|template|sync-block|breadcrumb|table-of-contents)(?:\\s[^>]*)?>").replace(text, "")

    // Notion allows list items (and other blocks) to carry a trailing
    // {color="Color"} attribute, exactly the same convention as headings.
    // Strip it from bullet/numbered list item lines so it doesn't leak as
    // literal "{color=\"red\"}" text.
    private fun stripListItemAttrs(text: String): String =
        text.split("\n").joinToString("\n") { line ->
            if (Regex("^\\s*(?:\\d+\\.|[-*])\\s").containsMatchIn(line)) {
                val m = Regex("^(.*?)\\s*\\{[^}]*\\}\\s*$").find(line)
                m?.groupValues?.get(1) ?: line
            } else line
        }

    // Clean a single <td>/<th> cell's inner HTML down to single-line
    // pipe-table text: collapse paragraph/line-break tags to spaces (GFM
    // pipe cells can't contain literal newlines), and neutralize literal
    // "|" characters as an HTML entity — our own table parser splits rows
    // on raw "|" with no backslash-escape support, so an unescaped pipe
    // inside cell text would silently corrupt the column count.
    private fun cleanTableCell(html: String): String {
        var s = html
        s = Regex("<br\\s*/?>", RegexOption.IGNORE_CASE).replace(s, " ")
        s = Regex("</p>\\s*<p[^>]*>", RegexOption.IGNORE_CASE).replace(s, " ")
        s = Regex("</?p[^>]*>", RegexOption.IGNORE_CASE).replace(s, "")
        s = Regex("\\s+").replace(s, " ").trim()
        s = s.replace("|", "&#124;")
        return s
    }

    // Notion's Enhanced Markdown represents some tables as raw HTML
    // <table><tr><td>...</td></tr></table> blocks rather than GFM pipe
    // syntax. Our own renderer only understands GFM pipe tables, so without
    // this conversion the raw HTML leaks through as literal visible text.
    // Convert each <table> block into GFM pipe syntax so it flows through
    // the existing, already-working table parser/renderer unchanged.
    private fun convertHtmlTables(text: String): String =
        Regex("<table[^>]*>([\\s\\S]*?)</table>").replace(text) { m ->
            val tableBody = m.groupValues[1]
            val rowMatches = Regex("<tr[^>]*>([\\s\\S]*?)</tr>").findAll(tableBody).toList()
            if (rowMatches.isEmpty()) return@replace ""

            val rows = rowMatches.map { rm ->
                Regex("<t[dh][^>]*>([\\s\\S]*?)</t[dh]>").findAll(rm.groupValues[1])
                    .map { cleanTableCell(it.groupValues[1]) }.toMutableList()
            }.filter { it.isNotEmpty() }
            if (rows.isEmpty()) return@replace ""

            val colCount = rows.maxOf { it.size }
            val padded = rows.map { r -> (r + List(colCount - r.size) { "" }).toMutableList() }
            val header = padded[0]
            val dataRows = padded.drop(1)

            val lines = mutableListOf<String>()
            lines.add("| " + header.joinToString(" | ") + " |")
            lines.add("|" + header.joinToString("|") { " --- " } + "|")
            for (row in dataRows) lines.add("| " + row.joinToString(" | ") + " |")
            "\n" + lines.joinToString("\n") + "\n"
        }

    // Notion's Enhanced Markdown backslash-escapes characters that would
    // otherwise be misread as markdown/XML syntax when they appear as
    // literal text: \ * ~ ` $ [ ] < > { } | ^ (their own docs list this
    // exact set, and state it does NOT apply inside code blocks). Our
    // parser has no escape-sequence handling of its own, so without this
    // these show up as visible literal backslashes in the rendered note.
    // Fence-aware so code block content is left completely alone.
    private fun unescapeNotionChars(md: String): String {
        val lines = md.split("\n")
        val fenceMask = computeFenceMask(lines)
        val escapable = "\\*~`$[]<>{}|^"
        return lines.mapIndexed { i, line ->
            if (fenceMask[i]) return@mapIndexed line
            val out = StringBuilder()
            var j = 0
            while (j < line.length) {
                if (line[j] == '\\' && j + 1 < line.length && escapable.contains(line[j + 1])) {
                    out.append(line[j + 1]); j += 2
                } else {
                    out.append(line[j]); j++
                }
            }
            out.toString()
        }.joinToString("\n")
    }

    private fun preprocessEnhancedMarkdown(md: String): String {
        var out = stripUnsupportedTags(md)
        out = convertHtmlTables(out)
        out = convertCallouts(out)
        out = convertMentions(out)
        out = convertAnchorTags(out)
        out = convertInlineSpans(out)
        out = stripPassthroughWrapperTags(out)
        out = stripListItemAttrs(out)
        out = unescapeNotionChars(out)
        return out
    }

    private fun stripTitleAttrs(title: String): String {
        val m = Regex("^(.*?)\\s*\\{[^}]*\\}\\s*$").find(title)
        return m?.groupValues?.get(1) ?: title
    }

    // Single recursive pass over a flat, BASELINE-RELATIVE line list (the
    // caller has already dedented these lines so "column 0" means "this
    // block's own indentation level"). Handles both <details> toggle-list
    // blocks (balanced tags, indentation-agnostic) and heading toggles (any
    // level, nested or not) in one consistent dedent-then-recurse scheme,
    // while treating fenced code blocks as fully opaque — Notion's own docs
    // are explicit that code block content is literal and must not be
    // reinterpreted, so a code sample containing lines like
    // "# Exploit Title: ..." must never be misread as a markdown heading.
    private fun convertEnhancedBlock(lines: List<String>): List<String> {
        val fenceMask = computeFenceMask(lines)
        val out = mutableListOf<String>()
        var i = 0
        while (i < lines.size) {
            if (fenceMask[i]) { out.add(lines[i]); i++; continue }

            val line = lines[i]
            val stripped = line.trimStart()
            val indentPrefix = line.substring(0, line.length - stripped.length)

            // ── Toggle LIST: explicit <details>/<summary>/</details> ──
            if (Regex("^<details[\\s>]").containsMatchIn(stripped)) {
                var j = i + 1
                var title = "Toggle"
                if (j < lines.size) {
                    val sm = Regex("^<summary>(.*)</summary>$").find(lines[j].trim())
                    if (sm != null) { title = sm.groupValues[1]; j++ }
                }
                var depth = 1
                val bodyLines = mutableListOf<String>()
                while (j < lines.size && depth > 0) {
                    val l = lines[j]
                    val s = l.trimStart()
                    if (Regex("^<details[\\s>]").containsMatchIn(s)) { depth++; bodyLines.add(l) }
                    else if (Regex("^</details>").containsMatchIn(s)) {
                        depth--
                        if (depth == 0) { j++; break }
                        bodyLines.add(l)
                    } else bodyLines.add(l)
                    j++
                }
                val dedented = bodyLines.map { l ->
                    if (l.startsWith(indentPrefix)) l.substring(indentPrefix.length) else l.trimStart()
                }
                val convertedBody = convertEnhancedBlock(dedented)
                out.add(indentPrefix + "- " + title)
                out.add("")
                for (bl in convertedBody) out.add(if (bl.isEmpty()) "" else indentPrefix + "    " + bl)
                out.add("")
                i = j
                continue
            }

            // ── Toggle HEADING (or plain heading): "#{1,6} Title [{attrs}]" ──
            // Matched against the DEDENTED text so a heading nested inside a
            // <details> body (indented in the raw source) is still
            // recognized — this is the fix for {toggle="true"} leaking
            // through as literal text.
            val hm = Regex("^(#{1,6})\\s+(.+)$").matchEntire(stripped)
            if (hm != null) {
                val hashes = hm.groupValues[1]
                val title  = stripTitleAttrs(hm.groupValues[2])
                val level  = hashes.length

                val bodyLines = mutableListOf<String>()
                i++
                while (i < lines.size) {
                    if (fenceMask[i]) { bodyLines.add(lines[i]); i++; continue }
                    val nextStripped = lines[i].trimStart()
                    val nextIndent   = lines[i].substring(0, lines[i].length - nextStripped.length)
                    val nextHm       = Regex("^(#{1,6})\\s+").find(nextStripped)
                    // A subsequent heading only ends this one's scope if it's
                    // at the SAME OR SHALLOWER indentation (a sibling/
                    // ancestor) — a heading indented deeper is nested
                    // content, not a scope boundary, regardless of level.
                    if (nextHm != null && nextIndent.length <= indentPrefix.length &&
                        nextHm.groupValues[1].length <= level) break
                    bodyLines.add(lines[i])
                    i++
                }
                while (bodyLines.isNotEmpty() && bodyLines.last().isBlank()) bodyLines.removeAt(bodyLines.size - 1)

                val dedented = bodyLines.map { l ->
                    if (l.startsWith(indentPrefix)) l.substring(indentPrefix.length) else l.trimStart()
                }
                val convertedBody = if (dedented.isNotEmpty()) convertEnhancedBlock(dedented) else emptyList()

                out.add(indentPrefix + "- " + hashes + " " + title)
                out.add("")
                for (bl in convertedBody) out.add(if (bl.isEmpty()) "" else indentPrefix + "    " + bl)
                out.add("")
                continue
            }

            out.add(line)
            i++
        }
        return out
    }

    // Full pipeline: Notion Enhanced Markdown (from the API) -> our internal toggle syntax.
    fun convertEnhancedMarkdownToToggles(md: String): String {
        val cleaned   = preprocessEnhancedMarkdown(md.replace("\r\n", "\n"))
        val converted = convertEnhancedBlock(cleaned.split("\n"))
        return converted.joinToString("\n").replace(Regex("\n{3,}"), "\n\n")
    }

    private fun rewriteImagePaths(md: String, dbFolder: String, pageName: String): String =
        md.replace(Regex("!\\[([^\\]]*)\\]\\(([^)]+)\\)")) { m ->
            val alt  = m.groupValues[1]
            val href = m.groupValues[2]
            if (href.startsWith("http")) return@replace m.value
            try {
                val decoded  = java.net.URLDecoder.decode(href, "UTF-8")
                val imgFile  = File(decoded).name
                "![$alt](notai-img://$dbFolder/$pageName/$imgFile)"
            } catch (_: Exception) { m.value }
        }

    // ── Utils ──────────────────────────────────────────────────────────────────

    private fun stripId(name: String) = NOTION_ID.replace(name, "").trim()
    private fun isImgFolder(name: String) = !IMAGE_FOLDER.containsMatchIn(name)
    private fun safeName(n: String) =
        n.replace(Regex("[<>:\"/\\\\|?*\\x00-\\x1f]"), "_").take(200).ifBlank { "Untitled" }

    private fun copyDir(src: File, dst: File) {
        dst.mkdirs()
        src.listFiles()?.forEach { f ->
            if (f.isFile) f.copyTo(File(dst, f.name), overwrite = true)
            else if (f.isDirectory) copyDir(f, File(dst, f.name))
        }
    }
}
