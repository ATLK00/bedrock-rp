#!/usr/bin/env python3
"""In-place patcher for a Bedrock BDS `level.dat` so a player-created world works on a local server.

Background (see README "Getting the Beta APIs experimental toggle onto a BDS world"):
a world created in the Minecraft client with the "Beta APIs" experiment enabled
carries the experiment flag in `level.dat`, but a client-created world defaults to
MultiplayerGame=0, XBLBroadcastIntent=2, PlatformBroadcastIntent=2. Those force the
client to attempt Xbox Live / NetherNet signalling that a locally-run BDS instance
cannot satisfy, so every join fails before reaching the server. BDS-native worlds use
1, 0, 0 instead. This tool patches those three values in place.

`level.dat` is binary NBT (Bedrock: little-endian, 8-byte header before the payload,
2-byte footer). Only the value bytes of the three known fields are rewritten, so the
rest of the file (including any custom world data) is preserved byte-for-byte.

Usage:
    python leveldat_patch.py path/to/level.dat [--check] [--dry-run] [--force] [--endian little|big]

Exit codes: 0 = patched or already correct; 2 = NBT could not be parsed;
3 = required fields missing; 4 = usage error.

`--check` only prints current values and exits. `--dry-run` prints what would change
without touching the file. By default a `<file>.bak` copy is written before patching
(disable with `--force`).
"""

import argparse
import struct
import sys
import tempfile
from pathlib import Path

TAG_END = 0
TAG_BYTE = 1
TAG_SHORT = 2
TAG_INT = 3
TAG_LONG = 4
TAG_FLOAT = 5
TAG_DOUBLE = 6
TAG_BYTE_ARRAY = 7
TAG_STRING = 8
TAG_LIST = 9
TAG_COMPOUND = 10
TAG_INT_ARRAY = 11
TAG_LONG_ARRAY = 12

# (field name, expected tag id, target value, allow any-other-value)
FIELDS = [
    ("MultiplayerGame", TAG_BYTE, 1),
    ("XBLBroadcastIntent", TAG_INT, 0),
    ("PlatformBroadcastIntent", TAG_INT, 0),
]

TYPE_NAMES = {TAG_BYTE: "byte", TAG_INT: "int", TAG_SHORT: "short", TAG_LONG: "long"}
SCALAR_FMT = {
    TAG_BYTE: ("b", 1),
    TAG_SHORT: ("h", 2),
    TAG_INT: ("i", 4),
    TAG_LONG: ("q", 8),
    TAG_FLOAT: ("f", 4),
    TAG_DOUBLE: ("d", 8),
}


class NbtError(ValueError):
    pass


def _u16(buf, off, le):
    return struct.unpack("<H" if le else ">H", buf[off : off + 2])[0]


def _s32(buf, off, le):
    return struct.unpack("<i" if le else ">i", buf[off : off + 4])[0]


def read_string(buf, off, le):
    ln = _u16(buf, off, le)
    raw = buf[off + 2 : off + 2 + 2 * ln]
    if len(raw) < 2 * ln:
        raise NbtError("truncated string payload")
    return raw.decode("utf-16-be"), off + 2 + 2 * ln


def skip_value(buf, off, tag_id, le):
    """Advance past a tag value, recursively for compounds/lists. Returns new offset."""
    if tag_id in SCALAR_FMT:
        width = SCALAR_FMT[tag_id][1]
        if off + width > len(buf):
            raise NbtError("truncated scalar")
        return off + width
    if tag_id == TAG_BYTE_ARRAY:
        n = _s32(buf, off, le)
        return off + 4 + n
    if tag_id == TAG_INT_ARRAY:
        n = _s32(buf, off, le)
        return off + 4 + 4 * n
    if tag_id == TAG_LONG_ARRAY:
        n = _s32(buf, off, le)
        return off + 4 + 8 * n
    if tag_id == TAG_STRING:
        _, off = read_string(buf, off, le)
        return off
    if tag_id == TAG_LIST:
        elem_type = buf[off]
        n = _s32(buf, off + 1, le)
        off += 5
        for _ in range(n):
            off = skip_value(buf, off, elem_type, le)
        return off
    if tag_id == TAG_COMPOUND:
        while True:
            if off >= len(buf):
                raise NbtError("unexpected end of NBT inside compound")
            inner = buf[off]
            if inner == TAG_END:
                return off + 1
            _, off = read_string(buf, off + 1, le)
            off = skip_value(buf, off, inner, le)
    raise NbtError(f"cannot skip tag id {tag_id}")


def patch_by_value(buf, patch_off, tag_id, new_value, le):
    if tag_id in SCALAR_FMT and tag_id in (TAG_BYTE, TAG_SHORT, TAG_INT, TAG_LONG):
        struct.pack_into(SCALAR_FMT[tag_id][0], buf, patch_off, new_value)
        return
    raise NbtError(f"field tag id {tag_id} is not a fixed-size numeric type")


def parse_top_level(buf, start, end, le):
    """Return dict: field name -> (tag_id, current_value, value_offset, read_ok)."""
    if end > len(buf) or start + 1 > end:
        raise NbtError("bad NBT span")
    if buf[start] != TAG_COMPOUND:
        raise NbtError(f"root tag is 0x{buf[start]:02x}, expected Compound (0x0a)")
    off = start + 1
    _, off = read_string(buf, off, le)
    found = {}
    while True:
        if off >= end:
            raise NbtError("unexpected end of NBT before TAG_End")
        tag_id = buf[off]
        if tag_id == TAG_END:
            break
        name, off = read_string(buf, off + 1, le)
        if name in (f[0] for f in FIELDS):
            value_offset = off
            try:
                if tag_id in (TAG_BYTE, TAG_SHORT, TAG_INT, TAG_LONG):
                    value = struct.unpack_from(SCALAR_FMT[tag_id][0], buf, off)[0]
                else:
                    value = None
            except struct.error:
                raise NbtError(f"truncated value for '{name}'")
            found[name] = (tag_id, value, value_offset)
        off = skip_value(buf, off, tag_id, le)
    return found


def nbt_window(buf, big=False):
    """Locate the NBT payload inside a Bedrock level.dat (8-byte header, trailing
    footer). The header's first int is the byte-length of the trailing footer."""
    if len(buf) < 10:
        raise NbtError("file too short to be a level.dat")
    footer_offset = struct.unpack_from(">i" if big else "<i", buf, 0)[0]
    nbt_start = 8
    nbt_end = len(buf) - footer_offset
    if not (8 <= nbt_end <= len(buf)):
        raise NbtError(f"implausible footer offset {footer_offset}")
    return nbt_start, nbt_end


def choose_endian(buf, preferred):
    """Try parsing the top-level compound in both byte orders; return True for
    big-endian. Bedrock level.dat is normally little-endian, so little is tried
    first and big only if the little parse fails."""
    if preferred:
        return preferred == "big"
    for big in (False, True):
        try:
            start, end = nbt_window(buf, big)
            parse_top_level(buf, start, end, not big)
            return big
        except (NbtError, struct.error):
            continue
    return False


def run(path, check=False, dry_run=False, force=False, endian=None):
    data = bytearray(path.read_bytes())
    le = not choose_endian(data, endian)
    start, end = nbt_window(data, big=not le)
    found = parse_top_level(data, start, end, le)

    reports = []
    changed = 0
    ok = 0
    for name, want_id, want_value in FIELDS:
        if name not in found:
            reports.append(f"  {name}: MISSING (tag not found at top level)")
            continue
        tag_id, value, voff = found[name]
        if tag_id != want_id:
            reports.append(f"  {name}: tag type {TYPE_NAMES.get(tag_id, tag_id)} (expected {TYPE_NAMES[want_id]}); NOT patched")
            continue
        if value == want_value:
            reports.append(f"  {name}: already {value} (ok)")
            ok += 1
            continue
        reports.append(f"  {name}: {value} -> {want_value}")
        if not check and not dry_run:
            patch_by_value(data, voff, tag_id, want_value, le)
        changed += 1

    print(f"file: {path}  endian: {'little' if le else 'big'}  nbt: {start}..{end}")
    print(f"fields (top level):")
    for line in reports:
        print(line)

    missing = [f[0] for f in FIELDS if f[0] not in found]
    wrong_type = [
        f[0]
        for f in FIELDS
        if f[0] in found and found[f[0]][0] != f[1]
    ]
    if check or dry_run:
        if missing or wrong_type:
            return 3
        return 0 if ok + changed == len(FIELDS) else 3
    if missing or wrong_type:
        return 3
    if not force:
        backup = path.with_suffix(path.suffix + ".bak")
        if not backup.exists():
            backup.write_bytes(data)
            print(f"backup: {backup}")
    path.write_bytes(bytes(data))
    print(f"patched: {changed} field(s), already-ok: {ok}, written: {path}")
    return 0


def self_test():
    """Build a synthetic little-endian level.dat with the 3 fields, a nested
    compound that reuses a field name (must stay untouched), and a list; then
    patch and assert each invariant. Returns 0 on success, 1 on failure."""
    path = Path(tempfile.gettempdir()) / "leveldat_patch_selftest.dat"
    children = b""
    # bottom-level fields we patch
    children += bytes([TAG_BYTE]) + st16("MultiplayerGame", False) + bytes([0])
    children += bytes([TAG_INT]) + st16("XBLBroadcastIntent", False) + struct.pack("<i", 2)
    children += bytes([TAG_INT]) + st16("PlatformBroadcastIntent", False) + struct.pack("<i", 2)
    # a nested compound containing a same-named byte that must NOT be patched
    inner = bytes([TAG_BYTE]) + st16("MultiplayerGame", False) + bytes([7]) + bytes([TAG_END])
    children += bytes([TAG_COMPOUND]) + st16("nestedX", False) + inner
    # a list of one int (must be skipped cleanly)
    lst = bytes([TAG_INT]) + struct.pack("<i", 1) + struct.pack("<i", 42)
    children += bytes([TAG_LIST]) + st16("lst", False) + lst
    children += bytes([TAG_END])
    root = bytes([TAG_COMPOUND]) + b"\x00\x00" + children
    data = struct.pack("<ii", 2, 1) + root + b"\x00\x00"
    path.write_bytes(data)

    try:
        out = run(path, force=True)
        if out != 0:
            print("self-test FAILED: patch returned", out)
            return 1

        raw = path.read_bytes()
        le = not choose_endian(raw, None)
        start, end = nbt_window(raw, big=not le)

        # 1) all three fields now correct at top level
        found = parse_top_level(raw, start, end, le)
        if not all(found[f][1] == v for f, _, v in FIELDS):
            print("self-test FAILED: fields not patched correctly", found)
            return 1

        # 2) nested compound's same-named byte is still 7 (untouched)
        off = start + 1
        _, off = read_string(raw, off, le)
        nested_ok = False
        while True:
            t = raw[off]
            if t == TAG_END:
                break
            name, off = read_string(raw, off + 1, le)
            if name == "nestedX":
                it = raw[off]
                iname, ivo = read_string(raw, off + 1, le)
                if iname == "MultiplayerGame" and raw[ivo] == 7:
                    nested_ok = True
                break
            off = skip_value(raw, off, t, le)
        if not nested_ok:
            print("self-test FAILED: nested same-named byte was touched or misread")
            return 1

        # 3) idempotent: re-check shows everything already-ok
        if run(path, check=True, force=True) != 0:
            print("self-test FAILED: re-check not idempotent")
            return 1

        print("self-test: OK (patched 3 fields, idempotent, nested untouched)")
        return 0
    finally:
        if path.exists():
            path.unlink()
            bak = path.with_suffix(".dat.bak")
            if bak.exists():
                bak.unlink()


def st16(s, big):
    return struct.pack(">H" if big else "<H", len(s)) + s.encode("utf-16-be")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Patch Beta-APIs world level.dat for BDS (see README).")
    ap.add_argument("leveldat", nargs="?", help="path to the world's level.dat")
    ap.add_argument("--check", action="store_true", help="only report current values, change nothing")
    ap.add_argument("--dry-run", action="store_true", help="report what would change, change nothing")
    ap.add_argument("--force", action="store_true", help="skip creating a .bak backup")
    ap.add_argument("--endian", choices=["little", "big"], help="override NBT endianness (default: auto-detect)")
    ap.add_argument("--self-test", action="store_true", help="run a self-contained round-trip check and exit")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()

    path = Path(args.leveldat) if args.leveldat else None
    if path is None or not path.is_file():
        print("error: a level.dat path is required (or use --self-test)", file=sys.stderr)
        return 4
    try:
        return run(path, check=args.check, dry_run=args.dry_run, force=args.force, endian=args.endian)
    except (NbtError, struct.error, ValueError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())