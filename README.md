# NotAI Android

Android app wrapping the full NotAI web frontend in a WebView with a native Kotlin bridge for file system access.

**No Flutter required.** This is a plain Android Studio / Gradle project.

## Architecture

```
app/src/main/
├── assets/www/          ← Exact copy of the Electron renderer (HTML/CSS/JS)
│   ├── index.html
│   ├── renderer.js
│   ├── api_bridge.js    ← Replaces window.api (Electron IPC) for Android
│   ├── lib/
│   └── styles/
└── kotlin/com/notai/app/
    ├── MainActivity.kt      ← WebView host + JavascriptInterface bridge
    └── NotionImporter.kt    ← Kotlin port of the Notion ZIP import logic
```

`api_bridge.js` intercepts all `window.api.*` calls and routes them through `window.AndroidBridge` (injected by Kotlin). Results come back asynchronously via `window._bridgeCb[id]`. The renderer.js is **unmodified** — it still calls `window.api.readNote()`, `window.api.saveDatabase()`, etc., exactly as in the desktop version.

## Option 1 — GitHub Actions (easiest, no local setup)

1. Push this folder to a GitHub repo
2. Go to **Actions** tab → **Build APK** → **Run workflow**
3. Download `NotAI-Android.zip` from the Artifacts section
4. Install the APK on your phone

That's it. No Android Studio, no SDK, no JDK to install locally.

## Option 2 — Android Studio (local build)

1. Install [Android Studio](https://developer.android.com/studio) (includes JDK + SDK)
2. Open Android Studio → **Open** → select this folder
3. Wait for Gradle sync to finish (~2 min first time)
4. Plug in your Android phone with USB debugging on, or start an emulator
5. Click the green **▶ Run** button
   - For APK only: **Build → Build Bundle(s) / APK(s) → Build APK(s)**
   - APK location: `app/build/outputs/apk/debug/app-debug.apk`

## Option 3 — Command line (if you have JDK 17)

```bash
# On Linux/Mac
chmod +x gradlew
./gradlew assembleRelease

# On Windows
gradlew.bat assembleRelease
```

Output: `app/build/outputs/apk/release/app-release-unsigned.apk`

## Install on device

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

Or copy the APK to your phone and open it (enable "Install from unknown sources" in Settings).

## Vault location

Notes are stored in: `Android/data/com.notai.app/files/NotAI/`

Accessible via **Files** app → **Internal Storage** → **Android/data/com.notai.app/files/NotAI/**.

The format is identical to the desktop vault — plain `.md` files, same folder structure, same `.notai/databases/` JSON files. You can sync them with the desktop version via any cloud drive.

## Updating the web frontend

When you update the desktop renderer (fix a bug, add a feature), just copy the updated files to `app/src/main/assets/www/` and rebuild:

```bash
cp -r path/to/notai/src/renderer/. app/src/main/assets/www/
# Make sure api_bridge.js is still present (it's Android-specific, not in the desktop version)
./gradlew assembleRelease
```
