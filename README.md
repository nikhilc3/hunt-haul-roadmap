# Hunt & Haul Roadmap

Interactive product plan for **Hunt & Haul**, an open-world Roblox hunting game:
drive out → hunt → haul back → shred & hatch → upgrade.

- **Overview**: the game loop, plan totals, all 17 areas and the 7-phase build order.
- **Area pages** (sidebar): click any item to open its details in place: what gets built,
  "done when" criteria, what it needs first, what it unlocks, risks and sub-items.
- **Build order**: every item grouped by phase, filterable by status.
- **Search** across titles, summaries and deliverables.
- Every item has a shareable link (`…/#shredder`, `…/#tutorial-steps`).

Areas: World & map, Player base, Player and character, The truck, Weapons and combat,
Animals and bosses, Loot and progression, Tutorial and first session, Retention and live ops,
Social and multiplayer, Monetization, UI and settings, Tech and data, Audio,
Safety and Roblox rules, Marketing and launch, Testing and release.

## How it is built

| Layer | What | Where |
|---|---|---|
| Frontend | Static HTML/CSS/JS, no build step | `index.html`, `assets/` |
| Data ("backend") | The whole plan as one JSON file | `data/plan.json` |
| Validation | Checks ids, statuses, owners, phases, dependencies | `scripts/validate.js` |
| Deploy | GitHub Actions → GitHub Pages on every push to `main` | `.github/workflows/pages.yml` |

GitHub Pages only serves static files, so the plan data is a JSON file in the repo.
Editing the plan = editing `data/plan.json` and pushing. A bad edit fails the
validation job and does not deploy.

## Edit the plan

Each item in `data/plan.json` looks like this:

```json
{
  "id": "shredder",
  "title": "Shredder",
  "summary": "Drop carcasses in, coins come out.",
  "owner": "GPE",
  "priority": "P0",
  "status": "planned",
  "phase": 3,
  "estimate": "3 days",
  "deliverables": ["Shredder model and drop zone"],
  "acceptance": ["Payout matches animal value table"],
  "dependsOn": ["economy"],
  "risks": [],
  "notes": "optional",
  "children": []
}
```

- `status`: `planned` | `in-progress` | `blocked` | `done`
- `priority`: `P0` must have | `P1` should have | `P2` nice to have
- `phase`: 1–7, defined in `meta.phases`
- `owner`: a key from `meta.owners` (PM, ENV, GPE, SYS, UIX, ANI, AUD, MKT, QA)
- `id`: lowercase letters, digits, hyphens; must be unique

Check before pushing:

```bash
node scripts/validate.js
```

## Run locally

The page loads `data/plan.json` with `fetch`, so open it through a local server
(double-clicking `index.html` won't load the data):

```bash
npx serve .
# or
python3 -m http.server 8000
```

## Deploy on GitHub

1. Create a repo and push this folder to `main`.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push. The Actions tab shows *Validate and deploy*; the site URL appears there
   (`https://<user>.github.io/<repo>/`).
