#!/usr/bin/env python3
"""Writes version.json into a folder of the app's screens: the list of files and one hash of all of them.
The app compares it with its own copy and downloads newer screens. Usage: version.py <www dir>"""
import hashlib, json, os, sys

root = sys.argv[1]
files = sorted(f for f in os.listdir(root) if os.path.isfile(os.path.join(root, f)) and f != "version.json")
h = hashlib.sha256()
for f in files:
    h.update(f.encode() + b"\0" + open(os.path.join(root, f), "rb").read())
json.dump({"v": h.hexdigest()[:16], "files": files}, open(os.path.join(root, "version.json"), "w"))
print("version", h.hexdigest()[:16], len(files), "files")
