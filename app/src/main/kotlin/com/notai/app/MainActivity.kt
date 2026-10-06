package com.notai.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.*
import android.provider.OpenableColumns
import android.webkit.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.util.zip.ZipInputStream

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val prefs by lazy { getSharedPreferences("notai", Context.MODE_PRIVATE) }

    private val sandboxRoot: File
        get() = File(getExternalFilesDir(null), "NotAIVault").also { it.mkdirs() }

    // Null when no vault has been chosen yet → shows setup screen in renderer
    private val vaultDir: File?
        get() {
            val sub = prefs.getString("vaultSub", null) ?: return null
            return File(sandboxRoot, sub)
        }

    private val dbDir: File?
        get() = vaultDir?.let { File(it, ".notai/databases").also { d -> d.mkdirs() } }

    private var pendingCallId   = -1
    private var pendingPickMode = ""
    private var pendingDbName   = ""

    // ── Launchers ──────────────────────────────────────────────────────────────

    private val pickVaultDir = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri ->
        if (uri == null) { deliverNull(pendingCallId); return@registerForActivityResult }
        io {
            try {
                progress("Copying vault into app storage…")
                contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                )
                val tree = DocumentFile.fromTreeUri(this, uri)
                    ?: run { deliverNull(pendingCallId); return@io }
                val folderName = safeName(tree.name ?: "Vault")
                android.util.Log.d("NotAI", "Vault pick: folder='$folderName' childCount=${tree.listFiles().size}")
                val dest = File(sandboxRoot, folderName).also { it.mkdirs() }
                prefs.edit().putString("vaultSub", folderName).apply()
                val copied = copyDocumentTree(tree, dest)
                // Count what actually landed in the sandbox
                val mdCount = dest.walkTopDown().count { it.isFile && it.name.endsWith(".md") }
                val dbCount = File(dest, ".notai/databases").listFiles { f -> f.name.endsWith(".json") }?.size ?: 0
                android.util.Log.d("NotAI", "Vault copied: files=$copied md=$mdCount databases=$dbCount dest=${dest.absolutePath}")
                progress("Vault ready — $mdCount notes, $dbCount databases.")
                // Electron's chooseVault returns the vault path string directly
                deliverString(pendingCallId, dest.absolutePath)
            } catch (e: Exception) {
                android.util.Log.e("NotAI", "Vault pick failed", e)
                deliverNull(pendingCallId)
            }
        }
    }

    private val pickFiles = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        if (uris.isNullOrEmpty()) { deliverResult(pendingCallId, "[]"); return@registerForActivityResult }
        when (pendingPickMode) {
            "importMd"     -> handleImportMd(uris)
            "importNotion" -> handleImportNotion(uris.firstOrNull())
            "attachment"   -> handlePickAttachment(uris)
        }
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Let the system inset the content normally (below status bar, above nav bar).
        // fitsSystemWindows="true" on the WebView (in the layout) does the work —
        // no manual padding needed. This is the reliable non-immersive approach.
        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webView)

        with(webView.settings) {
            javaScriptEnabled   = true
            domStorageEnabled   = true
            allowFileAccess     = true
            allowContentAccess  = true
            @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = true
            @Suppress("DEPRECATION") allowFileAccessFromFileURLs      = true
            setSupportZoom(false)
            builtInZoomControls  = false
            displayZoomControls  = false
            useWideViewPort      = true
            loadWithOverviewMode = true
            mixedContentMode     = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode            = WebSettings.LOAD_NO_CACHE
        }

        webView.addJavascriptInterface(Bridge(), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            // Every rendered link in a note uses target="_blank" (see inline()
            // in markdown.js). Without handling this, the WebView either does
            // nothing when clicked, or — worse — navigates its OWN content
            // away to the external site, replacing the note view entirely.
            // Intercept any http(s) navigation attempt and launch it in the
            // system browser instead, leaving the note untouched.
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val url = req.url.toString()
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, req.url))
                    } catch (_: Exception) { /* no app can handle it — silently ignore */ }
                    return true // handled — do not let the WebView navigate itself
                }
                return false
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                android.util.Log.d("NotAI",
                    "[${msg.messageLevel()}] ${msg.message()} @ ${msg.sourceId()}:${msg.lineNumber()}")
                return true
            }

            // target="_blank" links create a new "window" from the WebView's
            // perspective. Without support for multiple windows enabled and
            // this handler, such clicks are silently swallowed — nothing
            // happens at all when tapped. Route them through the same
            // shouldOverrideUrlLoading path by loading the URL into a
            // throwaway hidden WebView whose only job is to report the
            // target URL back so it can be opened externally.
            override fun onCreateWindow(
                view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message
            ): Boolean {
                val newWebView = WebView(this@MainActivity)
                newWebView.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
                        val url = req.url.toString()
                        if (url.startsWith("http://") || url.startsWith("https://")) {
                            try { startActivity(Intent(Intent.ACTION_VIEW, req.url)) } catch (_: Exception) {}
                        }
                        return true
                    }
                }
                val transport = resultMsg.obj as WebView.WebViewTransport
                transport.webView = newWebView
                resultMsg.sendToTarget()
                return true
            }
        }
        webView.settings.setSupportMultipleWindows(true)

        sandboxRoot.mkdirs()
        webView.loadUrl("file:///android_asset/www/index.html")
    }

    override fun onBackPressed() {
        // First step back through the app's own history (notes / databases), like the on-screen back button.
        webView.evaluateJavascript("(window._navBackIfPossible && window._navBackIfPossible()) === true") { handled ->
            if (handled != "true") {
                if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
            }
        }
    }

    // ── Deliver helpers ────────────────────────────────────────────────────────

    /**
     * Deliver a pre-formed JSON value string to a JS callback.
     * The string is passed as a single-quoted JS string, so it gets JSON.parse'd
     * in api_bridge.js → resolve(JSON.parse(result)).
     */
    private fun deliver(callId: Int, jsonResult: String) {
        val safe = jsonResult
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "")
        runOnUiThread {
            webView.evaluateJavascript(
                "if(window._bridgeCb&&window._bridgeCb[$callId])window._bridgeCb[$callId]('$safe')",
                null)
        }
    }

    /**
     * Deliver a plain Kotlin String so JS receives it as a string (not an object).
     * Wraps the value in JSON string quotes so api_bridge JSON.parse returns a string.
     * Matches what Electron IPC returns for note:read, note:create, etc.
     */
    private fun deliverString(callId: Int, value: String) {
        // Build JSON string literal: "escaped_value"
        val inner = value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "")
        // Outer single-quotes for the JS string context; inner \" for JSON string literal
        val outer = inner.replace("'", "\\'")
        runOnUiThread {
            webView.evaluateJavascript(
                "if(window._bridgeCb&&window._bridgeCb[$callId])window._bridgeCb[$callId]('\"$outer\"')",
                null)
        }
    }

    private fun deliverResult(callId: Int, json: String) = deliver(callId, json)

    private fun deliverNull(callId: Int) {
        runOnUiThread {
            webView.evaluateJavascript(
                "if(window._bridgeCb&&window._bridgeCb[$callId])window._bridgeCb[$callId](null)",
                null)
        }
    }

    private fun progress(msg: String) {
        val safe = msg.replace("'", "\\'")
        runOnUiThread {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('notai-progress',{detail:'$safe'}))",
                null)
        }
    }

    private fun io(block: () -> Unit) = Thread(block).start()

    // ── JavaScript Bridge ──────────────────────────────────────────────────────
    // Return types match Electron IPC EXACTLY so renderer.js works unchanged.

    inner class Bridge {

        // Electron returns: { vaultPath: string, darkMode: bool }
        // renderer.js uses: s.vaultPath — empty string → shows setup screen
        @JavascriptInterface
        fun getSettings(callId: Int, argsJson: String) {
            deliver(callId, JSONObject()
                .put("vaultPath", vaultDir?.absolutePath ?: "")
                .put("darkMode", false)
                .toString())
        }

        // Electron returns: string (vault path) or null
        @JavascriptInterface
        fun chooseVault(callId: Int, argsJson: String) {
            pendingCallId   = callId
            pendingPickMode = "vault"
            pickVaultDir.launch(null)
        }

        // Electron returns: Array<{rel, name, mtime}>
        @JavascriptInterface
        fun listVault(callId: Int, argsJson: String) {
            io {
                val vault = vaultDir ?: run { deliver(callId, "[]"); return@io }
                val notes = JSONArray()
                walkVault(vault, vault, notes)
                deliver(callId, notes.toString())
            }
        }

        // Electron returns: string (file content) — NOT an object
        @JavascriptInterface
        fun readNote(callId: Int, argsJson: String) {
            io {
                val rel   = JSONArray(argsJson).getString(0)
                val vault = vaultDir ?: run { deliverString(callId, ""); return@io }
                val file  = resolveNoteFile(vault, rel)
                deliverString(callId, file?.readText() ?: "")
            }
        }

        // Electron returns: string (file content) or null
        @JavascriptInterface
        fun readNoteAbs(callId: Int, argsJson: String) {
            io {
                val rel   = JSONArray(argsJson).getString(0)
                val vault = vaultDir ?: run { deliverNull(callId); return@io }
                val file  = resolveNoteFile(vault, rel)
                if (file != null) deliverString(callId, file.readText())
                else deliverNull(callId)
            }
        }

        // Electron returns: true (boolean)
        @JavascriptInterface
        fun writeNote(callId: Int, argsJson: String) {
            io {
                val args  = JSONArray(argsJson)
                val vault = vaultDir ?: run { deliver(callId, "false"); return@io }
                val file  = File(vault, args.getString(0))
                file.parentFile?.mkdirs()
                file.writeText(args.getString(1))
                deliver(callId, "true")
            }
        }

        // Electron returns: string (rel path) — NOT an object
        @JavascriptInterface
        fun createNote(callId: Int, argsJson: String) {
            io {
                val args   = JSONArray(argsJson)
                val title  = args.getString(0)
                val folder = if (!args.isNull(1)) args.getString(1) else null
                val vault  = vaultDir ?: run { deliverNull(callId); return@io }
                val safe   = safeName(title.ifBlank { "Untitled" })
                val dir    = if (folder != null) File(vault, folder) else vault
                dir.mkdirs()
                var file = File(dir, "$safe.md")
                var n = 1
                while (file.exists()) { file = File(dir, "$safe $n.md"); n++ }
                file.writeText("# $title\n\n")
                deliverString(callId, file.relativeTo(vault).path.replace('\\', '/'))
            }
        }

        // Electron returns: string (new rel path) — NOT an object
        @JavascriptInterface
        fun renameNote(callId: Int, argsJson: String) {
            io {
                val args    = JSONArray(argsJson)
                val vault   = vaultDir ?: run { deliverNull(callId); return@io }
                val src     = File(vault, args.getString(0))
                val newName = safeName(args.getString(1))
                val dst     = File(src.parentFile ?: vault, "$newName.md")
                src.renameTo(dst)
                deliverString(callId, dst.relativeTo(vault).path.replace('\\', '/'))
            }
        }

        // Electron returns: true
        @JavascriptInterface
        fun deleteNote(callId: Int, argsJson: String) {
            io {
                val vault = vaultDir ?: run { deliver(callId, "false"); return@io }
                File(vault, JSONArray(argsJson).getString(0)).delete()
                deliver(callId, "true")
            }
        }

        // Electron returns: Array of database objects
        @JavascriptInterface
        fun listDatabases(callId: Int, argsJson: String) {
            io {
                val dir = dbDir ?: run { deliver(callId, "[]"); return@io }
                val arr = JSONArray()
                dir.listFiles { f -> f.name.endsWith(".json") }
                    ?.sortedBy { it.name }
                    ?.forEach { f -> try { arr.put(JSONObject(f.readText())) } catch (_: Exception) {} }
                deliver(callId, arr.toString())
            }
        }

        // Electron returns: true
        @JavascriptInterface
        fun saveDatabase(callId: Int, argsJson: String) {
            io {
                val dir = dbDir ?: run { deliver(callId, "false"); return@io }
                val db  = JSONObject(JSONArray(argsJson).getString(0))
                File(dir, "${safeName(db.getString("name"))}.json").writeText(db.toString(2))
                deliver(callId, "true")
            }
        }

        // Electron returns: true
        @JavascriptInterface
        fun deleteDatabase(callId: Int, argsJson: String) {
            io {
                val dir = dbDir ?: run { deliver(callId, "false"); return@io }
                File(dir, "${safeName(JSONArray(argsJson).getString(0))}.json").delete()
                deliver(callId, "true")
            }
        }

        // Electron returns: true
        @JavascriptInterface
        fun createDbPage(callId: Int, argsJson: String) {
            io {
                // Same contract as Electron's db:createPage: (dbArg, pageName) -> vault-relative path
                val args  = JSONArray(argsJson)
                val vault = vaultDir ?: run { deliverString(callId, ""); return@io }
                val pageName = args.getString(1)
                val rel   = "${dbDirOf(args.getString(0))}/${safeName(pageName)}.md"
                val file  = File(vault, rel).also { it.parentFile?.mkdirs() }
                if (!file.exists()) file.writeText("# $pageName\n\n")
                deliverString(callId, rel)
            }
        }

        // Electron returns: true
        @JavascriptInterface
        fun openAttachment(callId: Int, argsJson: String) {
            val vault = vaultDir ?: run { deliver(callId, "false"); return }
            val rel   = JSONArray(argsJson).getString(0)
            val file  = File(vault, rel)
            if (!file.exists()) { deliver(callId, "false"); return }
            val uri    = FileProvider.getUriForFile(this@MainActivity, "${packageName}.provider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, guessMime(file.name))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(intent, "Open with"))
            deliver(callId, "true")
        }

        // Electron returns: Array<{filename, vaultRel, exists}>
        @JavascriptInterface
        fun pickAttachment(callId: Int, argsJson: String) {
            pendingCallId   = callId
            pendingPickMode = "attachment"
            pendingDbName   = JSONArray(argsJson).optString(0, "attachments")
            pickFiles.launch(arrayOf("*/*"))
        }

        // Electron returns: {filename, vaultRel, exists}
        @JavascriptInterface
        fun copyAttachment(callId: Int, argsJson: String) {
            io {
                val args    = JSONArray(argsJson)
                val vault   = vaultDir ?: run { deliverNull(callId); return@io }
                val srcFile = File(args.getString(0))
                val attDir  = File(vault, "${dbDirOf(args.getString(1))}/_attachments").also { it.mkdirs() }
                val dst     = File(attDir, srcFile.name)
                srcFile.copyTo(dst, overwrite = true)
                deliver(callId, JSONObject()
                    .put("filename", srcFile.name)
                    .put("vaultRel", dst.relativeTo(vault).path.replace('\\', '/'))
                    .put("exists", dst.exists())
                    .toString())
            }
        }

        // Electron returns: data URI string (or null). Reads a vault image file
        // and returns it base64-encoded so the WebView can display it inline.
        @JavascriptInterface
        fun loadImage(callId: Int, argsJson: String) {
            io {
                val rel   = JSONArray(argsJson).getString(0)
                val vault = vaultDir ?: run { deliverNull(callId); return@io }
                // Try exact path, then basename fallback (same as note resolution)
                var file = File(vault, rel)
                if (!file.exists()) {
                    val target = rel.substringAfterLast('/')
                    var match: File? = null
                    vault.walkTopDown().forEach { f ->
                        if (match == null && f.isFile && f.name == target) match = f
                    }
                    if (match != null) file = match!!
                }
                if (!file.exists()) {
                    android.util.Log.w("NotAI", "loadImage: not found '$rel'")
                    deliverNull(callId)
                    return@io
                }
                try {
                    val bytes = file.readBytes()
                    val b64   = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                    val mime  = guessMime(file.name)
                    deliverString(callId, "data:$mime;base64,$b64")
                } catch (e: Exception) {
                    android.util.Log.e("NotAI", "loadImage failed '$rel'", e)
                    deliverNull(callId)
                }
            }
        }

        // Electron returns: true
        @JavascriptInterface
        fun openUrl(callId: Int, argsJson: String) {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(JSONArray(argsJson).getString(0))))
            deliver(callId, "true")
        }

        // Electron returns: Array of imported rel paths
        @JavascriptInterface
        fun importMd(callId: Int, argsJson: String) {
            pendingCallId   = callId
            pendingPickMode = "importMd"
            pickFiles.launch(arrayOf("text/*", "text/markdown", "text/plain", "*/*"))
        }

        // Electron returns: {ok, databases, pages, images, orphans}
        @JavascriptInterface
        fun importNotion(callId: Int, argsJson: String) {
            pendingCallId   = callId
            pendingPickMode = "importNotion"
            pickFiles.launch(arrayOf("application/zip", "application/x-zip-compressed", "*/*"))
        }

        // ── Notion API (live connection, not the ZIP export) ───────────────────
        // Preserves full toggle nesting via Notion's Enhanced Markdown endpoint —
        // see NotionApiClient.kt / NotionApiImporter.kt.

        // Electron returns: string token or null
        @JavascriptInterface
        fun notionGetToken(callId: Int, argsJson: String) {
            val token = prefs.getString("notionToken", null)
            if (token != null) deliverString(callId, token) else deliverNull(callId)
        }

        // Electron returns: {ok: bool, error?: string}
        @JavascriptInterface
        fun notionSetToken(callId: Int, argsJson: String) {
            val token = JSONArray(argsJson).optString(0, "").trim()
            if (token.isEmpty()) {
                prefs.edit().remove("notionToken").apply()
                deliver(callId, JSONObject().put("ok", true).toString())
                return
            }
            io {
                try {
                    NotionApiClient(token).verifyToken()
                    prefs.edit().putString("notionToken", token).apply()
                    deliver(callId, JSONObject().put("ok", true).toString())
                } catch (e: Exception) {
                    deliver(callId, JSONObject().put("ok", false).put("error", e.message ?: "Verification failed").toString())
                }
            }
        }

        // Electron returns: array of {id, type, title, icon, isDataSource}
        @JavascriptInterface
        fun notionSearch(callId: Int, argsJson: String) {
            val args  = JSONArray(argsJson)
            val query = args.optString(0, "")
            val type  = args.optString(1, "").ifBlank { null }
            val token = prefs.getString("notionToken", null)
            if (token == null) { deliver(callId, "[]"); return }
            io {
                try {
                    // When explicitly filtering to databases, fetch every page so
                    // "select all" really means all databases in the workspace.
                    val allPages = type == "database"
                    val items = NotionApiClient(token).search(query.ifBlank { null }, type, allPages)
                    val arr = JSONArray()
                    items.forEach { it2 ->
                        arr.put(JSONObject()
                            .put("id", it2.id)
                            .put("type", it2.type)
                            .put("title", it2.title)
                            .put("icon", it2.icon)
                            .put("isDataSource", it2.isDataSource))
                    }
                    deliver(callId, arr.toString())
                } catch (e: Exception) {
                    deliver(callId, "[]")
                    android.util.Log.e("NotAI", "notionSearch failed", e)
                }
            }
        }

        // items = JSON array of {id, type, title}. Electron returns:
        // {pages, databases, images, errors: []}
        @JavascriptInterface
        fun notionImport(callId: Int, argsJson: String) {
            val itemsJson = JSONArray(JSONArray(argsJson).getString(0))
            val token = prefs.getString("notionToken", null)
            val vault = vaultDir
            if (token == null) {
                deliver(callId, JSONObject().put("errors", JSONArray().put("No Notion token configured.")).toString())
                return
            }
            if (vault == null) {
                deliver(callId, JSONObject().put("errors", JSONArray().put("No vault selected.")).toString())
                return
            }
            io {
                val items = mutableListOf<NotionApiImporter.ImportItem>()
                for (i in 0 until itemsJson.length()) {
                    val o = itemsJson.getJSONObject(i)
                    items.add(NotionApiImporter.ImportItem(
                        o.optString("id"), o.optString("type"), o.optString("title"),
                        o.optBoolean("isDataSource", false)
                    ))
                }
                val client   = NotionApiClient(token)
                val importer = NotionApiImporter(vault, client) { msg -> progress(msg) }
                val result   = importer.importAll(items)
                deliver(callId, result.toString())
            }
        }
    }

    // ── SAF copy ───────────────────────────────────────────────────────────────

    private fun copyDocumentTree(src: DocumentFile, dest: File): Int {
        dest.mkdirs()
        var count = 0
        src.listFiles().forEach { child ->
            val name = child.name ?: return@forEach
            val childDest = File(dest, name)
            if (child.isDirectory) {
                android.util.Log.d("NotAI", "  dir: $name")
                count += copyDocumentTree(child, childDest)
            } else try {
                contentResolver.openInputStream(child.uri)?.use { inp ->
                    childDest.outputStream().use { out -> inp.copyTo(out) }
                }
                count++
            } catch (e: Exception) {
                android.util.Log.e("NotAI", "  copy failed: $name", e)
            }
        }
        return count
    }

    // ── File handlers ──────────────────────────────────────────────────────────

    private fun handleImportMd(uris: List<Uri>) {
        io {
            val vault    = vaultDir ?: sandboxRoot
            val imported = JSONArray()
            for (uri in uris) {
                val name     = getFileName(uri) ?: "Note.md"
                val baseName = name.replace(Regex("\\.(md|txt|markdown)$", RegexOption.IGNORE_CASE), "")
                val rel      = "${safeName(baseName)}.md"
                val text     = contentResolver.openInputStream(uri)?.bufferedReader()?.readText() ?: continue
                File(vault, rel).writeText(text)
                imported.put(rel)   // Electron returns array of rel paths
            }
            deliver(pendingCallId, imported.toString())
        }
    }

    private fun handleImportNotion(uri: Uri?) {
        if (uri == null) { deliverResult(pendingCallId, "{}"); return }
        io {
            progress("Reading zip…")
            val stream = contentResolver.openInputStream(uri)
                ?: run { deliver(pendingCallId, JSONObject().put("ok", false).toString()); return@io }
            val vault  = vaultDir ?: sandboxRoot
            val tmpDir = File(cacheDir, "notion_${System.currentTimeMillis()}").also { it.mkdirs() }
            try {
                extractZip(stream, tmpDir)
                val innerZips = tmpDir.walkTopDown().filter { it.name.endsWith(".zip") }.toList()
                if (innerZips.size == 1) {
                    val inner = File(tmpDir, "inner_${System.currentTimeMillis()}").also { it.mkdirs() }
                    extractZip(innerZips.first().inputStream(), inner)
                    innerZips.first().delete()
                    inner.listFiles()?.forEach { it.copyRecursively(File(tmpDir, it.name), overwrite = true) }
                    inner.deleteRecursively()
                }
                val result = NotionImporter(vault, tmpDir) { msg -> progress(msg) }.scan()
                deliver(pendingCallId, result.toString())
            } catch (e: Exception) {
                deliver(pendingCallId, JSONObject().put("ok", false).put("error", e.message ?: "").toString())
            } finally {
                tmpDir.deleteRecursively()
            }
        }
    }

    private fun handlePickAttachment(uris: List<Uri>) {
        io {
            val vault   = vaultDir ?: sandboxRoot
            val results = JSONArray()
            for (uri in uris) {
                val name   = getFileName(uri) ?: "attachment"
                val attDir = File(vault, "${dbDirOf(pendingDbName)}/_attachments").also { it.mkdirs() }
                val dst    = File(attDir, name)
                contentResolver.openInputStream(uri)?.use { inp ->
                    dst.outputStream().use { out -> inp.copyTo(out) }
                }
                results.put(JSONObject()
                    .put("filename", name)
                    .put("vaultRel", dst.relativeTo(vault).path.replace('\\', '/'))
                    .put("exists", dst.exists()))
            }
            deliver(pendingCallId, results.toString())
        }
    }

    // ── Vault walker ───────────────────────────────────────────────────────────

    private fun walkVault(dir: File, base: File, out: JSONArray) {
        dir.listFiles()?.sortedBy { it.name }?.forEach { f ->
            if (f.name.startsWith(".") || f.name == "_attachments") return@forEach
            if (f.isDirectory) walkVault(f, base, out)
            else if (f.name.endsWith(".md")) {
                out.put(JSONObject()
                    .put("rel",   f.relativeTo(base).path.replace('\\', '/'))
                    .put("name",  f.nameWithoutExtension)
                    .put("mtime", f.lastModified()))
            }
        }
    }

    // ── Utilities ──────────────────────────────────────────────────────────────

    // Resolve a note's .md file: try the exact relative path first, then fall back
    // to matching by filename anywhere in the vault. This handles cases where the
    // database's stored _mdRel doesn't exactly match the file that landed on disk
    // (e.g. character normalization differences after a SAF copy).
    private fun resolveNoteFile(vault: File, rel: String): File? {
        val exact = File(vault, rel)
        if (exact.exists()) return exact
        // Fallback 1: match by full basename (filename with extension)
        val targetName = rel.substringAfterLast('/')
        var match: File? = null
        vault.walkTopDown().forEach { f ->
            if (match != null) return@forEach
            if (f.isFile && f.name == targetName) match = f
        }
        if (match != null) {
            android.util.Log.d("NotAI", "resolveNoteFile: '$rel' not found, matched by name -> ${match!!.relativeTo(vault).path}")
            return match
        }
        // Fallback 2: case-insensitive basename match
        vault.walkTopDown().forEach { f ->
            if (match != null) return@forEach
            if (f.isFile && f.name.equals(targetName, ignoreCase = true)) match = f
        }
        if (match == null) {
            android.util.Log.w("NotAI", "resolveNoteFile: NO match for '$rel' (basename '$targetName')")
        }
        return match
    }

    // A database's folder in the vault. Page-owned (nested) databases carry an explicit
    // vault-relative folder, passed as "folder:<path>"; top-level ones use their own name.
    private fun dbDirOf(arg: String): String =
        if (arg.startsWith("folder:")) arg.removePrefix("folder:").split('/').joinToString("/") { safeName(it) }
        else safeName(arg)

    private fun safeName(n: String) =
        n.replace(Regex("[<>:\"/\\\\|?*\\x00-\\x1f]"), "_").take(200).ifBlank { "Untitled" }

    private fun guessMime(filename: String) =
        when (filename.substringAfterLast('.', "").lowercase()) {
            "pdf"        -> "application/pdf"
            "png"        -> "image/png"
            "jpg","jpeg" -> "image/jpeg"
            "gif"        -> "image/gif"
            "webp"       -> "image/webp"
            "svg"        -> "image/svg+xml"
            "bmp"        -> "image/bmp"
            "txt","md"   -> "text/plain"
            "zip"        -> "application/zip"
            "mp4"        -> "video/mp4"
            "mp3"        -> "audio/mpeg"
            else         -> "*/*"
        }

    private fun getFileName(uri: Uri): String? {
        contentResolver.query(uri, null, null, null, null)?.use { c ->
            val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (c.moveToFirst() && idx >= 0) return c.getString(idx)
        }
        return uri.lastPathSegment
    }

    private fun extractZip(input: InputStream, destDir: File) {
        ZipInputStream(input.buffered()).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                val dest = File(destDir, entry.name)
                if (entry.isDirectory) dest.mkdirs()
                else { dest.parentFile?.mkdirs(); dest.outputStream().use { out -> zip.copyTo(out) } }
                zip.closeEntry()
                entry = zip.nextEntry
            }
        }
    }
}
