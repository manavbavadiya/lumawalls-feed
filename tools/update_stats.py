#!/usr/bin/env python3
"""Add real popularity numbers to feed.json for the app's Today's / Weekly / Monthly Hit and Most Viewed sorts.

  python3 tools/update_stats.py [--missing-only]

For every photo and video in feed.json it asks the Wikimedia Analytics REST API (mediarequests, per file, daily)
how often that file was requested on Wikimedia sites, and stores on each wallpaper
  "hits": [last day, last 7 days, last 30 days, last 365 days]
plus "statsDay" (the last day counted, YYYYMMDD). Drawn wallpapers have no file and get no "hits".
Standard library only; one request at a time (Wikimedia rate limits), so a full run takes ~10-15 minutes.
Runs daily from .github/workflows/stats.yml; --missing-only fills only wallpapers without numbers (publishing).
"""
import datetime
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FEED = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "feed.json")
UA = {"User-Agent": "LumaWallsFeedStats/0.1 (https://github.com/manavbavadiya/lumawalls-feed)"}
API = "https://wikimedia.org/api/rest_v1/metrics/mediarequests/per-file/all-referers/all-agents/{path}/daily/{start}/{end}"


def file_path(name):
    n = name.replace(" ", "_")
    h = hashlib.md5(n.encode("utf-8")).hexdigest()
    return f"/wikipedia/commons/{h[0]}/{h[:2]}/{n}"


def series(name, start, end):
    url = API.format(path=urllib.parse.quote(file_path(name), safe=""), start=start, end=end)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return {i["timestamp"][:8]: i["requests"] for i in json.load(r).get("items", [])}
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {}  # no requests recorded in the window
            if e.code == 429:
                time.sleep(min(60, int(e.headers.get("Retry-After", "10"))))
                continue
            time.sleep(2 ** attempt)
        except (OSError, ValueError):  # URLError, socket timeouts, broken JSON
            time.sleep(2 ** attempt)
    return None


def main():
    missing_only = "--missing-only" in sys.argv
    feed = json.load(open(FEED))
    files = {p["id"]: p["file"] for p in feed.get("photos", [])}
    files.update({v["id"]: v["file"] for v in feed.get("videos", [])})
    last = datetime.date.today() - datetime.timedelta(days=1)  # last complete day
    start = last - datetime.timedelta(days=364)
    s, e = start.strftime("%Y%m%d"), last.strftime("%Y%m%d")
    cache, done = {}, 0
    for w in feed["walls"]:
        f = files.get(w.get("video") or w.get("photo") or "")
        if not f or (missing_only and "hits" in w):
            continue
        if f not in cache:
            cache[f] = series(f, s, e)
            time.sleep(1.0)
        days = cache[f]
        if days is None:
            continue  # network trouble: keep the previous numbers
        def window(n):
            first = (last - datetime.timedelta(days=n - 1)).strftime("%Y%m%d")
            return sum(v for d, v in days.items() if d >= first)
        w["hits"] = [window(1), window(7), window(30), window(365)]
        w["statsDay"] = e
        done += 1
    feed["statsDay"] = e
    json.dump(feed, open(FEED, "w"), separators=(",", ":"))
    print(f"stats for {done} wallpapers ({len(cache)} files), last day {e}")


if __name__ == "__main__":
    main()
