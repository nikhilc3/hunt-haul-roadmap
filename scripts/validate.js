#!/usr/bin/env node
// Validates data/plan.json before deploy. Run: node scripts/validate.js
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "data", "plan.json");
const plan = JSON.parse(fs.readFileSync(file, "utf8"));

const STATUSES = ["planned", "in-progress", "blocked", "done"];
const PRIORITIES = ["P0", "P1", "P2"];
const phaseIds = new Set(plan.meta.phases.map((p) => p.id));
const owners = new Set(Object.keys(plan.meta.owners));

const errors = [];
const ids = new Map();
const deps = [];

function walk(node, trail) {
  const where = [...trail, node.id || "(no id)"].join(" > ");
  for (const key of ["id", "title", "summary", "owner", "priority", "status", "phase"]) {
    if (node[key] === undefined || node[key] === "") errors.push(`${where}: missing "${key}"`);
  }
  if (node.id && !/^[a-z0-9-]+$/.test(node.id)) errors.push(`${where}: id must be lowercase letters, digits and hyphens`);
  if (ids.has(node.id)) errors.push(`${where}: duplicate id (also at ${ids.get(node.id)})`);
  ids.set(node.id, where);
  if (!STATUSES.includes(node.status)) errors.push(`${where}: status "${node.status}" not in ${STATUSES.join(", ")}`);
  if (!PRIORITIES.includes(node.priority)) errors.push(`${where}: priority "${node.priority}" not in ${PRIORITIES.join(", ")}`);
  if (!phaseIds.has(node.phase)) errors.push(`${where}: phase ${node.phase} is not defined in meta.phases`);
  if (!owners.has(node.owner)) errors.push(`${where}: owner "${node.owner}" is not defined in meta.owners`);
  if (node.gaps !== undefined && (!Array.isArray(node.gaps) || node.gaps.some((g) => typeof g !== "string" || !g))) errors.push(`${where}: "gaps" must be a list of non-empty strings`);
  for (const d of node.dependsOn || []) deps.push([where, d]);
  for (const child of node.children || []) walk(child, [...trail, node.id]);
}

walk(plan.root, []);
for (const [where, d] of deps) if (!ids.has(d)) errors.push(`${where}: dependsOn "${d}" does not exist`);

// Media list: every entry must point at a real item and a file that exists in the repo.
const mediaFile = path.join(__dirname, "..", "data", "media.json");
if (fs.existsSync(mediaFile)) {
  const media = JSON.parse(fs.readFileSync(mediaFile, "utf8"));
  for (const [id, list] of Object.entries(media.items || {})) {
    if (!ids.has(id)) console.warn(`warning: media.json has files for "${id}", which is no longer in the plan`);
    for (const m of list) {
      if (!fs.existsSync(path.join(__dirname, "..", m.path))) errors.push(`media.json: ${m.path} is listed but the file is missing`);
    }
  }
}

if (errors.length) {
  console.error(`plan.json has ${errors.length} problem(s):\n- ` + errors.join("\n- "));
  process.exit(1);
}
console.log(`plan.json OK: ${ids.size} items, ${deps.length} dependencies.`);
