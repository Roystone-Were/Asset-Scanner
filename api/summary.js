// Vercel serverless function — Xana Asset Summary API
// Returns a JSON summary of the asset portfolio for the C-suite dashboard.
// Endpoint: GET /api/summary?key=<access_key>
// Env vars: TENANT, CLIENT_ID, CLIENT_SECRET, SITE_URL, LIST_NAME, SUMMARY_ACCESS_KEY

const { ConfidentialClientApplication } = require("@azure/msal-node");

// ---------- Config ----------
const TENANT    = process.env.TENANT    || "refrontiergroup.onmicrosoft.com";
const CLIENT_ID = process.env.CLIENT_ID || "7caa51af-9f32-42d8-8264-da5b97c2f8eb";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "";
const SITE_URL   = process.env.SITE_URL   || "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData";
const LIST_NAME  = process.env.LIST_NAME  || "Xana Asset Inventory";
const ACCESS_KEY = process.env.SUMMARY_ACCESS_KEY || "";
const SITE_ID_OVERRIDE  = process.env.SITE_ID  || "";
const LIST_ID_OVERRIDE  = process.env.LIST_ID  || "";

// ---------- Useful-life defaults (straight-line) ----------
const USEFUL_LIFE_BY_TYPE = {
  Laptop: 3, Desktop: 4, Tower: 4, Monitor: 5, Server: 5,
  Printer: 4, Tablet: 3, Phone: 3, Other: 3
};

// ---------- MSAL (app-only client credentials) ----------
let cca = null;
let token = null;
let tokenExpiry = 0;

function getClient() {
  if (!cca) {
    cca = new ConfidentialClientApplication({
      auth: {
        authority: `https://login.microsoftonline.com/${TENANT}`,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      },
    });
  }
  return cca;
}

async function getToken() {
  if (token && Date.now() < tokenExpiry - 120_000) return token;
  const res = await getClient().acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });
  token = res.accessToken;
  tokenExpiry = Date.now() + (res.expiresIn || 3600) * 1000;
  return token;
}

// ---------- Graph helpers ----------
async function graphGet(url, t) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + (t || await getToken()) } });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text().catch(()=>res.statusText)}`);
  return res.json();
}

// ---------- Site / list resolution ----------
let _siteId = "", _listId = "";

async function resolveSiteId() {
  if (SITE_ID_OVERRIDE) return (_siteId = SITE_ID_OVERRIDE);
  const u = new URL(SITE_URL);
  const path = u.host + ":" + u.pathname.replace(/\/+$/, "");
  const data = await graphGet("https://graph.microsoft.com/v1.0/sites/" + encodeURIComponent(path));
  _siteId = data.id;
  return _siteId;
}

async function resolveListId() {
  if (LIST_ID_OVERRIDE) return (_listId = LIST_ID_OVERRIDE);
  if (!_siteId) await resolveSiteId();
  const data = await graphGet("https://graph.microsoft.com/v1.0/sites/" + _siteId + "/lists");
  const list = data.value.find(l => (l.displayName || "").toLowerCase() === LIST_NAME.toLowerCase());
  if (!list) throw new Error(`List "${LIST_NAME}" not found in site`);
  _listId = list.id;
  return _listId;
}

// ---------- Field helper (normalised key lookup) ----------
function fieldV(fields, name) {
  const n = name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (typeof fields !== "object" || fields === null) return null;
  for (const k of Object.keys(fields)) {
    if (k.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() === n) return fields[k];
  }
  return null;
}

// ---------- Fetch all items (paged) ----------
async function fetchItems(optToken) {
  if (!_listId) await resolveListId();
  let url = "https://graph.microsoft.com/v1.0/sites/" + _siteId + "/lists/" + _listId + "/items?expand=fields&$top=999";
  const items = [];
  while (url) {
    const data = await graphGet(url, optToken);
    for (const it of data.value) items.push(it);
    url = data["@odata.nextLink"] || null;
  }
  return items;
}

// ---------- Summary computation ----------
function computeSummary(items) {
  const f = (it, name) => {
    const v = it.fields ? fieldV(it.fields, name) : null;
    return (v !== undefined && v !== null) ? String(v).trim() : "";
  };
  const nf = (it, name) => {
    const v = f(it, name);
    return v === "" ? null : parseFloat(v.replace(/[^0-9.-]/g, ""));
  };

  const getType = (it) => {
    const t = f(it, "Asset Type") || f(it, "Asset") || "Other";
    return USEFUL_LIFE_BY_TYPE[t] ? t : "Other";
  };
  const getUsefulLife = (it) => {
    const ul = nf(it, "Useful Life");
    if (ul && ul > 0) return ul;
    return USEFUL_LIFE_BY_TYPE[getType(it)] || 3;
  };
  const getPrice = (it) => nf(it, "Purchase Price") || 0;
  const getDate = (it) => {
    const d = f(it, "Purchase Date");
    return d ? new Date(d) : null;
  };
  const getAge = (it) => {
    const d = getDate(it);
    if (!d || isNaN(d.getTime())) return null;
    return Math.max(0, (Date.now() - d.getTime()) / 365.25 / 86400000);
  };

  const itemsComputed = items.map(it => {
    const price = getPrice(it);
    const age = getAge(it);
    const ul = getUsefulLife(it);
    const salvage = 0;
    const annualDep = ul > 0 ? (price - salvage) / ul : 0;
    const accumDep = (age !== null && ul > 0) ? Math.min(price - salvage, age * annualDep) : 0;
    const bookValue = Math.max(0, price - accumDep);
    const depStatus = age === null ? "No data" : age >= ul ? "Fully depreciated" : "In progress";
    const lastVerified = f(it, "Last Verified");
    return {
      tag: f(it, "Asset Tag") || f(it, "Title") || "",
      type: getType(it),
      model: f(it, "Model"),
      serial: f(it, "Serial Number"),
      employee: f(it, "Employee Name"),
      department: f(it, "Department") || "—",
      location: f(it, "Location") || "Unassigned",
      status: f(it, "Status"),
      purchaseDate: getDate(it) ? getDate(it).toISOString().slice(0, 10) : "",
      purchasePrice: price,
      usefulLife: ul,
      ageYears: age !== null ? parseFloat(age.toFixed(2)) : null,
      accumDep: parseFloat(accumDep.toFixed(2)),
      bookValue: parseFloat(bookValue.toFixed(2)),
      depStatus,
      lastVerified,
    };
  });

  const total = items.length;
  const purchaseValue = itemsComputed.reduce((s, i) => s + i.purchasePrice, 0);
  const bookValue = itemsComputed.reduce((s, i) => s + i.bookValue, 0);
  const fullyDepreciated = itemsComputed.filter(i => i.depStatus === "Fully depreciated").length;
  const expensedThisYear = itemsComputed.reduce((s, i) =>
    s + (i.depStatus === "In progress" && i.usefulLife > 0 && i.purchasePrice > 0 ? i.purchasePrice / i.usefulLife : 0), 0);

  const byStatus = {}, byType = {}, byLocation = {}, byDepartment = {};
  for (const i of itemsComputed) {
    byStatus[i.status || "—"] = (byStatus[i.status || "—"] || 0) + 1;
    byType[i.type] = (byType[i.type] || 0) + 1;
    byLocation[i.location] = (byLocation[i.location] || 0) + 1;
    byDepartment[i.department] = (byDepartment[i.department] || 0) + 1;
  }

  const missingSerial = itemsComputed.filter(i => !i.serial).length;
  const missingTag = itemsComputed.filter(i => !i.tag).length;
  const missingPurchase = itemsComputed.filter(i => !i.purchaseDate).length;
  const unverified = itemsComputed.filter(i => {
    if (!i.lastVerified) return true;
    const d = new Date(i.lastVerified);
    return isNaN(d.getTime()) || (Date.now() - d.getTime()) > 90 * 86400000;
  }).length;

  return {
    totals: {
      total,
      purchaseValue: parseFloat(purchaseValue.toFixed(2)),
      bookValue: parseFloat(bookValue.toFixed(2)),
      fullyDepreciated,
      expensedThisYear: parseFloat(expensedThisYear.toFixed(2)),
      missingPurchase,
    },
    byStatus, byType, byLocation, byDepartment,
    dataHealth: { missingSerial, missingTag, missingPurchase, unverified },
    items: itemsComputed.slice(0, 500),
  };
}

// ---------- HTTP handler ----------
async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  // Forwarded user token: if the browser (after MSAL sign-in) sends a delegated
  // token, use it directly.  Otherwise fall back to the app-only shared key
  // (backward compat for embed/PIN-based callers).
  const userToken = (req.headers.authorization || "").startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : (req.headers["x-summary-key"] || null);

  const key = req.headers["x-summary-key"] || req.query.key || "";
  if (!userToken && ACCESS_KEY && key !== ACCESS_KEY) {
    res.status(401).json({ error: "Unauthorized — invalid or missing access key" });
    return;
  }

  try {
    const start = Date.now();
    const items = await fetchItems(userToken);
    const summary = computeSummary(items);
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - start,
      adminEmails: (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
      ...summary,
    });
  } catch (e) {
    console.error("summary error:", e);
    res.status(500).json({ error: e.message || "Internal error" });
  }
}

module.exports = handler;
module.exports.computeSummary = computeSummary;

