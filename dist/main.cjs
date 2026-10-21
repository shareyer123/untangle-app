"use strict";

// src/main/index.ts
var import_electron = require("electron");
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");

// src/core/db.ts
function tx(db2, fn) {
  db2.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db2.exec("COMMIT");
    return r;
  } catch (e) {
    try {
      db2.exec("ROLLBACK");
    } catch {
    }
    throw e;
  }
}
function listTables(db2) {
  return db2.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
}
function tableColumns(db2, table) {
  return db2.all(`SELECT name FROM pragma_table_info(?)`, table).map((r) => r.name);
}
function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

// src/core/schema.ts
var SCHEMA_VERSION = 1;
var OUR_TABLES = ["facilities", "projects", "schedule_items", "change_log", "views", "meta"];
var SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS facilities (
  code   TEXT PRIMARY KEY,
  name   TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  bucket         TEXT CHECK (bucket IN ('CDM','FDR','OBS')),
  baseline       TEXT,
  technical_lead TEXT,
  sort_order     INTEGER,
  active         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS schedule_items (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  item_type   TEXT NOT NULL CHECK (item_type IN
                ('system_dev','system_dry','system_score',
                 'sw_dev','sw_dry','sw_fqt','trr','other')),
  label       TEXT,
  facility    TEXT REFERENCES facilities(code),
  start_date  TEXT,
  end_date    TEXT,
  confidence  TEXT NOT NULL DEFAULT 'notional'
                CHECK (confidence IN ('firm','estimated','notional')),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT 'luna' CHECK (updated_by IN ('luna','app')),
  CHECK (item_type = 'trr' OR end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS change_log (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL,
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS views (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  definition TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_project  ON schedule_items (project_id);
CREATE INDEX IF NOT EXISTS idx_items_facility ON schedule_items (facility, start_date, end_date);
`;
var SCHEMA_FILE = `-- Untangle schema v1 (SPEC \xA74.2). Generated from src/core/schema.ts \u2014 do not edit by hand.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = ${SCHEMA_VERSION};

${SCHEMA_SQL}`;
var STARTER_VIEWS = [
  { name: "Near term", definition: { range: { kind: "relative", monthsBefore: 0, monthsAfter: 18 }, lanes: "facility", filters: {} } },
  { name: "Long term", definition: { range: { kind: "fixed", start: "2026-01-01", end: "2035-12-31" }, lanes: "bucket", filters: {} } },
  { name: "By facility", definition: { range: { kind: "fit" }, lanes: "facility", filters: {} } },
  { name: "By baseline", definition: { range: { kind: "fit" }, lanes: "baseline", filters: {} } }
];
var WRITER_NOTES = `How to write to this database (for Luna):
- Write to schedule_items / projects only. Do not write to any imported source table.
- One row per bar or milestone. Dates are 'YYYY-MM-DD'. Unknown = NULL (never 'TBD').
- trr is a single date: set start_date, leave end_date NULL. Every other type is a range, end inclusive.
- On every change set updated_at to the current ISO timestamp and updated_by = 'luna'.
- Append one change_log row per changed field (changed_by = 'luna').
- facility must be a code in facilities (add the code there first). bucket is CDM, FDR, OBS or NULL.
- confidence is firm, estimated or notional.`;

// src/core/types.ts
var ITEM_TYPES = [
  "system_dev",
  "system_dry",
  "system_score",
  "sw_dev",
  "sw_dry",
  "sw_fqt",
  "trr",
  "other"
];
var BUCKETS = ["CDM", "FDR", "OBS"];
var CONFIDENCES = ["firm", "estimated", "notional"];
var DEFAULT_FACILITIES = ["STF", "AIA", "ITF", "CCF"];

// src/core/import/columns.ts
var tokensOf = (name) => name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").split("_").filter(Boolean);
var START = /* @__PURE__ */ new Set(["start", "begin", "from", "starts", "begins"]);
var END = /* @__PURE__ */ new Set(["end", "finish", "to", "stop", "ends", "complete", "completion"]);
var SYSTEM = /* @__PURE__ */ new Set(["system", "sys", "hw", "hardware"]);
var SW = /* @__PURE__ */ new Set(["sw", "software", "swr"]);
var DEV = /* @__PURE__ */ new Set(["dev", "development", "develop", "devel"]);
var DRY = /* @__PURE__ */ new Set(["dry", "dryrun"]);
var FACILITY = /* @__PURE__ */ new Set(["facility", "lab", "location", "site", "facilities"]);
function itemTypeOf(tokens) {
  const has = (set) => tokens.some((t) => set.has(t));
  if (tokens.includes("trr")) return "trr";
  if (tokens.includes("fqt")) return "sw_fqt";
  if (tokens.includes("score")) return "system_score";
  const side = has(SYSTEM) ? "system" : has(SW) ? "sw" : null;
  const phase = has(DEV) ? "dev" : has(DRY) ? "dry" : null;
  if (side && phase) return `${side}_${phase}`;
  return null;
}
function guessColumn(name) {
  const t = tokensOf(name);
  const joined = t.join("_");
  if (["id", "rowid", "row_id", "pk"].includes(joined) || t.length > 1 && t[t.length - 1] === "id") return { role: "id" };
  if (["project", "project_name", "projects", "name", "program", "program_name", "proj"].includes(joined)) return { role: "project" };
  if (t.includes("lead") || t.includes("owner") || joined === "tl" || t.includes("poc")) return { role: "lead" };
  if (t.includes("bucket") || joined === "category") return { role: "bucket" };
  if (t.includes("baseline") || joined === "config" || joined === "configuration") return { role: "baseline" };
  const itemType = itemTypeOf(t);
  if (t.some((x) => FACILITY.has(x))) return itemType ? { role: "facility", itemType } : { role: "facility" };
  if (!itemType) return { role: "ignore" };
  if (itemType === "trr") return { role: "single", itemType };
  if (t.some((x) => START.has(x))) return { role: "start", itemType };
  if (t.some((x) => END.has(x))) return { role: "end", itemType };
  return { role: "single", itemType };
}
function guessColumnMap(columns) {
  const map = {};
  for (const c of columns) map[c] = guessColumn(c);
  for (const c of columns) {
    const r = map[c];
    if (r.role === "start" && !columns.some((o) => {
      const x = map[o];
      return x.role === "end" && x.itemType === r.itemType;
    })) {
      map[c] = { role: "single", itemType: r.itemType };
    }
  }
  return map;
}
function describeRole(r) {
  switch (r.role) {
    case "start":
      return `${r.itemType} start`;
    case "end":
      return `${r.itemType} end`;
    case "single":
      return r.itemType === "trr" ? "TRR milestone" : `${r.itemType} (single date)`;
    case "facility":
      return r.itemType ? `${r.itemType} facility` : "facility";
    case "lead":
      return "technical lead";
    default:
      return r.role;
  }
}
function dateColumnCount(map) {
  const roles = Object.values(map);
  const starts = roles.filter((r) => r.role === "start").length;
  const dates = roles.filter((r) => r.role === "start" || r.role === "end" || r.role === "single").length;
  return { pairs: starts, dates };
}

// src/core/dates.ts
var TBD_VALUES = /* @__PURE__ */ new Set(["", "tbd", "n/a", "na", "?", "null", "none", "-", "tba"]);
function isTbd(v) {
  if (v === null || v === void 0) return true;
  return TBD_VALUES.has(String(v).trim().toLowerCase());
}
function valid(y, m, d) {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
var MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12
};
function parseLooseDate(v) {
  if (isTbd(v)) return null;
  const s = String(v).trim();
  let m;
  if (m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/)) {
    return valid(+m[1], +m[2], +m[3]) ?? "invalid";
  }
  if (m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/)) {
    const y = m[3].length === 2 ? 2e3 + +m[3] : +m[3];
    return valid(y, +m[1], +m[2]) ?? "invalid";
  }
  if (m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]+(\d{4})$/)) {
    const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? valid(+m[3], mo, +m[1]) ?? "invalid" : "invalid";
  }
  if (m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/)) {
    const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo ? valid(+m[3], mo, +m[2]) ?? "invalid" : "invalid";
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n > 2e4 && n < 8e4) return fromEpochDay(n - 25569);
  }
  return "invalid";
}
function fromEpochDay(n) {
  return new Date(n * 864e5).toISOString().slice(0, 10);
}
function yearStart(iso) {
  return `${iso.slice(0, 4)}-01-01`;
}
function yearEnd(iso) {
  return `${iso.slice(0, 4)}-12-31`;
}

// src/core/import/convert.ts
function bucketFromName(name) {
  const s = name.trim();
  const m = s.match(/^(CDM|FDR|OBS)(?![A-Za-z])/i);
  if (m) return m[1].toUpperCase();
  if (/^obsolescence\b/i.test(s)) return "OBS";
  return null;
}
function normBucket(v) {
  if (isTbd(v)) return null;
  const s = String(v).trim().toUpperCase();
  if (s === "CDM" || s === "FDR" || s === "OBS") return s;
  if (s.startsWith("OBSOLESCENCE")) return "OBS";
  return null;
}
var text = (v) => isTbd(v) ? null : String(v).trim();
function convertLegacy(rows, map, opts) {
  const cols = Object.keys(map);
  const projectCol = cols.find((c) => map[c].role === "project") ?? null;
  const idCol = cols.find((c) => map[c].role === "id" && /^(id|rowid)$/i.test(c)) ?? null;
  const projectFacilityCol = cols.find((c) => {
    const r = map[c];
    return r.role === "facility" && !r.itemType;
  }) ?? null;
  const report = {
    kind: "legacy",
    sourceTable: opts.sourceTable,
    importedAt: opts.now,
    counts: { rows: rows.length, projects: 0, items: 0, facilities: 0, datedItems: 0 },
    columns: [],
    unmapped: cols.filter((c) => map[c].role === "ignore"),
    unparseable: [],
    flagged: [],
    notes: [],
    dateSpan: null
  };
  const byType = /* @__PURE__ */ new Map();
  for (const c of cols) {
    const r = map[c];
    if (r.role === "start" || r.role === "end" || r.role === "single" || r.role === "facility" && r.itemType) {
      const t = r.itemType;
      const g = byType.get(t) ?? {};
      if (r.role === "facility") g.facility = c;
      else g[r.role] = c;
      byType.set(t, g);
    }
  }
  const types = ITEM_TYPES.filter((t) => byType.has(t));
  const projects = [];
  const items = [];
  const facilities = /* @__PURE__ */ new Set();
  const usedNames = /* @__PURE__ */ new Map();
  const filled = {};
  let min = null;
  let max = null;
  const see = (d) => {
    if (!d) return;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  };
  rows.forEach((row, i) => {
    const rowNo = idCol && row[idCol] != null ? Number(row[idCol]) : i + 1;
    for (const c of cols) if (!isTbd(row[c])) filled[c] = (filled[c] ?? 0) + 1;
    let name = projectCol ? text(row[projectCol]) : null;
    if (!name) {
      name = `Unnamed-${rowNo}`;
      report.notes.push(`Row ${rowNo} has no project name; imported as "${name}".`);
    }
    const seen = usedNames.get(name.toLowerCase()) ?? 0;
    usedNames.set(name.toLowerCase(), seen + 1);
    if (seen > 0) {
      const renamed = `${name} (${seen + 1})`;
      report.notes.push(`Row ${rowNo}: duplicate project name "${name}" imported as "${renamed}".`);
      name = renamed;
    }
    const bucketCol = cols.find((c) => map[c].role === "bucket");
    const baselineCol = cols.find((c) => map[c].role === "baseline");
    const leadCol = cols.find((c) => map[c].role === "lead");
    const p = {
      name,
      bucket: (bucketCol ? normBucket(row[bucketCol]) : null) ?? bucketFromName(name),
      baseline: baselineCol ? text(row[baselineCol]) : null,
      technical_lead: leadCol ? text(row[leadCol]) : null,
      sort_order: i + 1
    };
    const projectIndex = projects.push(p) - 1;
    const projectFacility = projectFacilityCol ? text(row[projectFacilityCol])?.toUpperCase() ?? null : null;
    const parse = (col) => {
      if (!col) return null;
      const v = parseLooseDate(row[col]);
      if (v === "invalid") {
        report.unparseable.push({ row: rowNo, project: name, column: col, value: String(row[col]) });
        return null;
      }
      return v;
    };
    for (const t of types) {
      const g = byType.get(t);
      let start;
      let end;
      if (t === "trr") {
        start = parse(g.single ?? g.start ?? g.end);
        end = null;
      } else if (g.single && !g.start && !g.end) {
        start = parse(g.single);
        end = start;
        if (start) report.flagged.push({ row: rowNo, project: name, itemType: t, reason: "end date needed (source had one date)" });
      } else {
        start = parse(g.start);
        end = parse(g.end);
        if (start && end && end < start) {
          report.flagged.push({ row: rowNo, project: name, itemType: t, reason: `end ${end} is before start ${start}; end cleared` });
          end = null;
        }
      }
      const facility = (g.facility ? text(row[g.facility])?.toUpperCase() : null) ?? projectFacility ?? null;
      if (facility) facilities.add(facility);
      see(start);
      see(end);
      items.push({ projectIndex, item_type: t, facility, start_date: start, end_date: end });
    }
  });
  for (const c of cols) {
    const r = map[c];
    if (r.role === "ignore" || r.role === "id") continue;
    report.columns.push({ column: c, mappedTo: describeRole(r), filled: filled[c] ?? 0, total: rows.length });
  }
  if (!projectCol) report.notes.push("No project-name column was found; projects were named by row.");
  report.counts.projects = projects.length;
  report.counts.items = items.length;
  report.counts.datedItems = items.filter((x) => x.start_date || x.end_date).length;
  report.counts.facilities = facilities.size;
  report.dateSpan = min && max ? { start: yearStart(min), end: yearEnd(max) } : null;
  return { projects, items, facilities: [...facilities].sort(), report };
}

// src/core/import/detect.ts
function detect(db2) {
  const tables2 = listTables(db2);
  const version = db2.get("PRAGMA user_version")?.user_version ?? 0;
  const ours = OUR_TABLES.filter((t) => tables2.includes(t));
  if (ours.length === OUR_TABLES.length && version === SCHEMA_VERSION) return { kind: "untangle" };
  if (tables2.length === 0) return { kind: "empty" };
  if (ours.length > 0) {
    return {
      kind: "clash",
      reason: `This file already has table(s) named ${ours.join(", ")} that are not an Untangle v${SCHEMA_VERSION} schema. Untangle will not write over them. Rename those tables or use a copy of the file.`
    };
  }
  let best = null;
  for (const t of tables2) {
    const map = guessColumnMap(tableColumns(db2, t));
    const hasProject = Object.values(map).some((r) => r.role === "project");
    const { pairs, dates } = dateColumnCount(map);
    if (!hasProject || pairs < 1) continue;
    const score = pairs * 10 + dates;
    if (!best || score > best.score) best = { table: t, map, score };
  }
  if (best) return { kind: "legacy", table: best.table, map: best.map };
  return { kind: "unknown", tables: tables2.map((name) => ({ name, columns: tableColumns(db2, name) })) };
}
function createSchema(db2, now, extraFacilities = []) {
  db2.exec(SCHEMA_SQL);
  const fac = db2.get("SELECT count(*) n FROM facilities").n;
  if (fac === 0) for (const code of DEFAULT_FACILITIES) db2.run("INSERT INTO facilities (code, name) VALUES (?, ?)", code, code);
  for (const code of extraFacilities) db2.run("INSERT OR IGNORE INTO facilities (code, name) VALUES (?, ?)", code, code);
  for (const v of STARTER_VIEWS) {
    db2.run("INSERT OR IGNORE INTO views (name, definition) VALUES (?, ?)", v.name, JSON.stringify(v.definition));
  }
  const setMeta = (k, v) => db2.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", k, v);
  setMeta("writer_notes", WRITER_NOTES);
  setMeta("schema_created_at", now);
  db2.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
function setWal(db2) {
  try {
    db2.exec("PRAGMA journal_mode = WAL");
  } catch {
  }
  db2.exec("PRAGMA foreign_keys = ON");
}
function initEmpty(db2, now) {
  setWal(db2);
  tx(db2, () => createSchema(db2, now));
  return {
    kind: "empty",
    sourceTable: null,
    importedAt: now,
    counts: { rows: 0, projects: 0, items: 0, facilities: DEFAULT_FACILITIES.length, datedItems: 0 },
    columns: [],
    unmapped: [],
    unparseable: [],
    flagged: [],
    notes: ["New database created."],
    dateSpan: null
  };
}
function importLegacy(db2, table, map, now) {
  const rows = db2.all(`SELECT * FROM ${quoteIdent(table)}`);
  const conv = convertLegacy(rows, map, { sourceTable: table, now });
  setWal(db2);
  tx(db2, () => {
    createSchema(db2, now, conv.facilities);
    const ids = [];
    for (const p of conv.projects) {
      const r = db2.run(
        "INSERT INTO projects (name, bucket, baseline, technical_lead, sort_order) VALUES (?, ?, ?, ?, ?)",
        p.name,
        p.bucket,
        p.baseline,
        p.technical_lead,
        p.sort_order
      );
      ids.push(r.lastInsertRowid);
    }
    for (const it of conv.items) {
      db2.run(
        `INSERT INTO schedule_items (project_id, item_type, facility, start_date, end_date, confidence, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, 'estimated', ?, 'luna')`,
        ids[it.projectIndex],
        it.item_type,
        it.facility,
        it.start_date,
        it.end_date,
        now
      );
    }
    const setMeta = (k, v) => db2.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", k, v);
    setMeta("imported_at", now);
    setMeta("source_table", table);
    setMeta("column_map", JSON.stringify(map));
    setMeta("import_report", JSON.stringify(conv.report));
    setMeta("source_fingerprint", sourceFingerprint(db2, table));
    if (conv.report.dateSpan) setMeta("default_range", JSON.stringify(conv.report.dateSpan));
  });
  return conv;
}
function sourceFingerprint(db2, table) {
  const rows = db2.all(`SELECT * FROM ${quoteIdent(table)}`);
  let h = 2166136261;
  const s = JSON.stringify(rows);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${rows.length}:${(h >>> 0).toString(16)}`;
}

// src/core/sqlite-node.ts
var import_node_sqlite = require("node:sqlite");
function openNodeSqlite(path, opts = {}) {
  const db2 = new import_node_sqlite.DatabaseSync(path, { readOnly: !!opts.readOnly });
  db2.exec("PRAGMA busy_timeout = 3000");
  const cache = /* @__PURE__ */ new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db2.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    exec: (sql) => db2.exec(sql),
    all: (sql, ...p) => stmt(sql).all(...p),
    get: (sql, ...p) => stmt(sql).get(...p),
    run: (sql, ...p) => {
      const r = stmt(sql).run(...p);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    close: () => {
      cache.clear();
      db2.close();
    }
  };
}

// src/core/labels.ts
var EMPTY_STYLES = { all: {}, byType: {}, byItem: {} };
function applyPatch(base, patch) {
  const out = { ...base ?? {} };
  for (const k of ["label", "start", "end"]) {
    if (!patch[k]) continue;
    const merged = { ...out[k] ?? {} };
    for (const [f, v] of Object.entries(patch[k])) {
      if (v === void 0) delete merged[f];
      else merged[f] = v;
    }
    out[k] = merged;
  }
  return out;
}

// src/core/store.ts
function loadDataset(db2) {
  const meta = {};
  for (const r of db2.all("SELECT key, value FROM meta")) meta[r.key] = r.value;
  let labelStyles = EMPTY_STYLES;
  try {
    if (meta.label_styles) labelStyles = { ...EMPTY_STYLES, ...JSON.parse(meta.label_styles) };
  } catch {
  }
  return {
    labelStyles,
    facilities: db2.all("SELECT code, name, active FROM facilities ORDER BY code"),
    projects: db2.all("SELECT * FROM projects WHERE active = 1 ORDER BY sort_order IS NULL, sort_order, name"),
    items: db2.all("SELECT * FROM schedule_items ORDER BY project_id, start_date IS NULL, start_date, id"),
    views: db2.all("SELECT id, name, definition FROM views ORDER BY id").map((v) => ({ id: v.id, name: v.name, definition: JSON.parse(v.definition) })),
    meta
  };
}
var EDITABLE_FIELDS = ["start_date", "end_date", "facility", "confidence", "item_type", "label"];
var StaleError = class extends Error {
  constructor(rows) {
    super("stale");
    this.rows = rows;
  }
  rows;
};
function validateItem(row) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (row.start_date && !iso.test(row.start_date)) return `Bad start date: ${row.start_date}`;
  if (row.end_date && !iso.test(row.end_date)) return `Bad end date: ${row.end_date}`;
  if (row.item_type !== "trr" && row.start_date && row.end_date && row.end_date < row.start_date) {
    return "End date is before start date.";
  }
  return null;
}
function applyChanges(db2, changes, now, by = "app") {
  try {
    const updated = tx(db2, () => {
      const stale = [];
      const out = [];
      for (const c of changes) {
        const cur = db2.get("SELECT * FROM schedule_items WHERE id = ?", c.id);
        if (!cur) throw new Error(`Item ${c.id} no longer exists.`);
        if (cur.updated_at !== c.expectedUpdatedAt) {
          stale.push(cur);
          continue;
        }
        const next = { ...cur };
        const fields = Object.keys(c.patch).filter((f) => EDITABLE_FIELDS.includes(f));
        for (const f of fields) next[f] = c.patch[f] ?? null;
        if (next.item_type === "trr") next.end_date = null;
        const err = validateItem(next);
        if (err) throw new Error(err);
        const changed = Object.keys(next).filter(
          (f) => EDITABLE_FIELDS.includes(f) && next[f] !== cur[f]
        );
        if (changed.length === 0) {
          out.push(cur);
          continue;
        }
        const stamp2 = now > cur.updated_at ? now : bump(cur.updated_at);
        const sets = changed.map((f) => `${f} = ?`).join(", ");
        db2.run(
          `UPDATE schedule_items SET ${sets}, updated_at = ?, updated_by = ? WHERE id = ?`,
          ...changed.map((f) => next[f]),
          stamp2,
          by,
          c.id
        );
        for (const f of changed) {
          db2.run(
            "INSERT INTO change_log (item_id, field, old_value, new_value, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?)",
            c.id,
            f,
            cur[f] ?? null,
            next[f] ?? null,
            stamp2,
            by
          );
        }
        out.push(db2.get("SELECT * FROM schedule_items WHERE id = ?", c.id));
      }
      if (stale.length) throw new StaleError(stale);
      return out;
    });
    return { ok: true, updated };
  } catch (e) {
    if (e instanceof StaleError) return { ok: false, reason: "stale", stale: e.rows };
    return { ok: false, reason: "error", message: e.message };
  }
}
function bump(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? (/* @__PURE__ */ new Date()).toISOString() : new Date(t + 1).toISOString();
}
function undoLast(db2, now) {
  const last = db2.get(
    "SELECT changed_at FROM change_log WHERE changed_by = 'app' AND field NOT LIKE 'undo%' ORDER BY id DESC LIMIT 1"
  );
  if (!last) return { ok: false, message: "Nothing to undo.", itemIds: [] };
  const rows = db2.all(
    "SELECT id, item_id, field, old_value, new_value FROM change_log WHERE changed_by = 'app' AND changed_at = ? AND field NOT LIKE 'undo%' ORDER BY id",
    last.changed_at
  );
  const del = rows.find((r) => r.field === "deleted");
  if (del) {
    try {
      tx(db2, () => {
        const row = JSON.parse(del.old_value ?? "{}");
        if (db2.get("SELECT 1 FROM schedule_items WHERE id = ?", row.id)) throw new Error("An item with that id exists again.");
        db2.run(
          `INSERT INTO schedule_items (id, project_id, item_type, label, facility, start_date, end_date, confidence, updated_at, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.id,
          row.project_id,
          row.item_type,
          row.label,
          row.facility,
          row.start_date,
          row.end_date,
          row.confidence,
          row.updated_at,
          row.updated_by
        );
        db2.run("UPDATE change_log SET field = 'undone:deleted' WHERE id = ?", del.id);
        db2.run(
          "INSERT INTO change_log (item_id, field, old_value, new_value, changed_at, changed_by) VALUES (?, ?, NULL, ?, ?, ?)",
          row.id,
          "undo:deleted",
          "restored",
          now,
          "app"
        );
      });
      return { ok: true, message: "Restored the deleted item.", itemIds: [del.item_id] };
    } catch (e) {
      return { ok: false, message: e.message, itemIds: [del.item_id] };
    }
  }
  const ids = [...new Set(rows.map((r) => r.item_id))];
  for (const id of ids) {
    const cur = db2.get("SELECT updated_at FROM schedule_items WHERE id = ?", id);
    const mine = db2.get(
      "SELECT changed_at FROM change_log WHERE item_id = ? AND changed_by = 'app' ORDER BY id DESC LIMIT 1",
      id
    );
    if (!cur || !mine || cur.updated_at !== mine.changed_at) {
      return { ok: false, message: "That item changed after your edit, so undo was skipped. Reload to see the latest.", itemIds: ids };
    }
  }
  try {
    tx(db2, () => {
      const stamp2 = bump(last.changed_at) > now ? bump(last.changed_at) : now;
      for (const id of ids) {
        const mine = rows.filter((r) => r.item_id === id);
        if (mine.some((r) => r.field === "created")) {
          db2.run("DELETE FROM schedule_items WHERE id = ?", id);
          db2.run(
            "INSERT INTO change_log (item_id, field, old_value, new_value, changed_at, changed_by) VALUES (?, ?, ?, NULL, ?, ?)",
            id,
            "undo:created",
            mine[0].new_value,
            stamp2,
            "app"
          );
          continue;
        }
        const sets = mine.map((r) => `${r.field} = ?`).join(", ");
        db2.run(
          `UPDATE schedule_items SET ${sets}, updated_at = ?, updated_by = 'app' WHERE id = ?`,
          ...mine.map((r) => r.old_value),
          stamp2,
          id
        );
        for (const r of mine) {
          db2.run(
            "INSERT INTO change_log (item_id, field, old_value, new_value, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?)",
            id,
            `undo:${r.field}`,
            r.new_value,
            r.old_value,
            stamp2,
            "app"
          );
        }
      }
      for (const r of rows) db2.run("UPDATE change_log SET field = 'undone:' || field WHERE id = ?", r.id);
    });
  } catch (e) {
    return { ok: false, message: e.message, itemIds: ids };
  }
  return { ok: true, message: `Undid change to ${ids.length} item(s).`, itemIds: ids };
}
function addItem(db2, projectId, type, start, end, now, by = "app", extra = {}) {
  return tx(db2, () => {
    const r = db2.run(
      `INSERT INTO schedule_items (project_id, item_type, start_date, end_date, facility, confidence, label, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      type,
      start,
      type === "trr" ? null : end,
      extra.facility ?? null,
      extra.confidence ?? "notional",
      extra.label ?? null,
      now,
      by
    );
    db2.run(
      "INSERT INTO change_log (item_id, field, old_value, new_value, changed_at, changed_by) VALUES (?, ?, NULL, ?, ?, ?)",
      r.lastInsertRowid,
      "created",
      type,
      now,
      by
    );
    return db2.get("SELECT * FROM schedule_items WHERE id = ?", r.lastInsertRowid);
  });
}
function saveView(db2, name, def) {
  db2.run(
    "INSERT INTO views (name, definition) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET definition = excluded.definition",
    name,
    JSON.stringify(def)
  );
  const v = db2.get("SELECT * FROM views WHERE name = ?", name);
  return { id: v.id, name: v.name, definition: JSON.parse(v.definition) };
}
function deleteView(db2, id) {
  db2.run("DELETE FROM views WHERE id = ?", id);
}
function setLabelStyles(db2, scope, patch, mode = "replace") {
  return tx(db2, () => {
    const row = db2.get("SELECT value FROM meta WHERE key = 'label_styles'");
    let cur = { all: {}, byType: {}, byItem: {} };
    try {
      if (row?.value) cur = { ...cur, ...JSON.parse(row.value) };
    } catch {
    }
    const next = (old) => patch === null ? void 0 : mode === "merge" ? applyPatch(old, patch) : patch;
    if (scope.kind === "all") cur.all = next(cur.all) ?? {};
    else if (scope.kind === "type") {
      const v = next(cur.byType[scope.type]);
      if (v) cur.byType[scope.type] = v;
      else delete cur.byType[scope.type];
    } else {
      const v = next(cur.byItem[scope.id]);
      if (v && Object.keys(v).length) cur.byItem[scope.id] = v;
      else delete cur.byItem[scope.id];
    }
    db2.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "label_styles", JSON.stringify(cur));
    return cur;
  });
}

// src/core/tables.ts
var EDITABLE = {
  schedule_items: { key: "id", cols: ["item_type", "label", "facility", "start_date", "end_date", "confidence"] },
  projects: { key: "id", cols: ["name", "bucket", "baseline", "technical_lead", "sort_order", "active"] },
  facilities: { key: "code", cols: ["name", "active"] }
};
var NOTES = {
  schedule_items: "One row per bar or milestone. Edits are logged and can be undone (Ctrl+Z).",
  projects: "Projects. Name must be unique; bucket CDM, FDR, OBS or empty (TBD).",
  facilities: "Lab codes. Add a code here before using it on an item.",
  change_log: "Every change by the app or Luna. Read-only.",
  meta: "Import bookkeeping, writer notes, text styles. Read-only.",
  views: "Saved chart views. Read-only here; manage them from the chart."
};
var OURS = /* @__PURE__ */ new Set(["schedule_items", "projects", "facilities", "change_log", "meta", "views"]);
var EditError = class extends Error {
};
function tables(db2) {
  return listTables(db2).map((name) => ({
    name,
    rows: db2.get(`SELECT count(*) n FROM ${quoteIdent(name)}`).n,
    editable: !!EDITABLE[name],
    note: NOTES[name] ?? (OURS.has(name) ? "" : "Imported source table. Read-only: Untangle never changes it.")
  })).sort((a, b) => Number(b.editable) - Number(a.editable) || Number(OURS.has(b.name)) - Number(OURS.has(a.name)) || a.name.localeCompare(b.name));
}
function columnsOf(db2, table, facilities) {
  const info = db2.all("SELECT name, type FROM pragma_table_info(?)", table);
  const ed = EDITABLE[table];
  return info.map((c) => ({
    name: c.name,
    type: c.type || "ANY",
    editable: !!ed?.cols.includes(c.name),
    options: table === "schedule_items" && c.name === "item_type" ? [...ITEM_TYPES] : table === "schedule_items" && c.name === "confidence" ? [...CONFIDENCES] : table === "schedule_items" && c.name === "facility" ? ["", ...facilities] : table === "projects" && c.name === "bucket" ? ["", ...BUCKETS] : c.name === "active" && ed ? ["1", "0"] : void 0
  }));
}
function readPage(db2, table, opts = {}) {
  if (!listTables(db2).includes(table)) throw new EditError(`No table ${table}.`);
  const facilities = listTables(db2).includes("facilities") ? db2.all("SELECT code FROM facilities ORDER BY code").map((f2) => f2.code) : [];
  const columns = columnsOf(db2, table, facilities);
  const names = columns.map((c) => c.name);
  const key = EDITABLE[table]?.key ?? "rowid";
  const where = [];
  const params = [];
  const f = opts.filter?.trim();
  if (f) {
    where.push(`(${names.map((n) => `CAST(${quoteIdent(n)} AS TEXT) LIKE ?`).join(" OR ")})`);
    for (let i = 0; i < names.length; i++) params.push(`%${f}%`);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sort = opts.sort && names.includes(opts.sort) ? quoteIdent(opts.sort) : key === "rowid" ? "rowid" : quoteIdent(key);
  const dir = opts.dir === "desc" ? "DESC" : "ASC";
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1e3);
  const offset = Math.max(opts.offset ?? 0, 0);
  const sel = key === "rowid" ? 'rowid AS "__rowid", *' : "*";
  const total = db2.get(`SELECT count(*) n FROM ${quoteIdent(table)} ${w}`, ...params).n;
  const rows = db2.all(
    `SELECT ${sel} FROM ${quoteIdent(table)} ${w} ORDER BY ${sort} ${dir} NULLS LAST LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  );
  return { columns, key: key === "rowid" ? "__rowid" : key, rows, total };
}
var blank = (v) => v === "" || v === void 0 ? null : v;
function updateCell(db2, table, keyValue, column, value, now, expectedVersion, by = "app") {
  const ed = EDITABLE[table];
  if (!ed || !ed.cols.includes(column)) throw new EditError(`${table}.${column} is read-only.`);
  const v = blank(typeof value === "string" ? value.trim() : value);
  if (table === "schedule_items") {
    const cur = db2.get("SELECT * FROM schedule_items WHERE id = ?", Number(keyValue));
    if (!cur) throw new EditError(`No item ${keyValue}.`);
    if (column === "facility" && v !== null && !db2.get("SELECT 1 FROM facilities WHERE code = ?", String(v).toUpperCase())) {
      throw new EditError(`Unknown facility ${v}. Add it in the facilities table first.`);
    }
    if (column === "item_type" && !ITEM_TYPES.includes(v)) throw new EditError(`Type must be one of ${ITEM_TYPES.join(", ")}.`);
    if (column === "confidence" && !CONFIDENCES.includes(v)) throw new EditError("Confidence must be firm, estimated or notional.");
    if ((column === "start_date" || column === "end_date") && v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new EditError("Dates are YYYY-MM-DD (or empty for TBD).");
    const patch = { [column]: column === "facility" && v !== null ? String(v).toUpperCase() : v };
    const r2 = applyChanges(db2, [{ id: cur.id, expectedUpdatedAt: expectedVersion ?? cur.updated_at, patch }], now, by);
    if (!r2.ok) throw new EditError(r2.reason === "stale" ? "This row changed since you loaded it (Luna or another edit). Reloaded \u2014 try again." : r2.message);
    return;
  }
  if (table === "projects") {
    if (column === "name" && !v) throw new EditError("Name is required.");
    if (column === "name" && db2.get("SELECT 1 FROM projects WHERE lower(name) = lower(?) AND id <> ?", String(v), Number(keyValue))) throw new EditError(`Another project is already called ${v}.`);
    if (column === "bucket" && v !== null && !BUCKETS.includes(String(v).toUpperCase())) throw new EditError("Bucket must be CDM, FDR, OBS or empty.");
  }
  if (column === "active" && v !== null && !["0", "1", 0, 1].includes(v)) throw new EditError("Active is 1 or 0.");
  const val = column === "bucket" && v !== null ? String(v).toUpperCase() : column === "active" || column === "sort_order" ? v === null ? null : Number(v) : v;
  const r = db2.run(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ? WHERE ${quoteIdent(ed.key)} = ?`, val, keyValue);
  if (r.changes !== 1) throw new EditError("Row not found.");
}
function insertRow(db2, table, values, now) {
  if (table === "schedule_items") {
    const pid = Number(values.project_id);
    if (!db2.get("SELECT 1 FROM projects WHERE id = ?", pid)) throw new EditError("Pick a project.");
    const type = values.item_type || "other";
    if (!ITEM_TYPES.includes(type)) throw new EditError("Bad type.");
    return addItem(db2, pid, type, blank(values.start_date) ?? null, blank(values.end_date) ?? null, now).id;
  }
  if (table === "projects") {
    const name = String(values.name ?? "").trim();
    if (!name) throw new EditError("Name is required.");
    if (db2.get("SELECT 1 FROM projects WHERE lower(name) = lower(?)", name)) throw new EditError(`${name} already exists.`);
    const order = (db2.get("SELECT max(sort_order) m FROM projects")?.m ?? 0) + 1;
    return db2.run("INSERT INTO projects (name, sort_order) VALUES (?, ?)", name, order).lastInsertRowid;
  }
  if (table === "facilities") {
    const code = String(values.code ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,16}$/.test(code)) throw new EditError("Code: letters/digits, up to 16.");
    if (db2.get("SELECT 1 FROM facilities WHERE code = ?", code)) throw new EditError(`${code} already exists.`);
    db2.run("INSERT INTO facilities (code, name) VALUES (?, ?)", code, code);
    return code;
  }
  throw new EditError(`${table} is read-only.`);
}
function deleteRow(db2, table, keyValue, now) {
  tx(db2, () => {
    if (table === "schedule_items") {
      const cur = db2.get("SELECT * FROM schedule_items WHERE id = ?", Number(keyValue));
      if (!cur) throw new EditError("Row not found.");
      db2.run("DELETE FROM schedule_items WHERE id = ?", cur.id);
      db2.run(
        "INSERT INTO change_log (item_id, field, old_value, new_value, changed_at, changed_by) VALUES (?, ?, ?, NULL, ?, ?)",
        cur.id,
        "deleted",
        JSON.stringify(cur),
        now,
        "app"
      );
      return;
    }
    if (table === "projects") {
      const n = db2.get("SELECT count(*) n FROM schedule_items WHERE project_id = ?", Number(keyValue)).n;
      if (n) throw new EditError(`This project still has ${n} item(s). Delete or move them first, or set active = 0 to hide it.`);
      if (db2.run("DELETE FROM projects WHERE id = ?", Number(keyValue)).changes !== 1) throw new EditError("Row not found.");
      return;
    }
    if (table === "facilities") {
      const n = db2.get("SELECT count(*) n FROM schedule_items WHERE facility = ?", String(keyValue)).n;
      if (n) throw new EditError(`${n} item(s) use ${keyValue}. Set active = 0 instead.`);
      if (db2.run("DELETE FROM facilities WHERE code = ?", String(keyValue)).changes !== 1) throw new EditError("Row not found.");
      return;
    }
    throw new EditError(`${table} is read-only.`);
  });
}

// src/main/files.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var pad = (n) => String(n).padStart(2, "0");
function stamp(d = /* @__PURE__ */ new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
function backupDb(dbPath2, opts = {}) {
  const dir = (0, import_node_path.join)((0, import_node_path.dirname)(dbPath2), "backups");
  (0, import_node_fs.mkdirSync)(dir, { recursive: true });
  const base = (0, import_node_path.basename)(dbPath2, (0, import_node_path.extname)(dbPath2));
  let name = `${base}-${stamp(opts.now)}${opts.tag ? `-${opts.tag}` : ""}.sqlite`;
  for (let i = 2; (0, import_node_fs.existsSync)((0, import_node_path.join)(dir, name)); i++) {
    name = `${base}-${stamp(opts.now)}${opts.tag ? `-${opts.tag}` : ""}-${i}.sqlite`;
  }
  const target = (0, import_node_path.join)(dir, name);
  (0, import_node_fs.copyFileSync)(dbPath2, target);
  if ((0, import_node_fs.existsSync)(dbPath2 + "-wal")) (0, import_node_fs.copyFileSync)(dbPath2 + "-wal", target + "-wal");
  prune(dir, base, opts.keep ?? 20);
  return target;
}
function prune(dir, base, keep) {
  const mine = (0, import_node_fs.readdirSync)(dir).filter((f) => f.startsWith(base + "-") && f.endsWith(".sqlite")).sort();
  for (const f of mine.slice(0, Math.max(0, mine.length - keep))) {
    (0, import_node_fs.rmSync)((0, import_node_path.join)(dir, f), { force: true });
    (0, import_node_fs.rmSync)((0, import_node_path.join)(dir, f + "-wal"), { force: true });
  }
}

// src/main/index.ts
var APP_DIR = import_electron.app.getAppPath();
var CONFIG = (0, import_node_path2.join)(APP_DIR, "config.json");
var RENDERER = (0, import_node_path2.join)(__dirname, "renderer", "index.html");
var PRELOAD = (0, import_node_path2.join)(__dirname, "preload.cjs");
var win = null;
var db = null;
var dbPath = null;
var lastGood = null;
var lastReport = null;
var backedUpThisSession = false;
var watcher = null;
var dataVersion = -1;
function readConfig() {
  try {
    return JSON.parse((0, import_node_fs2.readFileSync)(CONFIG, "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(c) {
  try {
    (0, import_node_fs2.writeFileSync)(CONFIG, JSON.stringify(c, null, 2));
  } catch {
  }
}
var nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
function closeDb() {
  watcher?.close();
  watcher = null;
  try {
    db?.close();
  } catch {
  }
  db = null;
  dbPath = null;
  lastGood = null;
  lastReport = null;
}
function readDataset() {
  if (!db) throw new Error("No database open.");
  const ds = loadDataset(db);
  lastGood = ds;
  dataVersion = db.get("PRAGMA data_version").data_version;
  return ds;
}
function storedReport() {
  const raw = lastGood?.meta.import_report;
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function openPath(p) {
  closeDb();
  if (!(0, import_node_fs2.existsSync)(p)) return { ok: false, path: p, kind: "unreadable", message: `File not found:
${p}` };
  let handle;
  try {
    handle = openNodeSqlite(p);
    handle.get("SELECT count(*) n FROM sqlite_master");
  } catch (e) {
    return { ok: false, path: p, kind: "unreadable", message: `Untangle cannot read this file. It may be corrupt, locked by another program, or not a SQLite database.

${e.message}` };
  }
  const d = detect(handle);
  let report = null;
  let backup = null;
  try {
    if (d.kind === "unknown") {
      handle.close();
      return {
        ok: false,
        path: p,
        kind: "unknown",
        tables: d.tables,
        message: "This file has no table Untangle recognises (a project column plus *_start / *_end columns). The column-mapping screen comes in the next build."
      };
    }
    if (d.kind === "clash") {
      handle.close();
      return { ok: false, path: p, kind: "clash", message: d.reason };
    }
    if (d.kind === "empty") report = initEmpty(handle, nowIso());
    if (d.kind === "legacy") {
      backup = backupDb(p, { tag: "pre-import" });
      backedUpThisSession = true;
      report = importLegacy(handle, d.table, d.map, nowIso()).report;
    }
  } catch (e) {
    handle.close();
    return { ok: false, path: p, kind: "unreadable", message: `Import failed. The file was not changed beyond the backup.

${e.message}` };
  }
  db = handle;
  dbPath = p;
  if (d.kind !== "legacy") backedUpThisSession = false;
  const dataset = readDataset();
  lastReport = report ?? storedReport();
  writeConfig({ ...readConfig(), dbPath: p });
  startWatch();
  updateTitle();
  return { ok: true, path: p, kind: d.kind, dataset, report: lastReport, backup };
}
function ensureBackup() {
  if (backedUpThisSession || !dbPath) return;
  backupDb(dbPath);
  backedUpThisSession = true;
}
function updateTitle() {
  win?.setTitle(dbPath ? `Untangle \u2014 ${(0, import_node_path2.basename)(dbPath)}` : "Untangle");
}
function startWatch() {
  if (!dbPath) return;
  const name = (0, import_node_path2.basename)(dbPath);
  let timer = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(checkOutsideChange, 500);
  };
  try {
    watcher = (0, import_node_fs2.watch)((0, import_node_path2.dirname)(dbPath), (_ev, f) => {
      if (!f || f === name || f === `${name}-wal`) fire();
    });
  } catch {
  }
}
function checkOutsideChange(attempt = 0) {
  if (!db || !win) return;
  try {
    const v = db.get("PRAGMA data_version").data_version;
    if (v === dataVersion) return;
    const ds = readDataset();
    win.webContents.send("db:changed", ds, "outside");
  } catch {
    if (attempt < 5) setTimeout(() => checkOutsideChange(attempt + 1), 1e3);
  }
}
function sampleCopy() {
  const target = (0, import_node_path2.join)(APP_DIR, "demo.sqlite");
  if (!(0, import_node_fs2.existsSync)(target)) (0, import_node_fs2.copyFileSync)((0, import_node_path2.join)(APP_DIR, "db", "sample.sqlite"), target);
  return target;
}
import_electron.ipcMain.handle("db:load", () => {
  if (db && dbPath && lastGood) return { ok: true, path: dbPath, kind: "untangle", dataset: lastGood, report: lastReport };
  const p = readConfig().dbPath;
  if (p && (0, import_node_fs2.existsSync)(p)) return openPath(p);
  return openPath(sampleCopy());
});
import_electron.ipcMain.handle("db:openOrImport", async () => {
  const auto = process.env.UNTANGLE_SELFTEST ? process.env.UNTANGLE_IMPORT_PATH : void 0;
  const r = auto ? { canceled: false, filePaths: [auto] } : await import_electron.dialog.showOpenDialog(win, {
    title: "Open or import a SQLite database",
    properties: ["openFile"],
    filters: [{ name: "SQLite database", extensions: ["sqlite", "db", "sqlite3", "db3"] }, { name: "All files", extensions: ["*"] }]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, path: dbPath, kind: "cancelled" };
  const res = openPath(r.filePaths[0]);
  if (!res.ok && lastGood === null) {
    const prev = readConfig().dbPath;
    if (prev && prev !== r.filePaths[0] && (0, import_node_fs2.existsSync)(prev)) openPath(prev);
  }
  return res;
});
import_electron.ipcMain.handle("db:openSample", () => openPath(sampleCopy()));
import_electron.ipcMain.handle("db:reload", () => {
  if (!db || !dbPath) return { ok: false, path: null, message: "No database open." };
  try {
    return { ok: true, path: dbPath, kind: "untangle", dataset: readDataset(), report: lastReport };
  } catch (e) {
    return { ok: false, path: dbPath, message: e.message, dataset: lastGood ?? void 0 };
  }
});
import_electron.ipcMain.handle("db:updateItems", (_e, changes) => {
  if (!db) return { ok: false, reason: "error", message: "No database open." };
  ensureBackup();
  const r = applyChanges(db, changes, nowIso());
  return { ...r, dataset: readDataset() };
});
import_electron.ipcMain.handle("db:undo", () => {
  if (!db) return { ok: false, message: "No database open." };
  ensureBackup();
  const r = undoLast(db, nowIso());
  return { ok: r.ok, message: r.message, dataset: readDataset() };
});
import_electron.ipcMain.handle("db:addItem", (_e, projectId, type, start, end) => {
  if (!db) return { ok: false, message: "No database open." };
  ensureBackup();
  try {
    addItem(db, projectId, type, start, end, nowIso());
    return { ok: true, dataset: readDataset() };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});
import_electron.ipcMain.handle("db:saveView", (_e, name, def) => {
  if (!db) throw new Error("No database open.");
  ensureBackup();
  const view = saveView(db, name, def);
  return { view, dataset: readDataset() };
});
import_electron.ipcMain.handle("db:deleteView", (_e, id) => {
  if (!db) throw new Error("No database open.");
  deleteView(db, id);
  return { dataset: readDataset() };
});
import_electron.ipcMain.handle("db:setLabels", (_e, scope, patch, mode) => {
  if (!db) return { ok: false, message: "No database open." };
  ensureBackup();
  try {
    setLabelStyles(db, scope, patch, mode);
    return { ok: true, dataset: readDataset() };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});
import_electron.ipcMain.handle("data:tables", () => db ? tables(db) : []);
import_electron.ipcMain.handle("data:page", (_e, table, opts) => {
  if (!db) return { ok: false, message: "No database open." };
  try {
    return { ok: true, page: readPage(db, table, opts) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});
var dataWrite = (fn) => {
  if (!db) return { ok: false, message: "No database open." };
  ensureBackup();
  try {
    const key = fn();
    return { ok: true, key, dataset: readDataset() };
  } catch (e) {
    return { ok: false, message: e.message, dataset: readDataset() };
  }
};
import_electron.ipcMain.handle("data:update", (_e, table, key, column, value, v) => dataWrite(() => updateCell(db, table, key, column, value, nowIso(), v)));
import_electron.ipcMain.handle("data:insert", (_e, table, values) => dataWrite(() => insertRow(db, table, values, nowIso())));
import_electron.ipcMain.handle("data:delete", (_e, table, key) => dataWrite(() => deleteRow(db, table, key, nowIso())));
var exportState = null;
import_electron.ipcMain.handle("export:state", () => exportState);
import_electron.ipcMain.handle("export:view", async (_e, req) => {
  const ext = req.format;
  const safe = req.viewName.replace(/[^A-Za-z0-9 _-]+/g, "").trim() || "view";
  const auto = process.env.UNTANGLE_EXPORT_DIR;
  const r = auto ? { canceled: false, filePath: (0, import_node_path2.join)(auto, `export.${ext}`) } : await import_electron.dialog.showSaveDialog(win, {
    title: `Export ${ext.toUpperCase()}`,
    defaultPath: (0, import_node_path2.join)(dbPath ? (0, import_node_path2.dirname)(dbPath) : import_electron.app.getPath("documents"), `${safe} ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, message: "cancelled" };
  exportState = { ...req, dataDate: lastDataDate() };
  const W = 1920, H = 1080;
  const wa = import_electron.screen.getPrimaryDisplay().workAreaSize;
  const fitW = Math.floor(Math.min(W, wa.width, wa.height * 16 / 9));
  const fitH = Math.round(fitW * 9 / 16);
  const ew = new import_electron.BrowserWindow({
    // Shown but fully transparent, unfocusable and off the taskbar: a hidden window stops painting
    // after its first frame, so later layout (the fit-to-slide scale) would never reach the capture.
    width: fitW,
    height: fitH,
    show: false,
    useContentSize: true,
    frame: false,
    opacity: 0,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  try {
    const ready = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("Export timed out.")), 2e4);
      import_electron.ipcMain.once("export:ready", () => {
        clearTimeout(t);
        res();
      });
    });
    if (process.env.UNTANGLE_SELFTEST) ew.webContents.on("console-message", (e) => console.log(`[export:${e.level}] ${e.message}`));
    ew.webContents.on("did-finish-load", () => ew.webContents.setZoomFactor(fitW / W));
    ew.showInactive();
    await ew.loadFile(RENDERER, { hash: "export" });
    await ready;
    await new Promise((res) => setTimeout(res, 300));
    if (ext === "png") {
      const full = await ew.webContents.capturePage();
      const k = full.getSize().width / ew.getContentSize()[0];
      const img = full.crop({ x: 0, y: 0, width: Math.round(fitW * k), height: Math.round(fitH * k) });
      (0, import_node_fs2.writeFileSync)(r.filePath, img.toPNG());
    } else {
      const pdf = await ew.webContents.printToPDF({
        pageSize: { width: 13.333, height: 7.5 },
        // 16:9 slide, inches
        printBackground: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        scale: 1280 / W
        // CSS px are unaffected by the window zoom when printing
      });
      (0, import_node_fs2.writeFileSync)(r.filePath, pdf);
    }
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, message: e.message };
  } finally {
    exportState = null;
    ew.destroy();
  }
});
function lastDataDate() {
  let max = "";
  for (const it of lastGood?.items ?? []) if (it.updated_at > max) max = it.updated_at;
  const d = max ? new Date(max) : /* @__PURE__ */ new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function send(cmd) {
  win?.webContents.send("menu", cmd);
}
function buildMenu() {
  const t = [
    {
      label: "File",
      submenu: [
        { label: "Open / Import\u2026", accelerator: "CmdOrCtrl+O", click: () => send("open") },
        { label: "Open sample data", click: () => send("open-sample") },
        { label: "Import report / data gaps", accelerator: "CmdOrCtrl+I", click: () => send("report") },
        { type: "separator" },
        { label: "Export PNG\u2026", accelerator: "CmdOrCtrl+E", click: () => send("export-png") },
        { label: "Export PDF\u2026", accelerator: "CmdOrCtrl+Shift+E", click: () => send("export-pdf") },
        { type: "separator" },
        { label: "Show database folder", click: () => dbPath && import_electron.shell.showItemInFolder(dbPath) },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => send("undo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { label: "Refresh data", accelerator: "F5", click: () => send("refresh") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" }
      ]
    }
  ];
  import_electron.Menu.setApplicationMenu(import_electron.Menu.buildFromTemplate(t));
}
function lockDown() {
  import_electron.session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    const ok = /^(file|devtools|data|blob|chrome-extension):/i.test(d.url);
    cb({ cancel: !ok });
  });
  import_electron.app.on("web-contents-created", (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (ev) => ev.preventDefault());
  });
}
function createWindow() {
  win = new import_electron.BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#F3F4F6",
    title: "Untangle",
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  win.loadFile(RENDERER, process.env.UNTANGLE_SELFTEST ? { hash: "selftest" } : process.env.UNTANGLE_HASH ? { hash: process.env.UNTANGLE_HASH } : void 0);
  win.on("closed", () => {
    win = null;
  });
  const shot = process.env.UNTANGLE_SHOT;
  if (process.env.UNTANGLE_SELFTEST) {
    win.webContents.on("console-message", (e) => console.log(`[renderer:${e.level}] ${e.message}`));
    import_electron.ipcMain.handle("test:outsideWrite", (_e, id, start) => {
      const other = openNodeSqlite(dbPath);
      other.run("UPDATE schedule_items SET start_date = ?, updated_at = ?, updated_by = 'luna' WHERE id = ?", start, nowIso(), id);
      other.close();
    });
  }
  if (shot) {
    win.webContents.on("console-message", (e) => console.log(`[renderer:${e.level}] ${e.message}`));
    win.webContents.once("did-finish-load", () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      (0, import_node_fs2.writeFileSync)(shot, img.toPNG());
      import_electron.app.quit();
    }, Number(process.env.UNTANGLE_SHOT_DELAY ?? 3e3)));
  }
}
import_electron.app.whenReady().then(() => {
  lockDown();
  buildMenu();
  createWindow();
});
import_electron.app.on("window-all-closed", () => {
  closeDb();
  import_electron.app.quit();
});
