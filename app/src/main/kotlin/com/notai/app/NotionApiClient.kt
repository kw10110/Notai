package com.notai.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Kotlin client for the Notion API using only java.net.HttpURLConnection
 * (no extra dependency). Mirrors notionApi.js on the desktop side exactly:
 * search, retrieve-page-as-markdown (with truncation follow-up), database
 * data-source discovery, and paginated row queries.
 *
 * Uses Notion's official "Enhanced Markdown" endpoint, which represents
 * toggles as explicit balanced <details>/<summary> tags and toggle headings
 * as a {toggle="true"} attribute — this is what preserves full nesting,
 * unlike the classic ZIP export which flattens it before we ever see it.
 */
class NotionApiClient(private val token: String) {

    companion object {
        private const val HOST = "https://api.notion.com"
        private const val NOTION_VERSION = "2026-03-11"
        private var lastRequestAt = 0L
        private const val MIN_GAP_MS = 350L // ~3 req/sec average, matches Notion's limit
    }

    class NotionApiException(message: String) : Exception(message)

    private fun throttle() {
        val wait = lastRequestAt + MIN_GAP_MS - System.currentTimeMillis()
        if (wait > 0) Thread.sleep(wait)
        lastRequestAt = System.currentTimeMillis()
    }

    private fun request(method: String, urlPath: String, body: JSONObject? = null): JSONObject {
        var retries = 0
        while (true) {
            throttle()
            val conn = (URL(HOST + urlPath).openConnection() as HttpURLConnection)
            conn.requestMethod = method
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Notion-Version", NOTION_VERSION)
            conn.setRequestProperty("Content-Type", "application/json")
            conn.connectTimeout = 20000
            conn.readTimeout = 30000
            if (body != null) {
                conn.doOutput = true
                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body.toString()) }
            }

            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val text = stream?.let { BufferedReader(InputStreamReader(it, Charsets.UTF_8)).readText() } ?: ""

            if (status == 429) {
                if (retries >= 5) throw NotionApiException("Notion API rate limit exceeded — try again shortly.")
                val retryAfter = conn.getHeaderField("Retry-After")?.toIntOrNull() ?: 2
                Thread.sleep(retryAfter * 1000L)
                retries++
                continue
            }
            if (status >= 400) {
                val msg = try { JSONObject(text).optString("message", text) } catch (_: Exception) { text }
                throw NotionApiException("Notion API $status: $msg")
            }
            return try { JSONObject(text) } catch (_: Exception) { JSONObject() }
        }
    }

    // ── Public API ───────────────────────────────────────────────────────────

    fun verifyToken(): JSONObject = request("GET", "/v1/users/me")

    data class SearchItem(
        val id: String,
        val type: String,        // normalized: 'page' | 'database'
        val title: String,
        val icon: String?,
        val isDataSource: Boolean // true if the raw object was 'data_source' (queryable directly)
    )

    // allPages: when true, paginate through every result page instead of
    // stopping at the first 100 — used for the "Databases" filter so
    // "select all" really means all databases in the workspace, not just
    // whichever batch happened to be returned first.
    //
    // `type` here is our UI-level concept ('page' | 'database'). Notion's
    // actual search filter no longer accepts "database" as a value — since
    // databases were split into containers + data sources, the API only
    // filters on "page" or "data_source". Map 'database' -> 'data_source'
    // when building the request; it also requires an explicit in_trash field.
    fun search(query: String?, type: String? = null, allPages: Boolean = false): List<SearchItem> {
        val body = JSONObject().put("page_size", 100)
        if (!query.isNullOrBlank()) body.put("query", query)
        if (type != null) {
            val apiValue = if (type == "database") "data_source" else type
            body.put("filter", JSONObject()
                .put("value", apiValue)
                .put("property", "object")
                .put("in_trash", false))
        }

        val rawResults = mutableListOf<JSONObject>()
        var cursor: String? = null
        var pages = 0
        val maxPages = if (allPages) 20 else 1 // safety cap: up to 2000 results when paginating fully
        do {
            if (cursor != null) body.put("start_cursor", cursor) else body.remove("start_cursor")
            val json = request("POST", "/v1/search", body)
            val results = json.optJSONArray("results") ?: JSONArray()
            for (i in 0 until results.length()) rawResults.add(results.getJSONObject(i))
            cursor = if (json.optBoolean("has_more", false)) json.optString("next_cursor") else null
            pages++
        } while (cursor != null && pages < maxPages)

        val out = mutableListOf<SearchItem>()
        for (r in rawResults) {
            val rawType = r.optString("object")
            out.add(SearchItem(
                id = r.optString("id"),
                // Notion's current API model splits a "database" into a container
                // plus one or more "data_source" objects, and search can return
                // either shape. Normalize both to 'database' for display/import —
                // isDataSource tells import whether it can query this id directly.
                type = if (rawType == "data_source") "database" else rawType,
                isDataSource = rawType == "data_source",
                title = extractTitle(r),
                icon = r.optJSONObject("icon")?.optString("emoji")
            ))
        }
        return out
    }

    private fun extractTitle(obj: JSONObject): String {
        val objType = obj.optString("object")
        // Database AND data_source objects: title lives in obj.title[]
        if (objType == "database" || objType == "data_source") {
            val titleArr = obj.optJSONArray("title")
            if (titleArr != null) {
                val sb = StringBuilder()
                for (i in 0 until titleArr.length()) sb.append(titleArr.getJSONObject(i).optString("plain_text"))
                if (sb.isNotEmpty()) return sb.toString()
            }
        }
        val props = obj.optJSONObject("properties")
        if (props != null) {
            for (key in props.keys()) {
                val prop = props.getJSONObject(key)
                // Row property VALUES look like {type:'title', title:[...richtext]}.
                // Schema property DEFINITIONS have title:{} (empty object, not an
                // array) so this only matches actual page/row titles, not schemas.
                if (prop.optString("type") == "title") {
                    val titleArr = prop.optJSONArray("title") ?: continue
                    val sb = StringBuilder()
                    for (i in 0 until titleArr.length()) sb.append(titleArr.getJSONObject(i).optString("plain_text"))
                    if (sb.isNotEmpty()) return sb.toString()
                }
            }
        }
        val name = obj.optString("name", "")
        if (name.isNotBlank()) return name
        return if (objType == "database" || objType == "data_source") "Untitled database" else "Untitled"
    }

    /** Fetch a page's full content as Enhanced Markdown, following truncation until complete. */
    fun getPageMarkdown(pageId: String, onProgress: (String) -> Unit): String {
        var markdown = StringBuilder()
        var idsToFetch = listOf(pageId)
        var guard = 0
        while (idsToFetch.isNotEmpty() && guard < 25) {
            guard++
            val nextRound = mutableListOf<String>()
            for (id in idsToFetch) {
                val json = request("GET", "/v1/pages/$id/markdown")
                if (markdown.isNotEmpty()) markdown.append("\n")
                markdown.append(json.optString("markdown", ""))
                if (json.optBoolean("truncated", false)) {
                    val unknownIds = json.optJSONArray("unknown_block_ids")
                    if (unknownIds != null && unknownIds.length() > 0) {
                        onProgress("Fetching remaining content (${unknownIds.length()} sections)…")
                        for (i in 0 until unknownIds.length()) nextRound.add(unknownIds.getString(i))
                    }
                }
            }
            idsToFetch = nextRound
        }
        return markdown.toString()
    }

    /**
     * A "database" is a container; rows live in one or more "data sources".
     * If isDataSource is true (from search), the id is already directly
     * queryable — skip the extra lookup entirely.
     */
    fun getDataSources(databaseId: String, isDataSource: Boolean = false): List<String> {
        if (isDataSource) return listOf(databaseId)
        val json = request("GET", "/v1/databases/$databaseId")
        val sources = json.optJSONArray("data_sources")
        if (sources != null && sources.length() > 0) {
            val out = mutableListOf<String>()
            for (i in 0 until sources.length()) out.add(sources.getJSONObject(i).optString("id"))
            return out
        }
        return listOf(databaseId) // older API shape: queryable directly
    }

    data class SchemaColumn(val name: String, val type: String)
    data class DataSourceSchema(val titleCol: String, val columns: List<SchemaColumn>)

    /**
     * Fetch a data source's SCHEMA (property definitions, not row values) so
     * columns come out in Notion's own defined order with correct types —
     * rather than inferring order/type purely from row contents, which loses
     * information and can vary row-to-row.
     */
    fun getDataSourceSchema(dataSourceId: String): DataSourceSchema {
        val json = try {
            request("GET", "/v1/data_sources/$dataSourceId")
        } catch (e: Exception) {
            request("GET", "/v1/databases/$dataSourceId") // older API shape
        }
        val props = json.optJSONObject("properties") ?: JSONObject()
        var titleCol = "Name"
        val columns = mutableListOf<SchemaColumn>()
        for (name in props.keys()) {
            val def = props.getJSONObject(name)
            val type = def.optString("type")
            if (type == "title") titleCol = name
            columns.add(SchemaColumn(name, type))
        }
        return DataSourceSchema(titleCol, columns)
    }

    fun queryDataSourceAll(dataSourceId: String, onProgress: (String) -> Unit): List<JSONObject> {
        val rows = mutableListOf<JSONObject>()
        var cursor: String? = null
        var page = 0
        do {
            page++
            onProgress("Loading database rows (page $page)…")
            val body = JSONObject().put("page_size", 100)
            if (cursor != null) body.put("start_cursor", cursor)
            val json = try {
                request("POST", "/v1/data_sources/$dataSourceId/query", body)
            } catch (e: Exception) {
                request("POST", "/v1/databases/$dataSourceId/query", body) // fallback for older API versions
            }
            val results = json.optJSONArray("results") ?: JSONArray()
            for (i in 0 until results.length()) rows.add(results.getJSONObject(i))
            cursor = if (json.optBoolean("has_more", false)) json.optString("next_cursor") else null
        } while (cursor != null)
        return rows
    }

    data class FileRef(val name: String, val url: String)

    /**
     * Extract downloadable {name, url} pairs from a 'files' property so we can
     * actually download them as real attachments — this is what makes an
     * imported Attachments column behave like a real attachment column
     * instead of a plain-text list of filenames.
     */
    fun extractFileUrls(prop: JSONObject?): List<FileRef> {
        if (prop == null || prop.optString("type") != "files") return emptyList()
        val arr = prop.optJSONArray("files") ?: return emptyList()
        val out = mutableListOf<FileRef>()
        for (i in 0 until arr.length()) {
            val f = arr.getJSONObject(i)
            val name = f.optString("name", "file")
            val url = f.optJSONObject("file")?.optString("url")
                ?: f.optJSONObject("external")?.optString("url")
            if (!url.isNullOrBlank()) out.add(FileRef(name, url))
        }
        return out
    }

    /** Convert a Notion page-properties object into a flat column-name -> string map. */
    fun propertiesToFields(properties: JSONObject?): Map<String, String> {
        val fields = mutableMapOf<String, String>()
        if (properties == null) return fields
        for (name in properties.keys()) {
            fields[name] = propertyToString(properties.getJSONObject(name))
        }
        return fields
    }

    // Same palette used for inline text/highlight color in page content
    // (see NotionImporter.kt) — duplicated here so this client stays
    // self-contained.
    private val PROPERTY_COLOR_MAP = mapOf(
        "gray" to "#9B9A97", "brown" to "#64473A", "orange" to "#D9730D", "yellow" to "#DFAB01",
        "green" to "#0F7B6C", "blue" to "#0B6E99", "purple" to "#6940A5", "pink" to "#AD1A72", "red" to "#E03E3E",
        "gray_background" to "#EBECED", "brown_background" to "#E9E5E3", "orange_background" to "#FAEBDD",
        "yellow_background" to "#FBF3DB", "green_background" to "#DDEDEA", "blue_background" to "#DDEBF1",
        "purple_background" to "#EAE4F2", "pink_background" to "#F4DFEB", "red_background" to "#FBE4E4"
    )

    // Notion's rich_text array items carry per-run formatting in an
    // "annotations" object (bold/italic/underline/strikethrough/code/color)
    // plus an optional "href". Database property values previously used
    // only plain_text, silently discarding all of this. Convert each run
    // into our own markup conventions (matching the page-content pipeline)
    // so formatting survives into database cells too.
    private fun annotatedTextToMarkup(item: JSONObject): String {
        var text = item.optString("plain_text", "")
        if (text.isEmpty()) return ""
        val a = item.optJSONObject("annotations")
        val href = item.optString("href", "").ifBlank { null }

        if (a?.optBoolean("code") == true) text = "`$text`"
        if (a?.optBoolean("bold") == true) text = "**$text**"
        if (a?.optBoolean("italic") == true) text = "*$text*"
        if (a?.optBoolean("strikethrough") == true) text = "~~$text~~"
        if (href != null) text = "[$text]($href)"
        if (a?.optBoolean("underline") == true) text = "<u>$text</u>"
        val color = a?.optString("color", "default") ?: "default"
        if (color != "default") {
            val css = PROPERTY_COLOR_MAP[color]
            if (css != null) {
                val prop = if (color.endsWith("_background")) "background-color" else "color"
                text = "<span style=\"$prop:$css\">$text</span>"
            }
        }
        return text
    }

    private fun richTextArrayToMarkup(arr: JSONArray?): String {
        if (arr == null) return ""
        val sb = StringBuilder()
        for (i in 0 until arr.length()) sb.append(annotatedTextToMarkup(arr.getJSONObject(i)))
        return sb.toString()
    }

    private fun propertyToString(prop: JSONObject): String {
        return when (prop.optString("type")) {
            "title" -> richTextArrayToMarkup(prop.optJSONArray("title"))
            "rich_text" -> richTextArrayToMarkup(prop.optJSONArray("rich_text"))
            "select" -> prop.optJSONObject("select")?.optString("name") ?: ""
            "multi_select" -> {
                val arr = prop.optJSONArray("multi_select") ?: return ""
                (0 until arr.length()).joinToString(", ") { arr.getJSONObject(it).optString("name") }
            }
            "status" -> prop.optJSONObject("status")?.optString("name") ?: ""
            "people" -> {
                val arr = prop.optJSONArray("people") ?: return ""
                (0 until arr.length()).joinToString(", ") {
                    val p = arr.getJSONObject(it)
                    p.optString("name").ifBlank { p.optString("id") }
                }
            }
            "date" -> {
                val d = prop.optJSONObject("date") ?: return ""
                val start = d.optString("start", "")
                val end = d.optString("end", "")
                if (end.isNotBlank()) "$start → $end" else start
            }
            "checkbox" -> if (prop.optBoolean("checkbox")) "Yes" else "No"
            "number" -> if (prop.has("number") && !prop.isNull("number")) prop.optDouble("number").let {
                if (it == it.toLong().toDouble()) it.toLong().toString() else it.toString()
            } else ""
            "url" -> prop.optString("url", "")
            "email" -> prop.optString("email", "")
            "phone_number" -> prop.optString("phone_number", "")
            "files" -> {
                val arr = prop.optJSONArray("files") ?: return ""
                (0 until arr.length()).joinToString(", ") { arr.getJSONObject(it).optString("name") }
            }
            "relation" -> {
                val arr = prop.optJSONArray("relation") ?: return ""
                (0 until arr.length()).joinToString(", ") { arr.getJSONObject(it).optString("id") }
            }
            "formula" -> {
                val f = prop.optJSONObject("formula") ?: return ""
                val t = f.optString("type")
                propertyToString(JSONObject().put("type", t).put(t, f.opt(t)))
            }
            "rollup" -> {
                val r = prop.optJSONObject("rollup") ?: return ""
                if (r.optString("type") == "array") {
                    val arr = r.optJSONArray("array") ?: return ""
                    (0 until arr.length()).joinToString(", ") { propertyToString(arr.getJSONObject(it)) }
                } else {
                    val t = r.optString("type")
                    propertyToString(JSONObject().put("type", t).put(t, r.opt(t)))
                }
            }
            else -> ""
        }
    }

    /** Download raw bytes from a pre-signed URL (images/files expire quickly — grab immediately). */
    fun downloadBytes(url: String): ByteArray {
        var currentUrl = url
        var redirects = 0
        while (redirects < 5) {
            val conn = (URL(currentUrl).openConnection() as HttpURLConnection)
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 20000
            conn.readTimeout = 30000
            val status = conn.responseCode
            if (status in 300..399) {
                currentUrl = conn.getHeaderField("Location") ?: throw NotionApiException("Redirect with no Location")
                redirects++
                continue
            }
            if (status >= 400) throw NotionApiException("Download failed: HTTP $status")
            return conn.inputStream.readBytes()
        }
        throw NotionApiException("Too many redirects downloading $url")
    }
}
