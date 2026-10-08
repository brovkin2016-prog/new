#!/usr/bin/env python3
"""Puts one person's connection into «Winger VPN» before the family server signs the app for them: the link goes to
assets/winger-profile.txt, which the app takes as its server on the first start (the person only presses the button).
The entries already in the APK stay byte for byte where they are (so their alignment holds); the new one is appended
compressed, which needs no alignment.
    apk_profile.py <unsigned.apk> <hysteria2:// link> <out.apk>
"""
import re
import shutil
import sys
import zipfile

ASSET = "assets/winger-profile.txt"
LINK = re.compile(r"(?:hysteria2|hy2)://[^\s\"'<>]{8,2000}", re.IGNORECASE)


def main(src, link, out):
    if not LINK.fullmatch(link):
        sys.exit("not a hysteria2:// link")
    with zipfile.ZipFile(src) as z:
        names = z.namelist()
    if ASSET in names:
        sys.exit("this APK already carries a connection")
    if any(n.startswith("META-INF/") and n.endswith((".SF", ".RSA", ".EC", ".DSA")) for n in names):
        sys.exit("the APK must be unsigned (it is signed after this)")
    shutil.copyfile(src, out)
    with zipfile.ZipFile(out, "a") as z:
        zi = zipfile.ZipInfo(ASSET, (2020, 1, 1, 0, 0, 0))
        zi.compress_type, zi.external_attr = zipfile.ZIP_DEFLATED, 0o644 << 16
        z.writestr(zi, link + "\n")
    print("connection:", ASSET)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
