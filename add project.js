const crypto = require("crypto");
const express = require("express");

const { onRequest } = require("firebase-functions/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();

const db = getFirestore();
const app = express();

app.use(express.json());

/* =========================================================
   SETTINGS
========================================================= */

const DEFAULT_BUDGET = 2000;

const USERS = [
  "vicky",
  "raajan",
  "obito",
  "alpha"
];

const PASSWORD = "4Friends";

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "new-bro-69728-home-budget-secret-change-this";

const DEFAULT_ITEMS = [
  "Vegetables",
  "Chicken",
  "Water",
  "Electric bill",
  "Home things"
];

/* =========================================================
   FIRESTORE REFERENCES
========================================================= */

function userRef(username) {
  return db.collection("users").doc(username);
}

function itemsRef(username) {
  return userRef(username).collection("items");
}

function budgetsRef(username) {
  return userRef(username).collection("budgets");
}

function spendsRef(username) {
  return userRef(username).collection("spends");
}

/* =========================================================
   HELPERS
========================================================= */

function makeId() {
  return crypto.randomBytes(16).toString("hex");
}

function validMonth(value) {
  const month = String(value || "");

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return null;
  }

  const parts = month.split("-").map(Number);

  if (parts[1] < 1 || parts[1] > 12) {
    return null;
  }

  return month;
}

function validDate(value) {
  const date = String(value || "");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }

  const parsed = new Date(date + "T00:00:00");

  return !Number.isNaN(parsed.getTime());
}

function nextMonth(month) {
  const parts = month.split("-").map(Number);

  const date = new Date(
    parts[0],
    parts[1] - 1,
    1
  );

  date.setMonth(date.getMonth() + 1);

  return (
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0")
  );
}

function monthLabel(month) {
  const parts = month.split("-").map(Number);

  return new Date(
    parts[0],
    parts[1] - 1,
    1
  ).toLocaleString("en-IN", {
    month: "long",
    year: "numeric"
  });
}

/* =========================================================
   LOGIN COOKIE
========================================================= */

function sign(value) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("hex");
}

function createLoginCookie(username) {
  const data = {
    username,
    expires: Date.now() + 1000 * 60 * 60 * 24 * 30
  };

  const payload = Buffer
    .from(JSON.stringify(data))
    .toString("base64url");

  const signature = sign(payload);

  return payload + "." + signature;
}

function getCookie(req) {
  const cookieHeader = req.headers.cookie || "";

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const index = cookie.indexOf("=");

    if (index === -1) {
      continue;
    }

    const name = cookie
      .slice(0, index)
      .trim();

    const value = cookie
      .slice(index + 1)
      .trim();

    if (name === "budget_auth") {
      return decodeURIComponent(value);
    }
  }

  return null;
}

function getLoggedInUser(req) {
  const cookie = getCookie(req);

  if (!cookie) {
    return null;
  }

  const parts = cookie.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const payload = parts[0];
  const signature = parts[1];

  const expected = sign(payload);

  if (signature.length !== expected.length) {
    return null;
  }

  try {
    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer
        .from(payload, "base64url")
        .toString("utf8")
    );

    if (!data.username) {
      return null;
    }

    if (!USERS.includes(data.username)) {
      return null;
    }

    if (Date.now() > Number(data.expires)) {
      return null;
    }

    return data.username;
  } catch {
    return null;
  }
}

function requireLogin(req, res, next) {
  const username = getLoggedInUser(req);

  if (!username) {
    return res.status(401).json({
      error: "Please log in."
    });
  }

  req.username = username;

  next();
}

/* =========================================================
   USER SETUP
========================================================= */

async function setupUser(username) {
  const ref = userRef(username);

  const user = await ref.get();

  if (!user.exists) {
    await ref.set({
      username,
      createdAt: FieldValue.serverTimestamp()
    });
  }

  const items = await itemsRef(username)
    .limit(1)
    .get();

  if (!items.empty) {
    return;
  }

  const batch = db.batch();

  for (const name of DEFAULT_ITEMS) {
    const ref = itemsRef(username).doc(makeId());

    batch.set(ref, {
      name,
      isDefault: true,
      createdAt: FieldValue.serverTimestamp()
    });
  }

  await batch.commit();
}

/* =========================================================
   BUDGET
========================================================= */

async function getBudget(username, month) {
  const snapshot = await budgetsRef(username)
    .doc(month)
    .get();

  if (!snapshot.exists) {
    return {
      amount: DEFAULT_BUDGET,
      saved: false
    };
  }

  return {
    amount: Number(snapshot.data().amount || 0),
    saved: true
  };
}

/* =========================================================
   SPENDING TOTAL
========================================================= */

async function getSpent(username, month) {
  const snapshot = await spendsRef(username)
    .where("month", "==", month)
    .get();

  let total = 0;

  snapshot.forEach((doc) => {
    total += Number(doc.data().amount || 0);
  });

  return total;
}

/* =========================================================
   SUMMARY
========================================================= */

async function getSummary(username, month) {
  const budget = await getBudget(username, month);
  const spent = await getSpent(username, month);

  return {
    month,
    label: monthLabel(month),
    budget: budget.amount,
    spent,
    leftover: budget.amount - spent,
    budgetSaved: budget.saved
  };
}

/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", async (req, res) => {
  try {
    const username = String(
      req.body.username || ""
    )
      .trim()
      .toLowerCase();

    const password = String(
      req.body.password || ""
    );

    if (!USERS.includes(username)) {
      return res.status(400).json({
        error: "Wrong username or password."
      });
    }

    if (password !== PASSWORD) {
      return res.status(400).json({
        error: "Wrong username or password."
      });
    }

    await setupUser(username);

    const cookie = createLoginCookie(username);

    const secure =
      req.headers["x-forwarded-proto"] === "https";

    let cookieValue =
      "budget_auth=" +
      encodeURIComponent(cookie) +
      "; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax";

    if (secure) {
      cookieValue += "; Secure";
    }

    res.setHeader(
      "Set-Cookie",
      cookieValue
    );

    res.json({
      username
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Login failed."
    });
  }
});

/* =========================================================
   LOGOUT
========================================================= */

app.post("/api/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    "budget_auth=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"
  );

  res.json({
    ok: true
  });
});

/* =========================================================
   CURRENT USER
========================================================= */

app.get("/api/me", (req, res) => {
  const username = getLoggedInUser(req);

  if (!username) {
    return res.status(401).json({
      error: "Not logged in."
    });
  }

  res.json({
    username
  });
});

/* =========================================================
   GET MONTH
========================================================= */

app.get("/api/month", requireLogin, async (req, res) => {
  try {
    const month = validMonth(req.query.month);

    if (!month) {
      return res.status(400).json({
        error: "Choose a valid month."
      });
    }

    const username = req.username;
    const next = nextMonth(month);

    const current = await getSummary(
      username,
      month
    );

    const nextSummary = await getSummary(
      username,
      next
    );

    const itemSnapshot = await itemsRef(username)
      .get();

    const items = [];

    itemSnapshot.forEach((doc) => {
      const data = doc.data();

      items.push({
        id: doc.id,
        name: data.name,
        is_default: data.isDefault ? 1 : 0,
        spent: 0,
        nextSpent: 0,
        spends: []
      });
    });

    const itemMap = new Map();

    items.forEach((item) => {
      itemMap.set(item.id, item);
    });

    const currentSpends =
      await spendsRef(username)
        .where("month", "==", month)
        .get();

    currentSpends.forEach((doc) => {
      const data = doc.data();

      const item = itemMap.get(
        data.itemId
      );

      if (!item) {
        return;
      }

      const amount =
        Number(data.amount || 0);

      item.spent += amount;

      item.spends.push({
        id: doc.id,
        amount,
        note: data.note || "",
        spentOn: data.spentOn || ""
      });
    });

    const nextSpends =
      await spendsRef(username)
        .where("month", "==", next)
        .get();

    nextSpends.forEach((doc) => {
      const data = doc.data();

      const item = itemMap.get(
        data.itemId
      );

      if (!item) {
        return;
      }

      item.nextSpent +=
        Number(data.amount || 0);
    });

    items.sort((a, b) => {
      if (a.is_default !== b.is_default) {
        return b.is_default - a.is_default;
      }

      return a.name.localeCompare(
        b.name
      );
    });

    items.forEach((item) => {
      item.spends.sort((a, b) => {
        return b.spentOn.localeCompare(
          a.spentOn
        );
      });
    });

    res.json({
      ...current,
      next: nextSummary,
      items
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not load month."
    });
  }
});

/* =========================================================
   SAVE BUDGET
========================================================= */

app.put("/api/budget", requireLogin, async (req, res) => {
  try {
    const month = validMonth(
      req.body.month
    );

    const amount = Number(
      req.body.amount
    );

    if (!month) {
      return res.status(400).json({
        error: "Choose a valid month."
      });
    }

    if (
      !Number.isFinite(amount) ||
      amount < 0
    ) {
      return res.status(400).json({
        error: "Enter a valid budget."
      });
    }

    await budgetsRef(req.username)
      .doc(month)
      .set({
        amount,
        updatedAt:
          FieldValue.serverTimestamp()
      });

    res.json({
      month,
      amount
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not save budget."
    });
  }
});

/* =========================================================
   ADD ITEM
========================================================= */

app.post("/api/items", requireLogin, async (req, res) => {
  try {
    const name = String(
      req.body.name || ""
    ).trim();

    if (!name) {
      return res.status(400).json({
        error: "Enter an item name."
      });
    }

    const snapshot =
      await itemsRef(req.username)
        .get();

    const duplicate =
      snapshot.docs.some((doc) => {
        return (
          String(doc.data().name)
            .toLowerCase() ===
          name.toLowerCase()
        );
      });

    if (duplicate) {
      return res.status(400).json({
        error: "That item already exists."
      });
    }

    const id = makeId();

    await itemsRef(req.username)
      .doc(id)
      .set({
        name,
        isDefault: false,
        createdAt:
          FieldValue.serverTimestamp()
      });

    res.json({
      id,
      name,
      is_default: 0
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not add item."
    });
  }
});

/* =========================================================
   EDIT ITEM
========================================================= */

app.patch(
  "/api/items/:id",
  requireLogin,
  async (req, res) => {
    try {
      const id = req.params.id;

      const name = String(
        req.body.name || ""
      ).trim();

      if (!name) {
        return res.status(400).json({
          error: "Enter a name."
        });
      }

      const ref =
        itemsRef(req.username)
          .doc(id);

      const item = await ref.get();

      if (!item.exists) {
        return res.status(404).json({
          error: "Item not found."
        });
      }

      const all =
        await itemsRef(req.username)
          .get();

      const duplicate =
        all.docs.some((doc) => {
          if (doc.id === id) {
            return false;
          }

          return (
            String(doc.data().name)
              .toLowerCase() ===
            name.toLowerCase()
          );
        });

      if (duplicate) {
        return res.status(400).json({
          error: "That item already exists."
        });
      }

      await ref.update({
        name,
        updatedAt:
          FieldValue.serverTimestamp()
      });

      res.json({
        id,
        name
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not edit item."
      });
    }
  }
);

/* =========================================================
   DELETE ITEM
========================================================= */

app.delete(
  "/api/items/:id",
  requireLogin,
  async (req, res) => {
    try {
      const id = req.params.id;

      const ref =
        itemsRef(req.username)
          .doc(id);

      const item = await ref.get();

      if (!item.exists) {
        return res.status(404).json({
          error: "Item not found."
        });
      }

      const spends =
        await spendsRef(req.username)
          .where("itemId", "==", id)
          .get();

      const batch = db.batch();

      spends.forEach((doc) => {
        batch.delete(doc.ref);
      });

      batch.delete(ref);

      await batch.commit();

      res.json({
        ok: true
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not delete item."
      });
    }
  }
);

/* =========================================================
   ADD SPENDING
========================================================= */

app.post(
  "/api/spends",
  requireLogin,
  async (req, res) => {
    try {
      const month = validMonth(
        req.body.month
      );

      const itemId = String(
        req.body.itemId || ""
      );

      const amount = Number(
        req.body.amount
      );

      const note = String(
        req.body.note || ""
      ).trim();

      const spentOn = String(
        req.body.spentOn || ""
      ).slice(0, 10);

      if (!month) {
        return res.status(400).json({
          error: "Choose a valid month."
        });
      }

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          error: "Enter an amount greater than 0."
        });
      }

      if (!validDate(spentOn)) {
        return res.status(400).json({
          error: "Choose a valid date."
        });
      }

      const item =
        await itemsRef(req.username)
          .doc(itemId)
          .get();

      if (!item.exists) {
        return res.status(404).json({
          error: "Item not found."
        });
      }

      const id = makeId();

      await spendsRef(req.username)
        .doc(id)
        .set({
          itemId,
          month,
          amount,
          note,
          spentOn,
          createdAt:
            FieldValue.serverTimestamp()
        });

      res.json({
        id,
        itemId,
        amount,
        note,
        spentOn
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not save spending."
      });
    }
  }
);

/* =========================================================
   DELETE SPENDING
========================================================= */

app.delete(
  "/api/spends/:id",
  requireLogin,
  async (req, res) => {
    try {
      const id = req.params.id;

      const ref =
        spendsRef(req.username)
          .doc(id);

      const spend = await ref.get();

      if (!spend.exists) {
        return res.status(404).json({
          error: "Spending record not found."
        });
      }

      await ref.delete();

      res.json({
        ok: true
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not delete spending."
      });
    }
  }
);

/* =========================================================
   WEBSITE
========================================================= */

const HTML = `<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width,initial-scale=1.0">

<title>Home Monthly Budget</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #f3f6fb;
  color: #172033;
}

button,
input {
  font-family: inherit;
}

button {
  cursor: pointer;
}

.hidden {
  display: none !important;
}

.login-page {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 20px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  background: white;
  padding: 30px;
  border-radius: 20px;
  box-shadow: 0 10px 40px rgba(0,0,0,.1);
}

.logo {
  text-align: center;
  font-size: 50px;
}

.login-card h1 {
  text-align: center;
}

.login-card p {
  text-align: center;
  color: #777;
}

.form-group {
  margin-bottom: 15px;
}

label {
  display: block;
  font-weight: bold;
  margin-bottom: 7px;
}

input {
  width: 100%;
  padding: 13px;
  border: 1px solid #d8dee8;
  border-radius: 10px;
  outline: none;
}

.primary {
  width: 100%;
  border: 0;
  padding: 14px;
  border-radius: 10px;
  background: #5865f2;
  color: white;
  font-weight: bold;
  font-size: 16px;
}

.error {
  color: #d32f2f;
  text-align: center;
  margin-top: 12px;
}

.topbar {
  background: white;
  border-bottom: 1px solid #e5e9ef;
  padding: 14px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: sticky;
  top: 0;
  z-index: 10;
}

.brand {
  font-size: 19px;
  font-weight: bold;
}

.user-area {
  display: flex;
  align-items: center;
  gap: 10px;
}

.user-name {
  color: #5865f2;
  font-weight: bold;
}

.logout {
  border: 0;
  padding: 9px 13px;
  border-radius: 9px;
}

.container {
  max-width: 1100px;
  margin: auto;
  padding: 25px 18px 50px;
}

.month-bar {
  display: flex;
  gap: 15px;
  align-items: center;
  margin-bottom: 20px;
}

.month-title {
  font-size: 25px;
  font-weight: bold;
  flex: 1;
}

.month-picker {
  width: 180px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(3,1fr);
  gap: 15px;
  margin-bottom: 20px;
}

.card {
  background: white;
  padding: 20px;
  border-radius: 18px;
  box-shadow: 0 7px 25px rgba(0,0,0,.06);
}

.stat-label {
  color: #697586;
  margin-bottom: 8px;
}

.stat-value {
  font-size: 26px;
  font-weight: bold;
}

.good {
  color: #16833b;
}

.bad {
  color: #d32f2f;
}

.section-title {
  font-size: 20px;
  font-weight: bold;
  margin-bottom: 15px;
}

.budget-row,
.add-row {
  display: flex;
  gap: 10px;
}

.budget-input {
  max-width: 250px;
}

.small-button {
  border: 0;
  background: #5865f2;
  color: white;
  padding: 13px 17px;
  border-radius: 10px;
  font-weight: bold;
}

.items {
  display: grid;
  grid-template-columns: repeat(2,1fr);
  gap: 15px;
}

.item-card {
  background: white;
  padding: 18px;
  border-radius: 18px;
  box-shadow: 0 7px 25px rgba(0,0,0,.06);
}

.item-header {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.item-name {
  font-size: 18px;
  font-weight: bold;
}

.item-spent {
  color: #697586;
  margin-top: 5px;
}

.item-actions {
  display: flex;
  gap: 5px;
}

.icon-button {
  border: 0;
  background: #f0f2f6;
  padding: 7px 9px;
  border-radius: 8px;
}

.progress {
  width: 100%;
  height: 8px;
  background: #edf0f4;
  border-radius: 20px;
  margin: 15px 0;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: #5865f2;
}

.add-spend {
  width: 100%;
  border: 0;
  background: #5865f2;
  color: white;
  padding: 11px;
  border-radius: 10px;
  font-weight: bold;
}

.spend-row {
  border-top: 1px solid #edf0f4;
  margin-top: 10px;
  padding-top: 10px;
  display: flex;
  justify-content: space-between;
}

.spend-note {
  color: #697586;
  font-size: 13px;
}

.delete-spend {
  border: 0;
  background: transparent;
  color: #d32f2f;
}

.add-card {
  margin-top: 20px;
}

.next-card {
  margin-top: 25px;
}

.next-grid {
  display: grid;
  grid-template-columns: repeat(2,1fr);
  gap: 10px;
}

.next-item {
  background: #f5f7fa;
  padding: 13px;
  border-radius: 10px;
}

.toast {
  position: fixed;
  bottom: 25px;
  left: 50%;
  transform: translateX(-50%);
  background: #172033;
  color: white;
  padding: 12px 18px;
  border-radius: 10px;
  display: none;
}

@media(max-width:700px) {

  .stats {
    grid-template-columns: 1fr;
  }

  .items {
    grid-template-columns: 1fr;
  }

  .next-grid {
    grid-template-columns: 1fr;
  }

  .month-bar {
    flex-direction: column;
    align-items: stretch;
  }

  .month-picker {
    width: 100%;
  }

  .budget-row,
  .add-row {
    flex-direction: column;
  }

  .budget-input {
    max-width: none;
  }

  .small-button {
    width: 100%;
  }

  .user-name {
    display: none;
  }

}

</style>

</head>

<body>

<div id="loginPage" class="login-page">

  <div class="login-card">

    <div class="logo">💰</div>

    <h1>Home Budget</h1>

    <p>Monthly Family Budget</p>

    <form id="loginForm">

      <div class="form-group">

        <label>Username</label>

        <input
          id="username"
          required
          autocomplete="username"
          placeholder="Username"
        >

      </div>

      <div class="form-group">

        <label>Password</label>

        <input
          id="password"
          type="password"
          required
          autocomplete="current-password"
          placeholder="Password"
        >

      </div>

      <button
        class="primary"
        type="submit"
      >
        Login
      </button>

      <div id="loginError"
           class="error"></div>

    </form>

  </div>

</div>

<div id="application"
     class="hidden">

  <div class="topbar">

    <div class="brand">
      💰 Home Budget
    </div>

    <div class="user-area">

      <span id="userName"
            class="user-name"></span>

      <button id="logoutButton"
              class="logout">
        Logout
      </button>

    </div>

  </div>

  <main class="container">

    <div class="month-bar">

      <div id="monthTitle"
           class="month-title">
        Monthly Budget
      </div>

      <input
        id="monthPicker"
        class="month-picker"
        type="month"
      >

    </div>

    <div class="stats">

      <div class="card">

        <div class="stat-label">
          Monthly Budget
        </div>

        <div id="budgetValue"
             class="stat-value">
          ₹0
        </div>

      </div>

      <div class="card">

        <div class="stat-label">
          Total Spent
        </div>

        <div id="spentValue"
             class="stat-value">
          ₹0
        </div>

      </div>

      <div class="card">

        <div class="stat-label">
          Remaining
        </div>

        <div id="remainingValue"
             class="stat-value good">
          ₹0
        </div>

      </div>

    </div>

    <div class="card">

      <div class="section-title">
        Set Monthly Budget
      </div>

      <div class="budget-row">

        <input
          id="budgetInput"
          class="budget-input"
          type="number"
          min="0"
          placeholder="Budget"
        >

        <button id="saveBudget"
                class="small-button">
          Save Budget
        </button>

      </div>

    </div>

    <div class="section-title"
         style="margin-top:25px">
      Spending Items
    </div>

    <div id="items"
         class="items"></div>

    <div class="card add-card">

      <div class="section-title">
        Add New Item
      </div>

      <div class="add-row">

        <input
          id="newItem"
          placeholder="Example: Internet"
        >

        <button id="addItem"
                class="small-button">
          Add Item
        </button>

      </div>

    </div>

    <div class="card next-card">

      <div class="section-title">
        Next Month Preview
      </div>

      <p id="nextLabel"></p>

      <div id="nextItems"
           class="next-grid"></div>

    </div>

  </main>

</div>

<div id="toast"
     class="toast"></div>

<script>

let currentMonth = "";

function $(id) {
  return document.getElementById(id);
}

function todayMonth() {

  const date = new Date();

  return (
    date.getFullYear() +
    "-" +
    String(
      date.getMonth() + 1
    ).padStart(2, "0")
  );

}

function todayDate() {

  const date = new Date();

  return (
    date.getFullYear() +
    "-" +
    String(
      date.getMonth() + 1
    ).padStart(2, "0") +
    "-" +
    String(
      date.getDate()
    ).padStart(2, "0")
  );

}

function money(value) {

  return new Intl.NumberFormat(
    "en-IN",
    {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0
    }
  ).format(
    Number(value || 0)
  );

}

function escapeHtml(value) {

  return String(value)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");

}

function showToast(message) {

  const element = $("toast");

  element.textContent = message;

  element.style.display = "block";

  setTimeout(() => {
    element.style.display = "none";
  }, 2200);

}

async function api(url, options = {}) {

  const headers =
    options.headers || {};

  headers["Content-Type"] =
    "application/json";

  options.headers = headers;

  const response =
    await fetch(url, options);

  let data = {};

  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(
      data.error ||
      "Something went wrong."
    );
  }

  return data;

}

/* LOGIN */

$("loginForm")
  .addEventListener(
    "submit",
    async (event) => {

      event.preventDefault();

      $("loginError")
        .textContent = "";

      try {

        const data =
          await api(
            "/api/login",
            {
              method: "POST",
              body: JSON.stringify({
                username:
                  $("username").value,
                password:
                  $("password").value
              })
            }
          );

        $("userName")
          .textContent =
          data.username;

        $("loginPage")
          .classList
          .add("hidden");

        $("application")
          .classList
          .remove("hidden");

        currentMonth =
          todayMonth();

        $("monthPicker")
          .value =
          currentMonth;

        await loadMonth();

      } catch (error) {

        $("loginError")
          .textContent =
          error.message;

      }

    }
  );

/* CHECK LOGIN */

async function checkLogin() {

  try {

    const data =
      await api("/api/me");

    $("userName")
      .textContent =
      data.username;

    $("loginPage")
      .classList
      .add("hidden");

    $("application")
      .classList
      .remove("hidden");

    currentMonth =
      todayMonth();

    $("monthPicker")
      .value =
      currentMonth;

    await loadMonth();

  } catch {

    $("loginPage")
      .classList
      .remove("hidden");

    $("application")
      .classList
      .add("hidden");

  }

}

/* LOGOUT */

$("logoutButton")
  .addEventListener(
    "click",
    async () => {

      try {

        await api(
          "/api/logout",
          {
            method: "POST"
          }
        );

      } catch {}

      $("application")
        .classList
        .add("hidden");

      $("loginPage")
        .classList
        .remove("hidden");

    }
  );

/* MONTH */

$("monthPicker")
  .addEventListener(
    "change",
    async () => {

      if (
        !$("monthPicker").value
      ) {
        return;
      }

      currentMonth =
        $("monthPicker").value;

      await loadMonth();

    }
  );

/* LOAD */

async function loadMonth() {

  try {

    const data =
      await api(
        "/api/month?month=" +
        encodeURIComponent(
          currentMonth
        )
      );

    render(data);

  } catch (error) {

    showToast(
      error.message
    );

  }

}

/* RENDER */

function render(data) {

  $("monthTitle")
    .textContent =
    data.label;

  $("budgetValue")
    .textContent =
    money(data.budget);

  $("spentValue")
    .textContent =
    money(data.spent);

  $("remainingValue")
    .textContent =
    money(data.leftover);

  $("remainingValue")
    .className =
    data.leftover < 0
      ? "stat-value bad"
      : "stat-value good";

  $("budgetInput")
    .value =
    data.budget;

  renderItems(
    data.items,
    data.budget
  );

  $("nextLabel")
    .textContent =
    data.next.label +
    " | Budget: " +
    money(data.next.budget);

  $("nextItems")
    .innerHTML = "";

  data.items.forEach(
    (item) => {

      const box =
        document.createElement(
          "div"
        );

      box.className =
        "next-item";

      box.innerHTML =
        "<strong>" +
        escapeHtml(item.name) +
        "</strong><br>" +
        "Next month spending: " +
        money(item.nextSpent);

      $("nextItems")
        .appendChild(box);

    }
  );

}

/* ITEMS */

function renderItems(
  items,
  budget
) {

  $("items")
    .innerHTML = "";

  items.forEach(
    (item) => {

      const card =
        document.createElement(
          "div"
        );

      card.className =
        "item-card";

      let percentage = 0;

      if (budget > 0) {

        percentage =
          Math.min(
            100,
            (item.spent / budget) *
            100
          );

      }

      card.innerHTML =
        "<div class='item-header'>" +

          "<div>" +

            "<div class='item-name'>" +
              escapeHtml(
                item.name
              ) +
            "</div>" +

            "<div class='item-spent'>" +
              "Spent: " +
              money(item.spent) +
            "</div>" +

          "</div>" +

          "<div class='item-actions'>" +

            "<button class='icon-button edit'>" +
              "✏️" +
            "</button>" +

            "<button class='icon-button delete'>" +
              "🗑️" +
            "</button>" +

          "</div>" +

        "</div>" +

        "<div class='progress'>" +

          "<div class='progress-bar' " +
          "style='width:" +
          percentage +
          "%'></div>" +

        "</div>" +

        "<button class='add-spend'>" +
          "+ Add Spending" +
        "</button>" +

        "<div class='spends'></div>";

      card
        .querySelector(".edit")
        .addEventListener(
          "click",
          () => editItem(item)
        );

      card
        .querySelector(".delete")
        .addEventListener(
          "click",
          () => deleteItem(item)
        );

      card
        .querySelector(".add-spend")
        .addEventListener(
          "click",
          () => addSpend(item)
        );

      const spends =
        card.querySelector(".spends");

      item.spends.forEach(
        (spend) => {

          const row =
            document.createElement(
              "div"
            );

          row.className =
            "spend-row";

          row.innerHTML =
            "<div>" +

              "<strong>" +
                money(spend.amount) +
              "</strong>" +

              "<br>" +

              "<span class='spend-note'>" +
                escapeHtml(
                  spend.note ||
                  "No note"
                ) +
                " • " +
                escapeHtml(
                  spend.spentOn
                ) +
              "</span>" +

            "</div>" +

            "<button class='delete-spend'>" +
              "Delete" +
            "</button>";

          row
            .querySelector(
              ".delete-spend"
            )
            .addEventListener(
              "click",
              () => deleteSpend(
                spend.id
              )
            );

          spends.appendChild(row);

        }
      );

      $("items")
        .appendChild(card);

    }
  );

}

/* BUDGET */

$("saveBudget")
  .addEventListener(
    "click",
    async () => {

      const amount =
        Number(
          $("budgetInput").value
        );

      if (
        !Number.isFinite(amount) ||
        amount < 0
      ) {

        showToast(
          "Enter a valid budget."
        );

        return;

      }

      try {

        await api(
          "/api/budget",
          {
            method: "PUT",
            body: JSON.stringify({
              month:
                currentMonth,
              amount
            })
          }
        );

        showToast(
          "Budget saved."
        );

        await loadMonth();

      } catch (error) {

        showToast(
          error.message
        );

      }

    }
  );

/* ADD ITEM */

$("addItem")
  .addEventListener(
    "click",
    async () => {

      const input =
        $("newItem");

      const name =
        input.value.trim();

      if (!name) {

        showToast(
          "Enter an item name."
        );

        return;

      }

      try {

        await api(
          "/api/items",
          {
            method: "POST",
            body: JSON.stringify({
              name
            })
          }
        );

        input.value = "";

        showToast(
          "Item added."
        );

        await loadMonth();

      } catch (error) {

        showToast(
          error.message
        );

      }

    }
  );

/* EDIT ITEM */

async function editItem(item) {

  let name =
    prompt(
      "Enter new item name:",
      item.name
    );

  if (name === null) {
    return;
  }

  name = name.trim();

  if (!name) {
    return;
  }

  try {

    await api(
      "/api/items/" +
      item.id,
      {
        method: "PATCH",
        body: JSON.stringify({
          name
        })
      }
    );

    showToast(
      "Item updated."
    );

    await loadMonth();

  } catch (error) {

    showToast(
      error.message
    );

  }

}

/* DELETE ITEM */

async function deleteItem(item) {

  if (
    !confirm(
      "Delete " +
      item.name +
      " and all its spending?"
    )
  ) {
    return;
  }

  try {

    await api(
      "/api/items/" +
      item.id,
      {
        method: "DELETE"
      }
    );

    showToast(
      "Item deleted."
    );

    await loadMonth();

  } catch (error) {

    showToast(
      error.message
    );

  }

}

/* ADD SPENDING */

async function addSpend(item) {

  const amountText =
    prompt(
      "Enter spending amount:"
    );

  if (amountText === null) {
    return;
  }

  const amount =
    Number(amountText);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {

    showToast(
      "Enter a valid amount."
    );

    return;

  }

  let note =
    prompt(
      "Enter note:"
    );

  if (note === null) {
    note = "";
  }

  const date =
    prompt(
      "Enter date YYYY-MM-DD:",
      todayDate()
    );

  if (date === null) {
    return;
  }

  try {

    await api(
      "/api/spends",
      {
        method: "POST",
        body: JSON.stringify({
          month:
            currentMonth,
          itemId:
            item.id,
          amount,
          note,
          spentOn:
            date
        })
      }
    );

    showToast(
      "Spending added."
    );

    await loadMonth();

  } catch (error) {

    showToast(
      error.message
    );

  }

}

/* DELETE SPENDING */

async function deleteSpend(id) {

  if (
    !confirm(
      "Delete this spending record?"
    )
  ) {
    return;
  }

  try {

    await api(
      "/api/spends/" +
      id,
      {
        method: "DELETE"
      }
    );

    showToast(
      "Spending deleted."
    );

    await loadMonth();

  } catch (error) {

    showToast(
      error.message
    );

  }

}

checkLogin();

</script>

</body>

</html>`;

/* =========================================================
   WEBSITE ROUTE
========================================================= */

app.get("/", (req, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.type("html").send(HTML);
});

/* =========================================================
   FIREBASE FUNCTION
========================================================= */

module.exports = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 10
  },
  app
);

