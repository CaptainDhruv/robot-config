/* =========================================================
   INVENTORY.JS — Robot Configurator
   ========================================================= */

import { getPrice, getLabel } from "../partConfig.js";

const COLOURS = {
  frame: "#797979",
  motor: "#f9b100",
  triangle_frame: "#ada7ab",
  support_frame: "#ff770e",
  wheel: "#36454f",
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

  Object.entries(state).forEach(([type, count]) => {
    if (count <= 0) return;

    const unitPrice = getPrice(type);
    const label = getLabel(type);
    const lineTotal = unitPrice * count;
    total += lineTotal;
    totalItems += count;

    const colour = COLOURS[type] ?? "#d05818";

    const row = document.createElement("div");
    row.dataset.partType = type;
    row.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 10px;
      background: #1e2c3e;
      border: 1px solid #2e4058;
      border-left: 3px solid ${colour};
      margin-bottom: 3px;
      clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 0 100%);
      transition: background 0.15s;
    `;

    row.innerHTML = `
      <span style="display:flex;align-items:center;gap:7px;flex-shrink:0;">
        <span style="
          font-family:'Oswald',sans-serif;
          font-size:11px;
          font-weight:400;
          background:#111820;
          border:1px solid #2a3848;
          padding:1px 6px;
          color:#8aacbf;
          letter-spacing:0.08em;
        ">${count}×</span>
        <span style="
          font-family:'Oswald',sans-serif;
          font-size:13px;
          font-weight:400;
          letter-spacing:0.05em;
          color:#e8f4ff;
        ">${label}</span>
      </span>
      <span style="display:flex;flex-direction:column;align-items:flex-end;gap:1px;flex-shrink:0;margin-left:8px;">
        <span style="
          font-family:'Oswald',sans-serif;
          font-size:14px;
          font-weight:600;
          letter-spacing:0.05em;
          color:#ffffff;
          display:block;
        ">₹${lineTotal.toLocaleString("en-IN")}</span>
        <span style="
          font-family:'Oswald',sans-serif;
          font-size:10px;
          font-weight:400;
          letter-spacing:0.06em;
          color:#8aacbf;
          display:block;
        ">₹${unitPrice.toLocaleString("en-IN")} EACH</span>
      </span>
    `;

    itemsEl.appendChild(row);
  });

  totalEl.textContent = total.toLocaleString("en-IN");

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

export function refreshInventory() {
  render();
}
