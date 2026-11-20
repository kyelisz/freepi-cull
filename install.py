#!/usr/bin/env python3
"""install.py — install the pi-tui transcript culling patch for free-pi.

A scroll view lays out its whole transcript child every frame, so a long
session keeps re-building every line it has ever printed even though only the
viewport rows are painted. This patch makes containers skip children that sit
entirely outside the visible window, dropping 60-80% of the per-frame render
cost on long transcripts (see README for numbers).

What it does:
  * writes cull.js next to pi-tui's layout.js/tui.js
  * hooks Container.render / Container.invalidate in tui.js
  * opens the cull window around the scroll layout in layout.js
  * disables culling while alt-screen search is open (tui-alt-screen.js)

Everything is idempotent: backups (*.cull-backup) are taken once, and a second
run reports "already applied" instead of touching anything.

Usage:
  python3 install.py              install (auto-detect bundles, back up first)
  python3 install.py --check      report only, change nothing
  python3 install.py --uninstall  restore stock files, remove cull.js
  python3 install.py --target DIR operate on one pi-tui dist directory
  python3 install.py --dry-run    same as --check

Environment:
  FREEPI_NO_CULL=1                runtime escape hatch, turns the culling off
"""
import argparse
import glob
import hashlib
import os
import shutil
import sys

try:
    HERE = os.path.dirname(os.path.abspath(__file__))
    DEFAULT_PAYLOAD = os.path.join(HERE, "cull.js")
except NameError:  # pragma: no cover
    DEFAULT_PAYLOAD = "cull.js"

# (file, label, old, new) — applied to the pi-tui bundle, backups suffixed .cull-backup
PATCHES = [
    ("tui.js", "import",
     'import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.js";',
     'import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.js";\n'
     '// free-pi tweak: viewport culling for long transcripts\n'
     'import { forgetContainerHeight, renderContainerLines } from "./cull.js";'),
    ("tui.js", "Container.invalidate",
     """    invalidate() {
        for (const child of this.children) {
            child.invalidate?.();
        }
    }""",
     """    invalidate() {
        for (const child of this.children) {
            forgetContainerHeight(child);
            child.invalidate?.();
        }
    }"""),
    ("tui.js", "Container.render",
     """    render(width) {
        const lines = [];
        const mouseChildren = [];
        for (const child of this.children) {
            const childLines = child.render(width);
            mouseChildren.push({ component: child, height: childLines.length });
            for (const line of childLines) {
                lines.push(line);
            }
        }
        this.mouseLayout = { width, children: mouseChildren };
        return lines;
    }""",
     """    render(width) {
        // free-pi tweak: skip children outside the scroll viewport (see cull.js)
        return renderContainerLines(this, width);
    }"""),
    ("layout.js", "import",
     'import { allocateStackSizes, visibleStackEntries } from "./components/stack.js";',
     'import { allocateStackSizes, visibleStackEntries } from "./components/stack.js";\n'
     '// free-pi tweak: viewport culling for long transcripts\n'
     'import { beginCull, cullOverscan, endCull, requestFullRender } from "./cull.js";'),
    ("layout.js", "scroll branch",
     """        const previousScrollTop = node.state.scrollTop;
        const contentWidth = node.state.getContentWidth(safeWidth);
        const childBox = layoutComponent(context, node.component, x, y - previousScrollTop, contentWidth, undefined, clip);
        const contentHeight = childBox.rect.height;
        const viewportHeight = height === undefined ? contentHeight : Math.max(0, Math.floor(height));
        node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
""",
     """        const previousScrollTop = node.state.scrollTop;
        const contentWidth = node.state.getContentWidth(safeWidth);
        // free-pi tweak: cull off-screen transcript children (see cull.js). The window is in
        // scroll-content rows, so a container can skip anything the viewport cannot reach.
        const previousCull = height === undefined
            ? undefined
            : beginCull(previousScrollTop, height, node.state.isFollowingEnd);
        let childBox;
        try {
            childBox = layoutComponent(context, node.component, x, y - previousScrollTop, contentWidth, undefined, clip);
        }
        finally {
            endCull(previousCull);
        }
        const contentHeight = childBox.rect.height;
        const viewportHeight = height === undefined ? contentHeight : Math.max(0, Math.floor(height));
        const scrollTopBeforeUpdate = node.state.scrollTop;
        node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
        // A large upward correction means the drawn rows moved past the live window: repaint fully.
        if (scrollTopBeforeUpdate - node.state.scrollTop > cullOverscan(viewportHeight))
            requestFullRender();
"""),
    ("tui-alt-screen.js", "import",
     'import { Container, CURSOR_MARKER, compositeTuiLine, dispatchMouseEvent, retargetMouseEvent, TuiBase, VIEWPORT_TUI, } from "./tui.js";',
     'import { setCullEnabled } from "./cull.js";\n'
     'import { Container, CURSOR_MARKER, compositeTuiLine, dispatchMouseEvent, retargetMouseEvent, TuiBase, VIEWPORT_TUI, } from "./tui.js";'),
    ("tui-alt-screen.js", "search opens",
     """    toggleSearch() {
        if (this.activeSearch) {
            this.closeSearch();
            return;
        }""",
     """    toggleSearch() {
        if (this.activeSearch) {
            this.closeSearch();
            return;
        }
        // free-pi tweak: the search index needs every line, so stop culling while it is open
        setCullEnabled(false);"""),
    ("tui-alt-screen.js", "search closes",
     """    closeSearch() {
        const search = this.activeSearch;
        if (!search)
            return;""",
     """    closeSearch() {
        // free-pi tweak: restore transcript culling once search is closed
        setCullEnabled(true);
        const search = this.activeSearch;
        if (!search)
            return;"""),
]


def candidate_dirs():
    """Well-known places a pi-tui bundle can live, in order."""
    dirs = []
    npx = os.path.expanduser("~/.npm/_npx")
    if os.path.isdir(npx):
        for entry in sorted(glob.glob(os.path.join(npx, "*"))):
            d = os.path.join(entry, "node_modules/free-pi-cli",
                             "node_modules/@earendil-works/pi-tui/dist")
            if os.path.isfile(os.path.join(d, "tui.js")):
                dirs.append(d)
    for base in ("/usr/local/lib/node_modules", "/usr/lib/node_modules",
                 os.path.expanduser("~/.local/lib/node_modules"),
                 os.path.expanduser("~/.volta/tools/image"),
                 os.path.expanduser("~/.volta/tools/user")):
        d = os.path.join(base, "free-pi-cli", "node_modules",
                         "@earendil-works/pi-tui/dist")
        if os.path.isfile(os.path.join(d, "tui.js")):
            dirs.append(d)
    return dirs


def patch_one(tui, payload, action, out):
    out.write("\n" + tui + "\n")
    target = os.path.join(tui, "cull.js")
    ok, changed = True, False

    if action == "uninstall":
        for name, _label, _old, _new in PATCHES:
            path = os.path.join(tui, name)
            bak = path + ".cull-backup"
            if os.path.exists(bak):
                shutil.copy2(bak, path)
        if os.path.exists(target):
            os.remove(target)
        out.write("  cull uninstalled (restored stock files)\n")
        return True

    if os.path.exists(target) and open(target, encoding="utf8").read() == payload:
        if not action == "check":
            out.write("  cull.js          already applied\n")
    else:
        if action != "check":
            open(target, "w", encoding="utf8").write(payload)
            out.write("  cull.js          written\n")
        else:
            out.write("  cull.js          to apply\n")

    for name, label, old, new in PATCHES:
        path = os.path.join(tui, name)
        s = open(path, encoding="utf8").read()
        if new in s:
            if action != "check" or label == "import":
                out.write(f"  {label:16} already applied\n")
            continue
        if s.count(old) != 1:
            out.write(f"  {label:16} SKIP - unexpected counts old={s.count(old)}\n")
            ok = False
            continue
        if action == "check":
            out.write(f"  {label:16} to apply\n")
            changed = True
            continue
        bak = path + ".cull-backup"
        if not os.path.exists(bak):
            shutil.copy2(path, bak)
        open(path, "w", encoding="utf8").write(s.replace(old, new))
        out.write(f"  {label:16} applied\n")
        changed = True
    return ok


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report only, change nothing")
    ap.add_argument("--uninstall", action="store_true", help="restore stock files")
    ap.add_argument("--target", metavar="DIR", help="pi-tui dist dir (default: auto-detect)")
    ap.add_argument("--payload", default=DEFAULT_PAYLOAD, help="path to cull.js (default: next to install.py)")
    args = ap.parse_args(argv)

    if not os.path.isfile(args.payload):
        print("no payload at " + args.payload)
        return 2

    dirs = [args.target] if args.target else candidate_dirs()
    if not dirs:
        print("no pi-tui bundle found - pass --target <dist dir>")
        return 1

    payload = open(args.payload, encoding="utf8").read()
    action = "uninstall" if args.uninstall else "check" if args.check else "install"
    all_ok = True
    for d in dirs:
        all_ok &= patch_one(d, payload, action, sys.stdout)
    print("\nrestart free-pi for changes to show" if action == "install" else "")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))