#!/usr/bin/env python3
"""Puts the owner's portrait into «Аврора VPN»'s home-screen icon before the family server signs the app.

The APK carries an empty placeholder picture (res/drawable-nodpi/ic_owner.png, found by its bytes because a release
build renames resource files); it is swapped for the portrait, and the stored entries are aligned the way zipalign
does it (Android 11+ refuses an APK whose resources.arsc is not aligned). The photo itself never enters the public
repository: it lives only on the server.
    owner_icon.py <unsigned.apk> <icon.png> <out.apk>
"""
import hashlib
import struct
import sys
import zipfile

PLACEHOLDER = "541e8dfa2a6a5c6de923d48dcefaf47849f7d96209a5a1d711f43b8897fa1b49"  # sha256 of ic_owner.png


def main(src, icon, out):
    zin = zipfile.ZipFile(src)
    hits = [i.filename for i in zin.infolist() if hashlib.sha256(zin.read(i)).hexdigest() == PLACEHOLDER]
    if len(hits) != 1:
        sys.exit("no icon placeholder in this build")
    new = open(icon, "rb").read()
    if new[:8] != b"\x89PNG\r\n\x1a\n":
        sys.exit("the icon must be a PNG")
    with zipfile.ZipFile(out, "w") as zout:
        for i in zin.infolist():
            zi = zipfile.ZipInfo(i.filename, i.date_time)
            zi.compress_type, zi.external_attr = i.compress_type, i.external_attr
            if i.compress_type == zipfile.ZIP_STORED:
                align = 4096 if i.filename.endswith(".so") else 4
                start = zout.fp.tell() + 30 + len(i.filename.encode()) + 6
                pad = (-start) % align
                zi.extra = struct.pack("<HHH", 0xD935, 2 + pad, align) + b"\0" * pad  # the Android alignment field
            zout.writestr(zi, new if i.filename == hits[0] else zin.read(i))
    print("icon:", hits[0])


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
