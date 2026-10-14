#!/usr/bin/env python3
"""Checks that an APK's 64-bit native code runs on phones with 16 KB memory pages (Android 15+; a later Android may
refuse code that is not): every loadable segment of every lib/arm64-v8a and lib/x86_64 .so must be aligned to 16 KB or
more. Prints each library with its alignment; exits 1 when one is not.
    elf_16k.py app.apk [more.apk …]
"""
import struct
import sys
import zipfile

PAGE = 16384


def load_align(data):
    """The smallest alignment of the ELF's PT_LOAD segments, or None when it is not a 64-bit little-endian ELF."""
    if data[:4] != b"\x7fELF" or data[4] != 2 or data[5] != 1:
        return None
    phoff, = struct.unpack_from("<Q", data, 0x20)
    phentsize, phnum = struct.unpack_from("<HH", data, 0x36)
    aligns = []
    for i in range(phnum):
        off = phoff + i * phentsize
        p_type, = struct.unpack_from("<I", data, off)
        if p_type == 1:  # PT_LOAD
            aligns.append(struct.unpack_from("<Q", data, off + 0x30)[0])
    return min(aligns) if aligns else None


def main(paths):
    bad = 0
    for path in paths:
        with zipfile.ZipFile(path) as z:
            libs = [n for n in z.namelist() if n.endswith(".so") and n.split("/")[1:2] in (["arm64-v8a"], ["x86_64"])]
            if not libs:
                print(f"{path}: no 64-bit native code")
            for name in sorted(libs):
                a = load_align(z.read(name))
                ok = a is not None and a >= PAGE
                bad += not ok
                print(f"{'ok ' if ok else 'BAD'} {name}: {a if a is None else hex(a)}")
    if bad:
        print(f"{bad} librar{'y' if bad == 1 else 'ies'} not aligned to 16 KB")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
