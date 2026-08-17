#!/usr/bin/env python3
"""Read (and act on) the focused application's AT-SPI tree, as JSON.

This is the OPPORTUNISTIC half of the desk's perception (docs/agent-desk.md
§3.10). Perception is pixels-primary: the guest agent always ships a
screenshot, and calls this helper on the side. If python3-pyatspi is missing,
the accessibility bus is down, or the focused application exposes nothing, this
prints `null` (or exits non-zero with a reason on stderr) and the agent reports
`a11y: null` while still returning the pixels. Accessibility must never gate
seeing.

It is a subprocess rather than in-process code because the guest agent is the
security-critical surface and is deliberately dependency-free node built-ins
only; pyatspi is a Python/GObject binding with no Node equivalent.

Two modes:

    atspi-dump.py dump [--max-depth N] [--max-nodes M] [--budget-seconds S]
        Print the focused window's tree as one A11yNode JSON object, matching
        @appkit/desk's `A11yNode`:
            { id, role, name, actions, bounds, children }
        `id` is a STRUCTURAL PATH: "0" is the root, "0/3/1" is the second child
        of the fourth child of the root. The path is stable within one dump and
        meaningless outside it — the tree is re-walked from whatever is focused
        now, so always dump immediately before invoking.

    atspi-dump.py invoke --node-id 0/3/1 --action click
        Resolve that path against the focused window and perform the named
        AT-SPI action on it.

Every walk is bounded three ways — depth, node count, and wall-clock budget —
so a pathological or adversarial tree can neither hang the observe() call nor
exhaust the guest's memory. Exceeding a bound TRUNCATES the tree rather than
failing it: a partial tree is more useful than none, and the pixels are
authoritative anyway.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import NoReturn

# Ceilings the caller cannot raise. The host's protocol parser rejects trees
# deeper than 32 or larger than 10000 nodes outright, so staying well inside
# those keeps a big tree from turning into a dropped observation.
HARD_MAX_DEPTH = 24
HARD_MAX_NODES = 5000
HARD_MAX_BUDGET_SECONDS = 10.0

MAX_NAME_CHARS = 512
MAX_ACTIONS = 32


def fail(message: str, code: int = 1) -> NoReturn:
    sys.stderr.write(f"atspi-dump: {message}\n")
    raise SystemExit(code)


def load_pyatspi():
    try:
        import pyatspi  # type: ignore
    except Exception as error:  # ImportError, or a GI typelib failure
        fail(f"pyatspi is unavailable: {error}", 2)
    return pyatspi


def children_of(node):
    """Child accessibles, defensively: a dying application raises mid-walk."""
    try:
        count = node.childCount
    except Exception:
        return []
    result = []
    for index in range(count):
        try:
            child = node.getChildAtIndex(index)
        except Exception:
            child = None
        result.append(child)
    return result


def process_id_of(app):
    """The pid behind an AT-SPI application, when the binding exposes it."""
    for getter in ("get_process_id", "getProcessId"):
        method = getattr(app, getter, None)
        if method is None:
            continue
        try:
            return int(method())
        except Exception:
            continue
    return None


# A window smaller than this in either direction is not something a person is
# looking at. xfwm4, for one, registers a 5x5 off-screen proxy window that
# reports STATE_ACTIVE — picking it would hand back a technically correct and
# completely useless tree.
MIN_WINDOW_PX = 16


def focused_root(pyatspi, wanted_pid=None):
    """The window the screenshot is showing, or None.

    AT-SPI models the desktop as applications, each with window ("frame")
    children. Choosing among them is a ranking, not a lookup: the caller's pid
    (the owner of the X-focused window) dominates when it is known, then
    STATE_ACTIVE, then merely showing. Degenerate windows are excluded outright.
    """
    try:
        desktop = pyatspi.Registry.getDesktop(0)
    except Exception as error:
        fail(f"no accessibility desktop: {error}", 3)

    best = None
    best_score = 0
    for app in children_of(desktop):
        if app is None:
            continue
        app_pid = process_id_of(app)
        for window in children_of(app):
            if window is None:
                continue
            try:
                state = window.getState()
            except Exception:
                continue
            bounds = bounds_of(window, pyatspi)
            if bounds is None:
                continue
            if bounds["width"] < MIN_WINDOW_PX or bounds["height"] < MIN_WINDOW_PX:
                continue
            score = 1
            if wanted_pid and app_pid == wanted_pid:
                score += 100
            if state.contains(pyatspi.STATE_ACTIVE):
                score += 8
            if state.contains(pyatspi.STATE_SHOWING):
                score += 2
            if state.contains(pyatspi.STATE_VISIBLE):
                score += 1
            if score > best_score:
                best, best_score = window, score
    return best


def role_name(node) -> str:
    try:
        name = node.getRoleName()
    except Exception:
        name = ""
    name = (name or "").strip()
    # The host's parser requires a non-empty role string.
    return name if name else "unknown"


def accessible_name(node):
    try:
        name = node.name
    except Exception:
        return None
    if not name:
        return None
    return str(name)[:MAX_NAME_CHARS]


def action_names(node):
    try:
        action = node.queryAction()
    except Exception:
        return []
    names = []
    try:
        count = min(action.nActions, MAX_ACTIONS)
    except Exception:
        return []
    for index in range(count):
        try:
            name = action.getName(index)
        except Exception:
            continue
        if name:
            names.append(str(name)[:64])
    return names


def bounds_of(node, pyatspi):
    try:
        component = node.queryComponent()
        extents = component.getExtents(pyatspi.DESKTOP_COORDS)
    except Exception:
        return None
    try:
        # Widths and heights must be non-negative for the host's parser; an
        # off-screen widget legitimately reports negative x/y, which is fine.
        return {
            "x": int(extents.x),
            "y": int(extents.y),
            "width": max(0, int(extents.width)),
            "height": max(0, int(extents.height)),
        }
    except Exception:
        return None


class Budget:
    def __init__(self, max_nodes: int, deadline: float) -> None:
        self.remaining = max_nodes
        self.deadline = deadline

    def spent(self) -> bool:
        return self.remaining <= 0 or time.monotonic() >= self.deadline


def build(node, path: str, depth: int, max_depth: int, budget: Budget, pyatspi):
    budget.remaining -= 1
    entry = {
        "id": path,
        "role": role_name(node),
        "name": accessible_name(node),
        "actions": action_names(node),
        "bounds": bounds_of(node, pyatspi),
        "children": [],
    }
    if depth >= max_depth or budget.spent():
        # Truncate rather than fail: a bounded tree is still a useful tree.
        return entry
    for index, child in enumerate(children_of(node)):
        if child is None:
            continue
        if budget.spent():
            break
        entry["children"].append(
            build(child, f"{path}/{index}", depth + 1, max_depth, budget, pyatspi)
        )
    return entry


def resolve(root, node_id: str):
    """Walk a structural path ("0/3/1") back down to its accessible."""
    parts = node_id.split("/")
    if not parts or parts[0] != "0":
        fail(f"node id must start at the root ('0'), got {node_id!r}", 4)
    node = root
    for part in parts[1:]:
        if not part.isdigit():
            fail(f"node id segment is not an index: {part!r}", 4)
        index = int(part)
        kids = children_of(node)
        if index >= len(kids) or kids[index] is None:
            fail(f"node {node_id!r} no longer exists; observe again before invoking", 5)
        node = kids[index]
    return node


def cmd_dump(args, pyatspi) -> None:
    root = focused_root(pyatspi, args.pid)
    if root is None:
        # Nothing exposes a tree right now. Not an error — the ordinary case
        # for software with no accessibility support at all.
        sys.stdout.write("null\n")
        return
    max_depth = max(1, min(args.max_depth, HARD_MAX_DEPTH))
    max_nodes = max(1, min(args.max_nodes, HARD_MAX_NODES))
    budget_seconds = max(0.25, min(args.budget_seconds, HARD_MAX_BUDGET_SECONDS))
    budget = Budget(max_nodes, time.monotonic() + budget_seconds)
    tree = build(root, "0", 0, max_depth, budget, pyatspi)
    json.dump(tree, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def cmd_invoke(args, pyatspi) -> None:
    root = focused_root(pyatspi, args.pid)
    if root is None:
        fail("no focused application exposes an accessibility tree", 3)
    node = resolve(root, args.node_id)
    try:
        action = node.queryAction()
    except Exception as error:
        fail(f"node {args.node_id} exposes no actions: {error}", 6)
    wanted = args.action.strip().lower()
    try:
        count = action.nActions
    except Exception as error:
        fail(f"could not read the actions of {args.node_id}: {error}", 6)
    available = []
    for index in range(count):
        try:
            name = action.getName(index) or ""
        except Exception:
            continue
        available.append(name)
        if name.strip().lower() == wanted:
            try:
                action.doAction(index)
            except Exception as error:
                fail(f"action {args.action!r} failed: {error}", 7)
            json.dump({"ok": True, "action": name}, sys.stdout)
            sys.stdout.write("\n")
            return
    fail(
        f"node {args.node_id} has no action {args.action!r} "
        f"(it offers: {', '.join(available) if available else 'none'})",
        6,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Dump or drive the focused AT-SPI tree.")
    sub = parser.add_subparsers(dest="mode", required=True)

    dump = sub.add_parser("dump", help="print the focused window's tree as JSON")
    dump.add_argument("--max-depth", type=int, default=12)
    dump.add_argument("--max-nodes", type=int, default=2000)
    dump.add_argument("--budget-seconds", type=float, default=3.0)
    dump.add_argument("--pid", type=int, default=None, help="pid owning the X-focused window")

    invoke = sub.add_parser("invoke", help="perform an action on one node")
    invoke.add_argument("--node-id", required=True)
    invoke.add_argument("--action", required=True)
    invoke.add_argument("--pid", type=int, default=None, help="pid the node ids were dumped from")

    args = parser.parse_args()
    pyatspi = load_pyatspi()
    if args.mode == "dump":
        cmd_dump(args, pyatspi)
    else:
        cmd_invoke(args, pyatspi)


if __name__ == "__main__":
    main()
