package com.notai.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Orchestrates importing pages and databases from the live Notion API into
 * the vault. Mirrors importNotionPage()/importNotionDatabase() in the
 * desktop main.js exactly, using NotionApiClient for the HTTP calls and the
 * Enhanced-Markdown-to-toggle conversion already ported into NotionImporter.
 */
class NotionApiImporter(
    private val vaultDir: File,
    private val client: NotionApiClient,
    private val onProgress: (String) -> Unit
) {
    // Reuse the conversion helpers already implemented on NotionImporter by
    // delegating to a throwaway instance (they don't depend on scan state).
    private val converter = NotionImporter(vaultDir, vaultDir) {}

    data class ImportItem(val id: String, val type: String, val title: String, val isDataSource: Boolean = false, val embeddedIn: String? = null, val key: String? = null, val folder: String? = null)

    fun importAll(items: List<ImportItem>): JSONObject {
        val result = JSONObject()
            .put("pages", 0)
            .put("databases", 0)
            .put("images", 0)
            .put("errors", JSONArray())
        visited.clear()
        visitedPages.clear()

        for (item in items) {
            try {
                if (item.type == "database") {
                    onProgress("Importing database \"${item.title}\"…")
                    importDatabase(item, result)
                } else {
                    onProgress("Importing page \"${item.title}\"…")
                    importPage(item.id, item.title, null, result)
                }
            } catch (e: Exception) {
                result.getJSONArray("errors").put("${item.title}: ${e.message}")
            }
        }
        return result
    }

    // ---- Nested database support -------------------------------------------
    // Notion's Enhanced Markdown represents an embedded/child database as
    //   <database url="https://www.notion.so/...32hex...">Title</database>
    // (data sources: <data-source url="collection://uuid">, possibly nested
    // inside the <database> tag). Mirrors extractNestedDatabases() in notionApi.js.
    private data class NestedSource(val id: String, val isDataSource: Boolean)
    private data class NestedDb(val full: String, val title: String, val sources: List<NestedSource>)
    // key = unique internal id (the vault path); title = the original name shown to the user
    private data class NestedEntry(val key: String, val title: String, val folder: String, val src: NestedSource)
    private data class ChildPage(val full: String, val id: String, val title: String)
    private data class ChildEntry(val id: String, val title: String, val subFolder: String)

    private val visitedPages = mutableSetOf<String>()
    private fun normId(id: String) = id.replace("-", "").lowercase()
    private val pageTagRegex = Regex("<page\\b([^>]*?)(?:/>|>([\\s\\S]*?)</page>)")

    // Data sources already imported during the current run (cycle / duplicate guard).
    private val visited = mutableSetOf<String>()
    private val maxNesting = 5

    private val idRegex = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}")
    private val collectionRegex = Regex("^collection://([0-9a-fA-F-]{32,36})")
    private val tagRegex = Regex("<(database|data-source)\\b([^>]*?)(?:/>|>([\\s\\S]*?)</\\1>)")
    private val innerSourceRegex = Regex("<data-source\\b([^>]*?)(?:/>|>[\\s\\S]*?</data-source>)")
    private val firstChildRegex = Regex("<data-source\\b[^>]*>([\\s\\S]*?)</data-source>")
    private val urlAttrRegex = Regex("\\burl=\"([^\"]*)\"")
    private val anyTagRegex = Regex("<[^>]+>")
    private val fenceLineRegex = Regex("^\\s*(```|~~~)")

    private fun parseRef(url: String?): NestedSource? {
        if (url.isNullOrBlank()) return null
        collectionRegex.find(url)?.let { return NestedSource(it.groupValues[1], true) }
        val clean = url.split('?', '#')[0]
        val last = idRegex.findAll(clean).lastOrNull() ?: return null
        return NestedSource(last.value, false)
    }

    // Character ranges covered by fenced code blocks (tags there are literal text).
    private fun fencedRanges(md: String): List<IntRange> {
        val ranges = mutableListOf<IntRange>()
        var pos = 0
        var open = -1
        for (line in md.split("\n")) {
            if (fenceLineRegex.containsMatchIn(line)) {
                if (open < 0) open = pos else { ranges.add(open..(pos + line.length)); open = -1 }
            }
            pos += line.length + 1
        }
        if (open >= 0) ranges.add(open..md.length)
        return ranges
    }

    private fun extractNestedDatabases(md: String): List<NestedDb> {
        val fences = fencedRanges(md)
        val out = mutableListOf<NestedDb>()
        for (m in tagRegex.findAll(md)) {
            if (fences.any { m.range.first in it }) continue
            val attrs = m.groupValues[2]
            val inner = m.groupValues[3]
            val sources = mutableListOf<NestedSource>()
            for (im in innerSourceRegex.findAll(inner)) {
                parseRef(urlAttrRegex.find(im.groupValues[1])?.groupValues?.get(1))?.let { sources.add(it) }
            }
            if (sources.isEmpty()) {
                parseRef(urlAttrRegex.find(attrs)?.groupValues?.get(1))?.let { sources.add(it) }
            }
            if (sources.isEmpty()) continue
            val titleSrc = firstChildRegex.find(inner)?.groupValues?.get(1) ?: inner
            val title = anyTagRegex.replace(titleSrc, "").trim().ifBlank { "Database" }
            out.add(NestedDb(m.value, title, sources))
        }
        return out
    }


    // Child pages: <page url="https://www.notion.so/Title-32hex">Title</page>
    // (<mention-page ...> is a different tag and is not matched.)
    private fun extractChildPages(md: String): List<ChildPage> {
        val fences = fencedRanges(md)
        val out = mutableListOf<ChildPage>()
        for (m in pageTagRegex.findAll(md)) {
            if (fences.any { m.range.first in it }) continue
            val ref = parseRef(urlAttrRegex.find(m.groupValues[1])?.groupValues?.get(1)) ?: continue
            if (ref.isDataSource) continue
            val title = anyTagRegex.replace(m.groupValues[2], "").trim().ifBlank { "Untitled" }
            out.add(ChildPage(m.value, ref.id, title))
        }
        return out
    }

    // Replace every occurrence of `tag` with block-level lines, keeping the
    // tag's own indentation so a block inside a toggle stays inside it.
    private fun replaceTagWithBlocks(md: String, tag: String, blocks: List<String>): String {
        val sb = StringBuilder()
        var pos = 0
        while (true) {
            val idx = md.indexOf(tag, pos)
            if (idx < 0) break
            val lineStart = md.lastIndexOf('\n', idx - 1) + 1
            val prefix = md.substring(lineStart, idx)
            if (prefix.isBlank()) {
                sb.append(md, pos, lineStart)
                sb.append(blocks.joinToString("\n\n") { prefix + it })
            } else {
                sb.append(md, pos, idx)
                sb.append("\n\n").append(blocks.joinToString("\n\n")).append("\n\n")
            }
            pos = idx + tag.length
        }
        sb.append(md, pos, md.length)
        return sb.toString()
    }

    /** Import a single page: fetch Enhanced Markdown, download images, convert toggles, write .md.
     *  Databases embedded in the page are imported as databases of their own. */
    private fun importPage(pageId: String, title: String, folder: String?, result: JSONObject, depth: Int = 0): String {
        visitedPages.add(normId(pageId))
        var rawMd = client.getPageMarkdown(pageId, onProgress)

        // Debug: save Notion's RAW response exactly as received, before any
        // of our conversion code touches it — ground truth for diagnosing
        // conversion bugs precisely instead of guessing from documentation.
        try {
            val debugDir = File(vaultDir, ".notai/debug-raw").also { it.mkdirs() }
            File(debugDir, "${safeName(title)}.raw.md").writeText(rawMd)
        } catch (_: Exception) { /* best-effort, never block the real import */ }

        // Name each nested database (prefixed with this page's title so that
        // identically-named databases on different rows don't overwrite each
        // other) and swap the raw tag for a readable pointer.
        // This page's own folder: its sub-pages and nested databases live inside it,
        // keeping their original names, e.g. Outer DB/Row/Inner DB/Inner row.md
        val pageFolder = (if (folder != null) "$folder/" else "") + safeName(title)
        val nested = mutableListOf<NestedEntry>()
        if (depth < maxNesting) {
            val usedDbTitles = mutableSetOf<String>()
            for (nd in extractNestedDatabases(rawMd)) {
                val entries = nd.sources.mapIndexed { i, src ->
                    val base = if (nd.sources.size > 1) "${nd.title} (${i + 1})" else nd.title
                    var dbTitle = base
                    var n = 2
                    while (!usedDbTitles.add(safeName(dbTitle))) { dbTitle = "$base (${n++})" }
                    val dbFolder = "$pageFolder/${safeName(dbTitle)}"
                    NestedEntry(dbFolder, dbTitle, dbFolder, src)
                }
                nested.addAll(entries)
                rawMd = replaceTagWithBlocks(rawMd, nd.full, entries.map { "::database[${it.key}]" })
            }
        }

        // Child pages: imported as notes in a sub-folder named after this page,
        // and replaced in the text by a link block that opens the imported note.
        val childPages = mutableListOf<ChildEntry>()
        if (depth < maxNesting) {
            val subFolder = pageFolder
            val usedTitles = mutableSetOf<String>()
            for (cp in extractChildPages(rawMd)) {
                if (normId(cp.id) in visitedPages) {
                    // Already imported (or an ancestor): drop the raw tag, keep the title as text.
                    rawMd = rawMd.replace(cp.full, cp.title)
                    continue
                }
                var ct = cp.title
                var n = 2
                while (!usedTitles.add(safeName(ct))) { ct = "${cp.title} (${n++})" }
                childPages.add(ChildEntry(cp.id, ct, subFolder))
                rawMd = replaceTagWithBlocks(rawMd, cp.full, listOf("::note[$subFolder/${safeName(ct)}.md]"))
            }
        }

        var md = downloadAndRewriteImages(rawMd, folder ?: safeName(title), result)
        md = converter.convertEnhancedMarkdownToToggles(md)

        val vaultPage = safeName(title)
        val rel = if (folder != null) "$folder/$vaultPage.md" else "$vaultPage.md"
        val file = File(vaultDir, rel)
        file.parentFile?.mkdirs()
        file.writeText("# $title\n\n$md")
        result.put("pages", result.getInt("pages") + 1)

        for (cp in childPages) {
            onProgress("Importing sub-page \"${cp.title}\"…")
            try {
                importPage(cp.id, cp.title, cp.subFolder, result, depth + 1)
            } catch (e: Exception) {
                result.getJSONArray("errors").put("Sub-page \"${cp.title}\": ${e.message}")
            }
        }

        for (entry in nested) {
            onProgress("Importing nested database \"${entry.title}\"…")
            try {
                try {
                    importDatabase(ImportItem(entry.src.id, "database", entry.title, entry.src.isDataSource, rel, entry.key, entry.folder), result, depth + 1)
                } catch (e: Exception) {
                    // The URL id may be a data source id rather than a database id.
                    if (entry.src.isDataSource) throw e
                    try {
                        importDatabase(ImportItem(entry.src.id, "database", entry.title, true, rel, entry.key, entry.folder), result, depth + 1)
                    } catch (_: Exception) { throw e }
                }
            } catch (e: Exception) {
                result.getJSONArray("errors").put("Nested database \"${entry.title}\": ${e.message} (is it shared with the integration?)")
            }
        }
        return rel
    }

    /**
     * Import a database: discover its data source(s), pull the SCHEMA (so
     * columns come out in Notion's own order with correct types — not just
     * inferred from row contents), then pull every row's properties + its
     * own page content.
     */
    private fun importDatabase(item: ImportItem, result: JSONObject, depth: Int = 0) {
        val dbName = item.title                       // original name, shown to the user
        val dbKey = item.key ?: item.title            // unique id (JSON file + references)
        val vaultDbFolder = item.folder?.split('/')?.joinToString("/") { safeName(it) } ?: safeName(dbKey)
        val dataSourceIds = client.getDataSources(item.id, item.isDataSource)

        val visitKey = dataSourceIds.sorted().joinToString(",")
        if (!visited.add(visitKey)) {
            onProgress("Skipping \"$dbName\" (already imported)")
            return
        }

        // Pull schema from each data source for column order + types.
        var titleCol = "Name"
        val orderedCols = mutableListOf<NotionApiClient.SchemaColumn>()
        val seenCols = mutableSetOf<String>()
        for (dsId in dataSourceIds) {
            try {
                val schema = client.getDataSourceSchema(dsId)
                titleCol = schema.titleCol
                for (col in schema.columns) {
                    if (seenCols.add(col.name)) orderedCols.add(col)
                }
            } catch (e: Exception) {
                onProgress("Could not read schema for one data source: ${e.message}")
            }
        }

        val allRows = mutableListOf<JSONObject>()
        for (dsId in dataSourceIds) {
            allRows.addAll(client.queryDataSourceAll(dsId, onProgress))
        }
        if (allRows.isEmpty() && item.embeddedIn == null) {
            result.put("databases", result.getInt("databases") + 1)
            return
        }

        // Defensive: pick up any property names present on rows but missing
        // from the schema fetch (e.g. schema call failed above).
        for (row in allRows) {
            val props = row.optJSONObject("properties") ?: continue
            for (name in props.keys()) {
                val type = props.getJSONObject(name).optString("type")
                if (seenCols.add(name)) orderedCols.add(NotionApiClient.SchemaColumn(name, type))
                if (type == "title") titleCol = name
            }
        }

        val nonTitleCols = orderedCols.filter { it.name != titleCol }
        val headers = JSONArray().put(titleCol).also { arr -> nonTitleCols.forEach { arr.put(it.name) } }

        // Column type -> our internal colTypes so cells render/behave
        // correctly: url columns get link-chip rendering; files columns
        // become real attachment columns (not just a text list of filenames).
        val colTypes = JSONObject()
        val urlColRegex = Regex("^(url|link|href|website|site|reference|ref)s?$", RegexOption.IGNORE_CASE)
        for (col in nonTitleCols) {
            when {
                col.type == "url" -> colTypes.put(col.name, "url")
                col.type == "files" -> colTypes.put(col.name, "attachments")
                urlColRegex.matches(col.name.trim()) -> colTypes.put(col.name, "url")
            }
        }

        val enrichedRows = JSONArray()
        var i = 0
        for (row in allRows) {
            i++
            onProgress("Importing \"$dbName\" — row $i/${allRows.size}…")
            val fields = client.propertiesToFields(row.optJSONObject("properties"))
            val pageName = fields[titleCol]?.ifBlank { "Untitled" } ?: "Untitled"

            var mdRel: String? = null
            try {
                mdRel = importPage(row.optString("id"), pageName, vaultDbFolder, result, depth)
            } catch (e: Exception) {
                result.getJSONArray("errors").put("$pageName: ${e.message}")
            }

            // Download real files for any 'files' property so attachment
            // columns actually contain working attachments, not just a
            // filename list.
            val attachments = JSONArray()
            val rowProps = row.optJSONObject("properties")
            for (col in nonTitleCols) {
                if (col.type != "files") continue
                val fileRefs = client.extractFileUrls(rowProps?.optJSONObject(col.name))
                for (f in fileRefs) {
                    try {
                        val bytes = client.downloadBytes(f.url)
                        val attDir = File(vaultDir, "$vaultDbFolder/_attachments").also { it.mkdirs() }
                        val safeFileName = safeName(f.name)
                        File(attDir, safeFileName).writeBytes(bytes)
                        attachments.put(JSONObject()
                            .put("filename", safeFileName)
                            .put("vaultRel", "$vaultDbFolder/_attachments/$safeFileName")
                            .put("exists", true))
                        result.put("images", result.getInt("images") + 1)
                    } catch (e: Exception) {
                        onProgress("Attachment download failed (${f.name}): ${e.message}")
                    }
                }
            }

            val rowObj = JSONObject()
            fields.forEach { (k, v) -> rowObj.put(k, v) }
            if (mdRel != null) rowObj.put("_mdRel", mdRel)
            rowObj.put("_attachments", attachments)
            enrichedRows.put(rowObj)
        }

        val db = JSONObject()
            .put("name", dbKey)
            .put("headers", headers)
            .put("titleCol", titleCol)
            .put("rows", enrichedRows)
            .put("colTypes", colTypes)
        // A database found inside a page belongs to that page: shown inline there, not in the sidebar list.
        if (item.embeddedIn != null) db.put("embedded", true).put("parentRel", item.embeddedIn)

        if (item.key != null || item.folder != null) db.put("title", dbName).put("folder", vaultDbFolder)

        val dbFile = File(vaultDir, ".notai/databases/${safeName(dbKey)}.json")
        dbFile.parentFile?.mkdirs()
        dbFile.writeText(db.toString(2))
        result.put("databases", result.getInt("databases") + 1)
    }

    /**
     * Notion's markdown output embeds pre-signed URLs for images/files that
     * expire quickly. Find them, download immediately, save into the vault,
     * and rewrite the markdown to point at the local copy via the same
     * notai-img:// scheme the ZIP-import path already uses.
     */
    private fun downloadAndRewriteImages(md: String, folderName: String, result: JSONObject): String {
        val regex = Regex("!\\[([^\\]]*)\\]\\((https://[^)]+)\\)")
        val matches = regex.findAll(md).toList()
        if (matches.isEmpty()) return md

        val attDir = File(vaultDir, "$folderName/_images")
        attDir.mkdirs()

        var out = md
        for (m in matches) {
            val full = m.value
            val alt  = m.groupValues[1]
            val url  = m.groupValues[2]
            try {
                val bytes = client.downloadBytes(url)
                val ext = url.substringBefore('?').substringAfterLast('.', "png").take(5)
                val filename = "img_${System.currentTimeMillis()}_${(0..999999).random()}.$ext"
                File(attDir, filename).writeBytes(bytes)
                out = out.replace(full, "![$alt](notai-img://$folderName/_images/$filename)")
                result.put("images", result.getInt("images") + 1)
            } catch (e: Exception) {
                onProgress("Image download failed: ${e.message}")
            }
        }
        return out
    }

    private fun safeName(n: String) =
        n.replace(Regex("[<>:\"/\\\\|?*\\x00-\\x1f]"), "_").take(200).ifBlank { "Untitled" }
}
