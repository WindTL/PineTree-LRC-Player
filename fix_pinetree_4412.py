#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Safe patch for PineTree 4.4.12: chapter clicks and quick resume should
play a locally available MP3 even when the desktop chapter index marks it stale.

Usage: py fix_pinetree_4412.py [path_to_repo]
Creates a complete deployable ZIP next to the repo, not inside it.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path

BASE_VERSION = "4412"
NEW_VERSION = "4413"
NEW_DISPLAY = "4.4.13"

OLD_CLICK = """    btn.addEventListener('click',()=>{
      if(state.episodeSelectionMode)toggleEpisodeSelection(t.id);
      else if(waiting)openChapterSync(t.book);
      else loadTrack(t,{autoplay:true});
    });fragment.append(btn);"""

NEW_CLICK = """    btn.addEventListener('click',()=>{
      if(state.episodeSelectionMode){
        toggleEpisodeSelection(t.id);
        return;
      }
      // A desktop update does not invalidate an already imported local MP3.
      // In particular, do not turn a normal chapter tap into a sync dialog.
      const localTrack=state.tracks.find(item=>item.id===t.id);
      if(localTrack&&localTrack.audioPresent!==false){
        loadTrack(localTrack,{autoplay:true});
        return;
      }
      // A chapter known only from the JSON index, or one with no local MP3,
      // genuinely requires an import. Keep the existing sync workflow here.
      if(waiting){
        openChapterSync(t.book);
        return;
      }
      loadTrack(localTrack||t,{autoplay:true});
    });fragment.append(btn);"""


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace_once(text: str, old: str, new: str, file: str) -> str:
    occurrences = text.count(old)
    if occurrences != 1:
        raise RuntimeError(f"{file}: expected one match, found {occurrences}; no files changed.")
    return text.replace(old, new, 1)


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv)>1 else Path.cwd()).expanduser().resolve()
    manifest_path = root / "version.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"Cannot find version.json at {root}. Run from the PineTree repository folder.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("version") != BASE_VERSION:
        raise RuntimeError(f"This patch requires v4.4.12 (4412); found {manifest.get('version')!r}. No files changed.")
    if manifest.get("format") != "pinetree-shell-v1" or not isinstance(manifest.get("files"), dict):
        raise RuntimeError("Unknown PineTree release format. No files changed.")
    for key in ("app.js", "index.html", "styles.css", "sw.js", "repair.html", "manifest.webmanifest", "themes/forest-reading/theme.css"):
        if key not in manifest["files"] or not (root/key).is_file():
            raise RuntimeError(f"Missing required file: {key}. No files changed.")

    # Verify the content can be patched BEFORE touching any files.
    app = (root/"app.js").read_text(encoding="utf-8")
    app = replace_once(app, OLD_CLICK, NEW_CLICK, "app.js chapter click handler")
    app = replace_once(app, "if(waiting||!hasAudio){", "if(!hasAudio){", "app.js synced resume")
    if 'const SYNC_JSON_NAME=\'~AudioBook_PineTree_Sync.json\'' not in app:
        raise RuntimeError("Expected iCloud JSON sync name not found; not patching this variant.")

    changes = {"app.js": app.replace(BASE_VERSION, NEW_VERSION)}
    for path in ("index.html", "styles.css", "sw.js", "repair.html", "manifest.webmanifest", "themes/forest-reading/theme.css"):
        orig = (root/path).read_text(encoding="utf-8")
        if BASE_VERSION not in orig:
            raise RuntimeError(f"Expected {BASE_VERSION} in {path}; no files changed.")
        updated = orig.replace(BASE_VERSION, NEW_VERSION)
        if path == "index.html":
            updated = updated.replace("4.4.12", NEW_DISPLAY)
        elif path == "sw.js":
            updated = updated.replace("PineTree 4.4.12", f"PineTree {NEW_DISPLAY}")
        changes[path] = updated

    # Validate entire deployment tree exists, including theme artwork and icons.
    for rel in manifest["files"]:
        p = root / rel
        if not p.is_file() or p.resolve().is_relative_to(root) is False:
            raise RuntimeError(f"Missing or unsafe release resource: {rel}; no files changed.")

    modified_before = [rel for rel, expected in manifest["files"].items() if sha(root/rel) != expected]
    if modified_before:
        print("Warning: these local files already differ from v4.4.12 manifest; your local versions will be preserved:")
        for rel in modified_before[:20]: print("  ", rel)
        if len(modified_before) > 20: print("  ... and", len(modified_before)-20, "more")

    # Save the originals outside the repository (never in website ZIP).
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = root.parent / f"PineTree_v4.4.12_backup_{stamp}"
    backup.mkdir(parents=True,exist_ok=False)
    for rel in [*changes, "version.json"]:
        target = backup/rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root/rel, target)

    try:
        for rel, text in changes.items():
            (root/rel).write_text(text, encoding="utf-8", newline="")
        manifest["version"] = NEW_VERSION
        manifest["displayVersion"] = NEW_DISPLAY
        # All bytes must match, or PineTree's strict offline-shell installer refuses the update.
        for rel in manifest["files"]:
            manifest["files"][rel] = sha(root/rel)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n", encoding="utf-8", newline="")
        assert "else if(waiting)openChapterSync(t.book);" not in (root/"app.js").read_text(encoding="utf-8")
        assert "if(waiting||!hasAudio){" not in (root/"app.js").read_text(encoding="utf-8")
        assert all(sha(root/p) == h for p,h in manifest["files"].items())
        assert "--pt-base-release:4413" in (root/"styles.css").read_text(encoding="utf-8")
        assert "--pt-theme-release:4413" in (root/"themes/forest-reading/theme.css").read_text(encoding="utf-8")
        assert "--pt-flagship-release:4413" in (root/"index.html").read_text(encoding="utf-8")
    except Exception:
        for rel in [*changes, "version.json"]:
            shutil.copy2(backup/rel, root/rel)
        raise

    out = root.parent / f"PineTree_v{NEW_DISPLAY}_ChapterPlaybackFix.zip"
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel in ["version.json", *manifest["files"].keys()]:
            z.write(root/rel, rel)
    with zipfile.ZipFile(out, "r") as z:
        corrupt = z.testzip()
        if corrupt: raise RuntimeError(f"ZIP corruption: {corrupt}")
        included = set(z.namelist())
        if included != {"version.json", *manifest["files"].keys()}:
            raise RuntimeError("ZIP resource list mismatch")

    print(f"SUCCESS: {out}")
    print(f"Backup: {backup}")
    print(f"Modified: {len(changes)} files + version.json; deployed resources: {len(manifest['files'])}")
    print("Your IndexedDB, imported MP3/LRC, reading progress and iCloud JSON were not touched.")
    print("To publish your current checkout: git add . ; git commit -m 'Fix playback of pending-sync chapters' ; git push origin main")
    return 0

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as e:
        print("PATCH FAILED:", e, file=sys.stderr)
        raise SystemExit(1)
