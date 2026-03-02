/* =========================================================
   INVENTORY.JS — Robot Configurator
   Tracks placed parts, renders basket rows with sub-totals,
   and exposes add / remove / init helpers.
   ========================================================= */

const PRICES = {
  frame: 1200,
  motor: 850,
  triangle_frame: 650,
  support_frame: 900,
  wheel: 750, // NEW — Wheel attaches to motor WHEEL_SOCKET
};

// Human-readable labels for each type key
const LABELS = {
  frame: "Rectangular Frame",
  motor: "Motor Housing",
  triangle_frame: "Triangular Frame",
  support_frame: "Support Frame",
  wheel: "Wheel",
};

// Accent colours matching the Military HUD button palette
const COLOURS = {
  frame: "#c84030",
  motor: "#4a8cd4",
  triangle_frame: "#d48030",
  support_frame: "#6ab040",
  wheel: "#00bcd4",
};

const state = {
  frame: 0,
  motor: 0,
  triangle_frame: 0,
  support_frame: 0,
  wheel: 0,
};

const itemsEl = document.getElementById("basketItems");
const totalEl = document.getElementById("totalPrice");
const countEl = document.getElementById("basketCount");

function render() {
  if (!itemsEl || !totalEl) return;

  itemsEl.innerHTML = "";
  let total = 0;
  let totalItems = 0;

  // ── Group rows by category, show sub-total per line ───────────────────
  Object.entries(state).forEach(([type, count]) => {
    if (count <= 0) return;

    const unitPrice = PRICES[type] ?? 0;
    const lineTotal = unitPrice * count;
    total += lineTotal;
    totalItems += count;

    const label = LABELS[type] ?? type;
    const colour = COLOURS[type] ?? "#d4922a";

    const row = document.createElement("div");
    row.className = "basket-row";
    row.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 9px 12px;
      background: #141a10;
      border: 1px solid #2a3820;
      border-left: 4px solid ${colour};
      margin-bottom: 4px;
      font-family: 'Oswald', sans-serif;
      font-size: 14px;
      font-weight: 500;
      letter-spacing: 0.04em;
      clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 0 100%);
    `;

    row.innerHTML = `
      <span style="display:flex;align-items:center;gap:8px;">
        <span style="
          font-family:'Courier Prime',monospace;
          font-size:11px;
          background:#0f1410;
          border:1px solid #4a6030;
          padding:1px 7px;
          color:${colour};
          letter-spacing:0.1em;
        ">${count}×</span>
        <span style="color:#d8e4b8;">${label}</span>
      </span>
      <span style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;">
        <span style="
          font-family:'Black Ops One',cursive;
          font-size:15px;
          color:#f0b040;
          text-shadow:0 0 8px rgba(212,146,42,0.4);
          letter-spacing:0.04em;
        ">₹${lineTotal.toLocaleString("en-IN")}</span>
        <span style="
          font-family:'Courier Prime',monospace;
          font-size:9px;
          color:#4a5c38;
          letter-spacing:0.08em;
        ">₹${unitPrice.toLocaleString("en-IN")} EACH</span>
      </span>
    `;

    itemsEl.appendChild(row);
  });

  // ── Sub-total divider ─────────────────────────────────────────────────
  if (totalItems > 0) {
    const divider = document.createElement("div");
    divider.style.cssText = `
      height: 1px;
      background: #8a6820;
      margin: 6px 0 4px;
      position: relative;
    `;
    const label = document.createElement("span");
    label.textContent = "SUBTOTAL";
    label.style.cssText = `
      position: absolute;
      right: 0; top: -9px;
      font-family: 'Courier Prime', monospace;
      font-size: 9px;
      color: #c8a040;
      letter-spacing: 0.15em;
      background: #0a0f14;
      padding: 0 4px;
    `;
    divider.appendChild(label);
    itemsEl.appendChild(divider);

    // Parts count summary row
    const summary = document.createElement("div");
    summary.style.cssText = `
      display: flex;
      justify-content: space-between;
      padding: 4px 12px 2px;
      font-family: 'Courier Prime', monospace;
      font-size: 10px;
      color: #4a5c38;
      letter-spacing: 0.1em;
    `;
    summary.innerHTML = `
      <span>${totalItems} PART${totalItems !== 1 ? "S" : ""} TOTAL</span>
      <span>${Object.values(state).filter((v) => v > 0).length} TYPES</span>
    `;
    itemsEl.appendChild(summary);
  }

  // ── Update total price display ────────────────────────────────────────
  totalEl.textContent = total.toLocaleString("en-IN");

  // ── Update basket count badge ─────────────────────────────────────────
  if (countEl) {
    countEl.textContent = totalItems + (totalItems === 1 ? " ITEM" : " ITEMS");
  }
}

export function addToInventory(type) {
  if (!(type in state)) {
    console.warn(`addToInventory: unknown type "${type}"`);
    return;
  }
  state[type]++;
  render();
}

export function removeFromInventory(type) {
  if (!(type in state)) {
    console.warn(`removeFromInventory: unknown type "${type}"`);
    return;
  }
  if (state[type] <= 0) return;
  state[type]--;
  render();
}

export function initInventory(initial = {}) {
  Object.entries(initial).forEach(([k, v]) => {
    if (k in state) state[k] = v;
  });
  render();
}
