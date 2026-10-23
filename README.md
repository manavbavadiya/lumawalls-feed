# LumaWalls wallpaper feed

The online wallpaper list for the LumaWalls Android app. The app downloads `feed.json` on start and when you tap
Reload, so new wallpapers appear without an app update.

* `feed.json` - every wallpaper: kind, category, title, Pro flag, date added, and for photos and videos the
  Wikimedia Commons file with its **author, licence and source page**.
* `thumbs/`, `vthumbs/`, `covers/` - small preview crops (WebP) of those photos and videos.
* `hits` on each photo/video wallpaper - how often the file was viewed on Wikimedia in the last day / 7 days /
  30 days / 365 days (Wikimedia Analytics mediarequests API), refreshed daily by `.github/workflows/stats.yml`.
  The app's Today's Hit, Weekly Hit, Monthly Hit and Most Viewed sorts use them.

## Licences

All photos and videos come from [Wikimedia Commons](https://commons.wikimedia.org/) and are public domain, CC0,
CC BY, CC BY-SA or Free Art License. Each keeps its own licence; the author, licence and source page of every item
are listed in `feed.json` and shown in the app. The preview crops in this repository are adaptations of those works
and are shared under the same licence as the original. The feed's own metadata is released under CC0.

Photo authors do not endorse this app. To report a problem with an item, open an issue.
