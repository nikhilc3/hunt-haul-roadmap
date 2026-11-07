# Hunt & Haul roadmap: notes for Claude

This repo is the single source of truth for the game. Anyone (or any Claude) building
the game reads `data/plan.json` and the files in `media/`.

## Rules
- Every reference (image, video, clip) lives in the repo under `media/<item-id>/` and is listed in
  `data/media.json`, so it shows on the item and is in its "Download all (.zip)". Never leave a
  reference as only an outside link.
- If one reference covers several items, put a copy (or a cut clip of the relevant moment) under
  each item. The site's Remove button deletes the file, so items must not share one path.
- `name` in media.json is the filename used in zip downloads: no `: \ / * ? " < > |` (Windows).
- `gaps` on an item = what Claude still needs before it can build that item 1:1 (a decision,
  a number, a reference). When something gets answered, write the answer into the item
  (summary/deliverables/notes) and delete that line from `gaps`. If something new is unclear, add a gap.
- Run `node scripts/validate.js` before every push. Pushing to `main` redeploys the site.
