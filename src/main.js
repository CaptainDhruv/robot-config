import * as THREE from "three";
import { scene } from "./core/scene.js";
import "./style.css";
import { camera } from "./core/camera.js";
import { createRenderer } from "./core/renderer.js";
import { createControls } from "./core/controls.js";
import { loadGLB } from "./engine/loader.js";
import {
  addToInventory,
  removeFromInventory,
  initInventory,
} from "./ui/inventory.js";
/* =========================================================
   GLOBAL STATE
   ========================================================= */

let renderer, controls;

let frameTemplate = null;
let motorTemplate = null;
let triangleTemplate = null;
let supportTemplate = null;
let wheelTemplate = null;

let ghost = null;
let motorRotationGroup = null;
let placementMode = null;

let selectedMount = null;

// ── Single-mesh highlight tracking ──────────────────────────────────────────
let hoveredMesh = null;
let hoveredOrigEm = new THREE.Color(0, 0, 0);

let selectedMesh = null;
let selectedOrigEm = new THREE.Color(0, 0, 0);
// ────────────────────────────────────────────────────────────────────────────

const usedSockets = new Set();

let isFinalized = false;

// ── Motor auto-orientation state ─────────────────────────────────────────────
let motorAutoBaseYaw = 0;
let motorManualRotSteps = 0;

// ── Triangle auto-orientation state (mirrors motor logic) ────────────────────
let triangleAutoBaseYaw = 0;
let triangleManualRotSteps = 0;
let hoveredTriangleMarker = null;

// ── Support auto-orientation state (1-click placement) ───────────────────────
let supportManualRotSteps = 0;
// ─────────────────────────────────────────────────────────────────────────────

// ── Frame-on-support rotation (used inside unified frame mode) ───────────────
let frameOnSupportRotationSteps = 0;
// ─────────────────────────────────────────────────────────────────────────────

// ── Tracks which socket type the ghost is currently hovering ─────────────────
// "frame" = regular SOCKET_FRAME, "support" = SOCKET_FRAME_SUPPORT
let frameHoverType = "frame";
// ─────────────────────────────────────────────────────────────────────────────

// ── Undo history ─────────────────────────────────────────────────────────────
const undoStack = [];
const MAX_UNDO = 50;

function pushUndo(mount, socketUuids, type) {
  undoStack.push({ mount, socketUuids: [...socketUuids], type });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}
// ─────────────────────────────────────────────────────────────────────────────

/* =========================================================
   QUEUED INTENT — Smart prerequisite chaining
   ========================================================= */

let queuedIntent = null;

function setQueuedIntent(intent) {
  queuedIntent = intent;
  updateShortcutBar();
  if (intent) showChainToast();
}

function clearQueuedIntent() {
  queuedIntent = null;
  const el = document.getElementById("chain-toast");
  if (el) el.remove();
  updateShortcutBar();
}

function checkQueuedIntent() {
  if (!queuedIntent) return;
  const placed = countPlaced(queuedIntent.requiredType);
  if (placed >= queuedIntent.requiredCount) {
    const intent = queuedIntent;
    clearQueuedIntent();
    showHudMessage(`✓ READY — Starting ${intent.label}`);
    setTimeout(() => intent.intendedFn(), 420);
  } else {
    showChainToast();
  }
}

function showChainToast() {
  if (!queuedIntent) return;
  const placed = countPlaced(queuedIntent.requiredType);
  const needed = queuedIntent.requiredCount - placed;

  let el = document.getElementById("chain-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "chain-toast";
    Object.assign(el.style, {
      position: "fixed",
      top: "20px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "rgba(15,15,15,0.97)",
      border: "1.5px solid #cc2200",
      color: "#e8eef4",
      fontFamily: "'Share Tech Mono', monospace",
      fontSize: "11px",
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      padding: "10px 22px 10px 16px",
      clipPath: "polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,0 100%)",
      zIndex: "99997",
      boxShadow: "0 0 20px rgba(204,34,0,0.3)",
      display: "flex",
      alignItems: "center",
      gap: "12px",
      animation: "chainToastIn 0.3s ease both",
      whiteSpace: "nowrap",
    });
    document.body.appendChild(el);
    injectChainToastKeyframe();
  }

  const dots = Array.from(
    { length: queuedIntent.requiredCount },
    (_, i) =>
      `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin:0 2px;background:${i < countPlaced(queuedIntent.requiredType) ? "#cc2200" : "#2a1a18"};box-shadow:${i < countPlaced(queuedIntent.requiredType) ? "0 0 5px #cc2200" : "none"}"></span>`,
  ).join("");

  el.innerHTML =
    `<span style="color:#cc2200;font-size:13px">⟳</span>` +
    `<span>QUEUED: <strong style="color:#e8eef4">${queuedIntent.label}</strong></span>` +
    `<span style="color:#3a2820">·</span>` +
    `<span>Place <strong style="color:#e83a1a">${needed}</strong> more ${queuedIntent.requiredType.replace("_", " ")}${needed !== 1 ? "s" : ""}</span>` +
    `<span style="margin-left:4px">${dots}</span>` +
    `<button id="chain-cancel" style="margin-left:10px;background:none;border:1px solid #3a2820;color:#3a2820;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.1em;padding:2px 8px;cursor:pointer;transition:all 0.15s" onmouseover="this.style.color='#ff6060';this.style.borderColor='#ff6060'" onmouseout="this.style.color='#3a2820';this.style.borderColor='#3a2820'">✕ CANCEL</button>`;

  document.getElementById("chain-cancel")?.addEventListener("click", () => {
    clearQueuedIntent();
    clearGhost();
  });
}

function injectChainToastKeyframe() {
  if (document.getElementById("chain-kf")) return;
  const s = document.createElement("style");
  s.id = "chain-kf";
  s.textContent = `@keyframes chainToastIn{from{opacity:0;transform:translateX(-50%) translateY(-8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`;
  document.head.appendChild(s);
}

/* =========================================================
   PART COSTS + LABELS
   ========================================================= */

const PART_COSTS = {
  frame: 1200,
  motor: 2500,
  triangle_frame: 650,
  support_frame: 900,
  wheel: 1100,
};

const PART_LABELS = {
  frame: "Rectangular Frame",
  motor: "Motor Housing",
  triangle_frame: "Triangular Frame",
  support_frame: "Support Frame",
  wheel: "Wheel",
};

/* =========================================================
   CAMERA ANGLE PRESETS
   ========================================================= */

const CAMERA_PRESETS = {
  perspective: {
    label: "PERSPECTIVE",
    getPos: (center, dist) =>
      new THREE.Vector3(center.x, center.y + dist * 0.25, center.z + dist),
    lookAt: (center) => center.clone(),
  },
  front: {
    label: "FRONT",
    getPos: (center, dist) =>
      new THREE.Vector3(center.x, center.y, center.z + dist),
    lookAt: (center) => center.clone(),
  },
  back: {
    label: "BACK",
    getPos: (center, dist) =>
      new THREE.Vector3(center.x, center.y, center.z - dist),
    lookAt: (center) => center.clone(),
  },
  top: {
    label: "TOP",
    getPos: (center, dist) =>
      new THREE.Vector3(center.x, center.y + dist * 1.4, center.z + 0.001),
    lookAt: (center) => center.clone(),
  },
  bottom: {
    label: "BOTTOM",
    getPos: (center, dist) =>
      new THREE.Vector3(center.x, center.y - dist * 1.4, center.z + 0.001),
    lookAt: (center) => center.clone(),
  },
  left: {
    label: "LEFT",
    getPos: (center, dist) =>
      new THREE.Vector3(center.x - dist, center.y, center.z),
    lookAt: (center) => center.clone(),
  },
  right: {
    label: "RIGHT",
    getPos: (center, dist) =>
      new THREE.Vector3(center.x + dist, center.y, center.z),
    lookAt: (center) => center.clone(),
  },
  iso: {
    label: "ISOMETRIC",
    getPos: (center, dist) =>
      new THREE.Vector3(
        center.x + dist * 0.7,
        center.y + dist * 0.7,
        center.z + dist * 0.7,
      ),
    lookAt: (center) => center.clone(),
  },
};

let activeCamPreset = "perspective";

function applyCameraPreset(presetKey) {
  const preset = CAMERA_PRESETS[presetKey];
  if (!preset) return;

  activeCamPreset = presetKey;

  document.querySelectorAll(".sidebar-cam-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.cam === presetKey);
  });

  const box = new THREE.Box3();
  scene.traverse((o) => {
    if (o.userData?.isMount) {
      const b2 = new THREE.Box3().setFromObject(o);
      box.union(b2);
    }
  });

  const center = box.isEmpty()
    ? new THREE.Vector3(0, 0.6, 0)
    : box.getCenter(new THREE.Vector3());

  const size = box.isEmpty()
    ? new THREE.Vector3(2, 2, 2)
    : box.getSize(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z, 2);
  const fov = (camera.fov * Math.PI) / 180;
  const dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.6;

  const targetPos = preset.getPos(center, dist);
  const lookAtPos = preset.lookAt(center);

  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const duration = 600;
  const startTime = performance.now();

  function animateCam(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3);

    camera.position.lerpVectors(startPos, targetPos, ease);
    controls.target.lerpVectors(startTarget, lookAtPos, ease);
    controls.update();

    if (t < 1) requestAnimationFrame(animateCam);
  }
  requestAnimationFrame(animateCam);

  showHudMessage(`VIEW: ${preset.label}`);
}

function captureFromAngle(presetKey) {
  const preset = CAMERA_PRESETS[presetKey];
  if (!preset) return null;

  const box = new THREE.Box3();
  scene.traverse((o) => {
    if (o.userData?.isMount) {
      const b2 = new THREE.Box3().setFromObject(o);
      box.union(b2);
    }
  });

  const center = box.isEmpty()
    ? new THREE.Vector3(0, 0.6, 0)
    : box.getCenter(new THREE.Vector3());

  const size = box.isEmpty()
    ? new THREE.Vector3(2, 2, 2)
    : box.getSize(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z, 2);
  const fov = (camera.fov * Math.PI) / 180;
  const dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.6;

  const savedPos = camera.position.clone();
  const savedQuat = camera.quaternion.clone();
  const savedTarget = controls.target.clone();

  const targetPos = preset.getPos(center, dist);
  const lookAtPos = preset.lookAt(center);

  camera.position.copy(targetPos);
  camera.lookAt(lookAtPos);
  controls.target.copy(lookAtPos);
  controls.update();

  renderer.render(scene, camera);
  const dataURL = renderer.domElement.toDataURL("image/png");

  camera.position.copy(savedPos);
  camera.quaternion.copy(savedQuat);
  controls.target.copy(savedTarget);
  controls.update();
  renderer.render(scene, camera);

  return dataURL;
}

/* =========================================================
   INSTRUCTION PANEL DEFINITIONS
   ========================================================= */

const INSTRUCTIONS = {
  motor: {
    icon: "⚙",
    title: "MOTOR HOUSING",
    color: "#cc2200",
    steps: [
      {
        label: "LOCATE SOCKET",
        text: "Look for <strong style='color:#ff2200'>red glowing dots</strong> on your rectangular frame — these are the SOCKET_FRAME attachment points where motors can be mounted.",
      },
      {
        label: "HOVER TO PREVIEW",
        text: "Move your cursor over any red socket dot. The motor ghost <strong style='color:#e83a1a'>auto-rotates</strong> to face outward from that socket surface automatically.",
      },
      {
        label: "ROTATE (OPTIONAL)",
        text: "Press <kbd>R</kbd> to add an extra 90° rotation on top of the auto-orientation. Each press rotates it another quarter turn.",
      },
      {
        label: "CLICK TO PLACE",
        text: "Click on the socket to confirm placement. The motor locks in at the previewed orientation. <strong style='color:#e83a1a'>Mode stays active</strong> — keep clicking sockets to add more motors. Press <kbd>Esc</kbd> when done.",
      },
    ],
    tip: "The ghost auto-orients to each socket on hover. Press ← → to add manual rotation on top. Mode stays on after each motor — press Esc to exit.",
  },
  frame: {
    icon: "▭",
    title: "RECTANGULAR FRAME",
    color: "#909aa8",
    steps: [
      {
        label: "WHITE DOTS — EXTEND",
        text: "<strong style='color:#d8e0e8'>White socket dots</strong> on existing frames are SOCKET_FRAME points — hover and click to extend the structure outward with a new frame.",
      },
      {
        label: "STEEL DOTS — BRIDGE",
        text: "<strong style='color:#b0bcc8'>Steel-blue socket dots</strong> on support frames are SOCKET_FRAME_SUPPORT points — hover and click to lay a frame flat across supports.",
      },
      {
        label: "ROTATE ON SUPPORT (R)",
        text: "When hovering a <strong style='color:#b0bcc8'>steel-blue dot</strong>, press <kbd>←</kbd> <kbd>→</kbd> to rotate the frame in 90° increments before placing.",
      },
      {
        label: "CLICK TO PLACE",
        text: "Click any socket dot to confirm. <strong style='color:#e83a1a'>Mode stays active</strong> — keep clicking sockets to keep building. Press <kbd>Esc</kbd> when done.",
      },
    ],
    tip: "One button handles everything — white dots extend the frame structure, steel-blue dots bridge across supports. Press ← → on steel-blue sockets to rotate.",
  },
  triangle: {
    icon: "△",
    title: "TRIANGULAR FRAME",
    color: "#8090a0",
    steps: [
      {
        label: "LOCATE SOCKET",
        text: "Look for <strong style='color:#8090a0'>grey glowing dots</strong> — these are SOCKET_TRIANGLE connection points on your rectangular frames.",
      },
      {
        label: "HOVER TO PREVIEW",
        text: "Move your cursor over any grey socket dot. The triangle ghost <strong style='color:#8090a0'>auto-rotates</strong> to face outward from that frame edge automatically.",
      },
      {
        label: "ROTATE (OPTIONAL)",
        text: "Press <kbd>R</kbd> to add an extra 90° rotation on top of the auto-orientation. Each press rotates it another quarter turn.",
      },
      {
        label: "CLICK TO PLACE",
        text: "Click the socket dot to place. The triangle locks in at the previewed orientation. <strong style='color:#e83a1a'>Mode stays active</strong> — click another socket to add more triangles. Press <kbd>Esc</kbd> when done.",
      },
    ],
    tip: "The ghost auto-orients to each socket on hover. Press ← → to add manual rotation on top. Mode stays on after each triangle — press Esc to exit.",
  },
  support: {
    icon: "⊞",
    title: "SUPPORT FRAME",
    color: "#606870",
    steps: [
      {
        // ── CHANGED: now requires 2 triangular frames ──────────────────────
        label: "PREREQUISITE",
        text: "You need <strong>at least 2 Triangular Frames</strong> placed before adding a Support Frame. The stress bridge spans between a pair of triangles.",
      },
      {
        label: "LOCATE SOCKET",
        text: "Look for <strong style='color:#8090a0'>grey glowing dots</strong> on your triangular frames.",
      },
      {
        label: "HOVER TO PREVIEW",
        text: "Move your cursor over any grey socket. The support ghost <strong style='color:#8090a0'>auto-rotates</strong> to align with the triangle's straight edge.",
      },
      {
        label: "CLICK TO PLACE",
        text: "Click once to place the support frame. <strong style='color:#e83a1a'>Mode stays active</strong> — keep clicking sockets to add more. Press <kbd>Esc</kbd> when done.",
      },
    ],
    tip: "Two triangular frames are needed before a support/stress bridge can be placed. Use left/right arrows to rotate.",
  },
  wheel: {
    icon: "◎",
    title: "ADD WHEEL",
    color: "#c02010",
    steps: [
      {
        label: "PREREQUISITE",
        text: "You need at least <strong>1 Motor Housing</strong> placed on your frame before wheels can be attached.",
      },
      {
        label: "LOCATE SOCKET",
        text: "Look for <strong style='color:#ff3010'>hot-red glowing dots</strong> — these are WHEEL_SOCKET points on your placed motor housings.",
      },
      {
        label: "HOVER TO PREVIEW",
        text: "Move your cursor over any <strong style='color:#ff3010'>hot-red socket dot</strong>. The wheel ghost will snap and preview its mounted position.",
      },
      {
        label: "CLICK TO PLACE",
        text: "Click the socket dot to snap the wheel in. <strong style='color:#e83a1a'>Mode stays active</strong> — click more sockets to add more wheels. Press <kbd>Esc</kbd> when done.",
      },
    ],
    tip: "Placement mode stays on after each wheel. Press Esc to exit.",
  },
};

/* =========================================================
   INSTRUCTION PANEL
   ========================================================= */

function showInstructionPanel(mode) {
  const section = document.getElementById("instructionSection");
  const iconEl = document.getElementById("instructionIcon");
  const titleEl = document.getElementById("instructionTitle");
  const bodyEl = document.getElementById("instructionBody");
  const closeBtn = document.getElementById("instructionClose");

  if (!section || !bodyEl) return;

  const def = INSTRUCTIONS[mode];
  if (!def) return;

  iconEl.textContent = def.icon;
  iconEl.style.color = def.color;
  titleEl.textContent = def.title;
  titleEl.style.color = def.color;
  section.style.setProperty("--inst-color", def.color);

  let html = `<div class="inst-steps">`;
  def.steps.forEach((step, i) => {
    html += `
      <div class="inst-step" style="animation-delay:${i * 0.07}s">
        <div class="inst-step-num" style="border-color:${def.color};color:${def.color}">${i + 1}</div>
        <div class="inst-step-content">
          <div class="inst-step-label" style="color:${def.color}">${step.label}</div>
          <div class="inst-step-text">${step.text}</div>
        </div>
      </div>`;
  });
  html += `</div>`;

  if (def.tip) {
    html += `<div class="inst-tip"><span class="inst-tip-label">TIP</span>${def.tip}</div>`;
  }

  html += `<div class="inst-esc-hint">Press <kbd>Esc</kbd> to exit placement mode</div>`;

  bodyEl.innerHTML = html;
  section.style.display = "block";

  if (closeBtn) {
    closeBtn.onclick = () => {
      clearGhost();
    };
  }
}

function hideInstructionPanel() {
  const section = document.getElementById("instructionSection");
  if (section) section.style.display = "none";
}

/* =========================================================
   HOVER / TOOLTIP STATE
   ========================================================= */

let hoveredMount = null;
let tooltipEl = null;

let baseFrameYLevel = 0;

/* =========================================================
   PLACEMENT TUNING OFFSETS
   ========================================================= */

const FRAME_ON_SUPPORT_Y_OFFSET = -0.07;
const TRIANGLE_FRAME_Y_OFFSET = -0.01;
const SUPPORT_BRIDGE_Y_OFFSET = 0.11;
// Fine-tune Y lift for the 2-point connector snap (exact connector-to-socket
// alignment undershoots slightly because the socket sits at the slot bottom).
const SUPPORT_SNAP_Y_ADJUST = 0.1;

/* =========================================================
   RAYCAST
   ========================================================= */

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

/* =========================================================
   SOCKET MARKERS — INDUSTRIAL COLORS
   ========================================================= */

const socketGeo = new THREE.SphereGeometry(0.04, 12, 12);
const frameMat = new THREE.MeshBasicMaterial({ color: 0xd0d8e0 });
const motorMat = new THREE.MeshBasicMaterial({ color: 0xdd2200 });
const supportFrameSocketMat = new THREE.MeshBasicMaterial({ color: 0x909aaa });
const wheelSocketMat = new THREE.MeshBasicMaterial({ color: 0xff3010 });

let frameMarkers = [];
let motorMarkers = [];

// ── v34: split triangle markers ──────────────────────────────────────────────
// triangleSocketMarkers  → SOCKET_TRIANGLE only  → used for triangle placement raycasting
// stressConnectorMarkers → SOCKET_STRESS_CONNECTOR only → used for support frame raycasting
// triangleMarkers        → union of both, used for highlighting / pulsing / visibility
let triangleSocketMarkers = [];
let stressConnectorMarkers = [];
let triangleMarkers = [];
// ─────────────────────────────────────────────────────────────────────────────

let frameOnSupportMarkers = [];
let wheelMarkers = [];

/* =========================================================
   SUPPORT SOCKET PAIRS (TRIANGLE)
   ========================================================= */

const SUPPORT_TRIANGLE_PAIRS = [
  ["SOCKET_STRESS_CONNECTOR_A", "SOCKET_STRESS_CONNECTOR_B"],
  ["SOCKET_STRESS_CONNECTOR_C", "SOCKET_STRESS_CONNECTOR_D"],
];

/* =========================================================
   FRAME SOCKET HELPERS — EXACT Y LEVELING
   ========================================================= */

const OPPOSITE_SOCKET_SUFFIX = { A: "C", B: "D", C: "A", D: "B" };

let _frameTemplateSocketCache = null;

function getFrameTemplateSocketOffsets() {
  if (_frameTemplateSocketCache) return _frameTemplateSocketCache;

  const tempRoot = new THREE.Group();
  tempRoot.position.set(0, 0, 0);
  tempRoot.rotation.set(0, 0, 0);
  tempRoot.scale.set(1, 1, 1);

  const tempFrame = frameTemplate.clone(true);
  tempFrame.position.set(0, 0, 0);
  tempFrame.rotation.set(0, 0, 0);
  tempFrame.scale.set(1, 1, 1);
  tempRoot.add(tempFrame);

  tempRoot.updateMatrixWorld(true);

  const sockets = [];
  tempRoot.traverse((o) => {
    if (!o.name) return;
    if (!o.name.startsWith("SOCKET_FRAME")) return;
    if (o.name.startsWith("SOCKET_FRAME_SUPPORT")) return;

    const suffix = o.name.replace(/^SOCKET_FRAME_/i, "").toUpperCase();
    const localOffset = new THREE.Vector3();
    o.getWorldPosition(localOffset);
    sockets.push({ name: o.name, suffix, localOffset });
  });

  _frameTemplateSocketCache = sockets;
  return sockets;
}

let _frameSupportSocketLocalY = null;

function getFrameSupportSocketLocalY() {
  if (_frameSupportSocketLocalY !== null) return _frameSupportSocketLocalY;
  _frameSupportSocketLocalY = 0;
  if (frameTemplate) {
    const tempRoot = new THREE.Group();
    const tempFrame = frameTemplate.clone(true);
    tempRoot.add(tempFrame);
    tempRoot.updateMatrixWorld(true);
    tempFrame.traverse((o) => {
      if (o.name && o.name.toUpperCase().startsWith("SOCKET_FRAME_SUPPORT")) {
        const wp = new THREE.Vector3();
        o.getWorldPosition(wp);
        _frameSupportSocketLocalY = wp.y;
      }
    });
  }
  return _frameSupportSocketLocalY;
}

function computeFrameSnapPosition(clickedSocket) {
  scene.updateMatrixWorld(true);
  clickedSocket.updateMatrixWorld(true);

  const socketWorldPos = new THREE.Vector3();
  clickedSocket.getWorldPosition(socketWorldPos);

  const sockets = getFrameTemplateSocketOffsets();

  const clickedSuffix = clickedSocket.name
    .replace(/^SOCKET_FRAME_/i, "")
    .toUpperCase();
  const preferredSuffix = OPPOSITE_SOCKET_SUFFIX[clickedSuffix] ?? null;

  let snapSocket = null;

  if (preferredSuffix) {
    snapSocket = sockets.find((s) => s.suffix === preferredSuffix) ?? null;
  }

  if (!snapSocket && sockets.length > 0) {
    const centroid = new THREE.Vector3();
    sockets.forEach((s) => centroid.add(s.localOffset));
    centroid.divideScalar(sockets.length);

    let maxDist = -1;
    for (const s of sockets) {
      const d = s.localOffset.distanceTo(centroid);
      if (d > maxDist) {
        maxDist = d;
        snapSocket = s;
      }
    }
  }

  let parentMount = clickedSocket.parent;
  while (parentMount && !parentMount.userData?.isMount) {
    parentMount = parentMount.parent;
  }
  const exactY = parentMount ? parentMount.position.y : baseFrameYLevel;

  if (!snapSocket) {
    return {
      mountPos: new THREE.Vector3(socketWorldPos.x, exactY, socketWorldPos.z),
    };
  }

  const mountPos = new THREE.Vector3(
    socketWorldPos.x - snapSocket.localOffset.x,
    exactY,
    socketWorldPos.z - snapSocket.localOffset.z,
  );

  return { mountPos };
}

/* =========================================================
   MOTOR AUTO-ORIENTATION HELPER — v11
   ========================================================= */

function computeMotorAutoYaw(socket) {
  scene.updateMatrixWorld(true);
  socket.updateMatrixWorld(true);

  const socketWorldPos = new THREE.Vector3();
  socket.getWorldPosition(socketWorldPos);

  let parentMount = socket.parent;
  while (parentMount && !parentMount.userData?.isMount) {
    parentMount = parentMount.parent;
  }

  if (parentMount) {
    parentMount.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(parentMount);
    const centre = box.getCenter(new THREE.Vector3());

    const outward = new THREE.Vector3(
      socketWorldPos.x - centre.x,
      0,
      socketWorldPos.z - centre.z,
    );

    if (outward.lengthSq() > 0.001) {
      outward.normalize();
      return Math.atan2(outward.x, outward.z) + Math.PI;
    }
  }

  const socketWorldQuat = new THREE.Quaternion();
  socket.getWorldQuaternion(socketWorldQuat);
  const euler = new THREE.Euler().setFromQuaternion(socketWorldQuat, "YXZ");
  return euler.y + Math.PI;
}

/* =========================================================
   TRIANGLE AUTO-ORIENTATION HELPER — v24
   ========================================================= */

function computeTriangleAutoYaw(socket) {
  scene.updateMatrixWorld(true);
  socket.updateMatrixWorld(true);

  const socketWorldPos = new THREE.Vector3();
  socket.getWorldPosition(socketWorldPos);

  let parentMount = socket.parent;
  while (parentMount && !parentMount.userData?.isMount) {
    parentMount = parentMount.parent;
  }

  if (parentMount) {
    parentMount.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(parentMount);
    const centre = box.getCenter(new THREE.Vector3());

    const outward = new THREE.Vector3(
      socketWorldPos.x - centre.x,
      0,
      socketWorldPos.z - centre.z,
    );

    if (outward.lengthSq() > 0.001) {
      outward.normalize();
      return Math.atan2(outward.x, outward.z);
    }
  }

  // Fallback: use socket's own world quaternion yaw
  const socketWorldQuat = new THREE.Quaternion();
  socket.getWorldQuaternion(socketWorldQuat);
  const euler = new THREE.Euler().setFromQuaternion(socketWorldQuat, "YXZ");
  return euler.y;
}

/* =========================================================
   DEPENDENCY RULES — v12
   ========================================================= */

function getAllMounts() {
  const mounts = [];
  scene.traverse((o) => {
    if (o.userData?.isMount) mounts.push(o);
  });
  return mounts;
}

function isDescendantOrSelf(node, ancestor) {
  let o = node;
  while (o) {
    if (o === ancestor) return true;
    o = o.parent;
  }
  return false;
}

function getDependentMounts(targetMount) {
  const dependents = [];
  const allMounts = getAllMounts();

  for (const mount of allMounts) {
    if (mount === targetMount) continue;

    const { socket, socketB } = mount.userData;

    const socketOnTarget =
      (socket && isDescendantOrSelf(socket, targetMount)) ||
      (socketB && isDescendantOrSelf(socketB, targetMount));

    if (socketOnTarget) {
      dependents.push(mount);
      continue;
    }

    if (mount.userData.type === "wheel" && socket) {
      if (isDescendantOrSelf(socket, targetMount)) {
        if (!dependents.includes(mount)) dependents.push(mount);
      }
    }
  }

  return dependents;
}

function mountLabel(mount) {
  const type = mount.userData.type ?? "unknown";
  return PART_LABELS[type] ?? type.replace(/_/g, " ");
}

function checkDeletionAllowed(targetMount) {
  const dependents = getDependentMounts(targetMount);

  if (dependents.length === 0) return { ok: true };

  const typeCount = {};
  for (const dep of dependents) {
    const t = dep.userData.type ?? "unknown";
    typeCount[t] = (typeCount[t] ?? 0) + 1;
  }

  const lines = Object.entries(typeCount).map(
    ([t, n]) => `${n}× ${PART_LABELS[t] ?? t.replace(/_/g, " ")}`,
  );

  const targetLabel = mountLabel(targetMount);

  const message =
    `Cannot delete ${targetLabel} — the following parts depend on it and must be removed first:\n\n` +
    lines.join("\n");

  return { ok: false, dependents, message, lines };
}

function showDependencyBlockedPopup(targetMount, result) {
  const existing = document.getElementById("dep-popup");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "dep-popup";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.75)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "999999",
  });

  const box = document.createElement("div");
  Object.assign(box.style, {
    background: "#111111",
    border: "2px solid #cc2200",
    padding: "32px 40px",
    maxWidth: "500px",
    width: "92%",
    fontFamily: "'Share Tech Mono', monospace",
    color: "#e8eef4",
    textAlign: "center",
    clipPath: "polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%)",
    boxShadow: "0 0 40px rgba(204,34,0,0.3)",
  });

  const title = document.createElement("div");
  title.innerHTML = "⚠&nbsp; DELETION BLOCKED";
  Object.assign(title.style, {
    fontSize: "10px",
    letterSpacing: "0.2em",
    color: "#cc2200",
    marginBottom: "14px",
    fontWeight: "700",
    fontFamily: "'Orbitron', sans-serif",
  });

  const targetName = document.createElement("div");
  targetName.textContent = `Cannot delete: ${mountLabel(targetMount).toUpperCase()}`;
  Object.assign(targetName.style, {
    fontSize: "13px",
    color: "#e8eef4",
    marginBottom: "16px",
    fontFamily: "'Orbitron', sans-serif",
    fontWeight: "600",
    letterSpacing: "0.06em",
  });

  const reason = document.createElement("div");
  reason.textContent =
    "The following parts are attached and must be removed first:";
  Object.assign(reason.style, {
    fontSize: "11px",
    color: "#8090a0",
    marginBottom: "14px",
    letterSpacing: "0.05em",
    lineHeight: "1.5",
  });

  const list = document.createElement("div");
  Object.assign(list.style, {
    background: "rgba(204,34,0,0.06)",
    border: "1px solid rgba(204,34,0,0.2)",
    padding: "10px 16px",
    marginBottom: "22px",
    textAlign: "left",
  });

  result.lines.forEach((line) => {
    const row = document.createElement("div");
    row.textContent = "▸  " + line;
    Object.assign(row.style, {
      fontSize: "12px",
      color: "#e8eef4",
      lineHeight: "2",
      letterSpacing: "0.06em",
    });
    list.appendChild(row);
  });

  const btnRow = document.createElement("div");
  Object.assign(btnRow.style, {
    display: "flex",
    gap: "12px",
    justifyContent: "center",
    flexWrap: "wrap",
  });

  function makeBtn(label, primary) {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      background: primary ? "#cc2200" : "transparent",
      border: "1.5px solid #cc2200",
      color: primary ? "#111111" : "#cc2200",
      fontFamily: "'Orbitron', sans-serif",
      fontSize: "10px",
      letterSpacing: "0.18em",
      padding: "9px 22px",
      cursor: "pointer",
      textTransform: "uppercase",
      transition: "background 0.15s, color 0.15s",
    });
    b.onmouseover = () => {
      b.style.background = "#cc2200";
      b.style.color = "#111111";
    };
    b.onmouseout = () => {
      b.style.background = primary ? "#cc2200" : "transparent";
      b.style.color = primary ? "#111111" : "#cc2200";
    };
    return b;
  }

  const dismissBtn = makeBtn("UNDERSTOOD", false);
  dismissBtn.onclick = () => overlay.remove();

  const cascadeBtn = makeBtn("DELETE ALL", true);
  cascadeBtn.title = "Remove dependents and this part together";
  cascadeBtn.onclick = () => {
    overlay.remove();
    performCascadeDelete(targetMount, result.dependents);
  };

  btnRow.appendChild(dismissBtn);
  btnRow.appendChild(cascadeBtn);

  box.appendChild(title);
  box.appendChild(targetName);
  box.appendChild(reason);
  box.appendChild(list);
  box.appendChild(btnRow);
  overlay.appendChild(box);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}

function performCascadeDelete(targetMount, directDependents) {
  const toDelete = new Set();

  function collectDeps(mount) {
    if (toDelete.has(mount)) return;
    toDelete.add(mount);
    const deps = getDependentMounts(mount);
    deps.forEach(collectDeps);
  }

  directDependents.forEach(collectDeps);
  toDelete.add(targetMount);

  for (const mount of toDelete) {
    if (selectedMount === mount) {
      restoreMeshEmissive(selectedMesh, selectedOrigEm);
      selectedMesh = null;
      selectedMount = null;
    }
    if (hoveredMount === mount) {
      restoreMeshEmissive(hoveredMesh, hoveredOrigEm);
      hoveredMesh = null;
      hoveredMount = null;
    }

    const { socket, socketB, type } = mount.userData;
    if (socket) usedSockets.delete(socket.uuid);
    if (socketB) usedSockets.delete(socketB.uuid);

    for (const entry of undoStack) {
      if (entry.mount === mount) {
        entry.socketUuids.forEach((uuid) => usedSockets.delete(uuid));
      }
    }

    scene.remove(mount);
    removeFromInventory(type ?? "frame");
  }

  rebuildSocketMarkers();
  applySocketHighlights();

  const count = toDelete.size;
  showHudMessage(
    `CASCADE DELETE: ${count} part${count !== 1 ? "s" : ""} removed`,
  );
}

/* =========================================================
   INIT
   ========================================================= */

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const canvas = document.getElementById("app");
  if (!canvas) return;

  renderer = createRenderer(canvas);
  renderer.physicallyCorrectLights = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setClearColor(0x252525, 1);

  controls = createControls(camera, renderer.domElement);
  controls.minDistance = 1.0;
  controls.maxDistance = 30;
  controls.enablePan = true;
  controls.panSpeed = 1.2;
  controls.screenSpacePanning = true;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.PAN,
  };

  setupLights();

  frameTemplate = await loadGLB("/assets/models/rectangle_frame.glb");
  motorTemplate = await loadGLB("/assets/models/motor_housing.glb");
  triangleTemplate = await loadGLB("/assets/models/triangle_frame.glb");
  supportTemplate = await loadGLB("/assets/models/support_frame.glb");
  wheelTemplate = await loadGLB("/assets/models/wheel.glb");

  setupGrid();

  const baseFrameModel = frameTemplate.clone(true);
  baseFrameModel.position.set(0, 0, 0);
  baseFrameModel.rotation.set(0, 0, 0);
  baseFrameModel.scale.set(1, 1, 1);

  const baseMount = new THREE.Group();
  baseMount.userData = { isMount: true, type: "frame" };
  baseMount.position.set(0, 0.6, 0);
  baseMount.add(baseFrameModel);
  scene.add(baseMount);

  baseFrameYLevel = baseMount.position.y;

  frameObject(baseMount);

  initInventory({ frame: 1 });

  bindUI();
  bindCameraButtons();
  initShortcutBar();
  initColorLegend();
  initIdleArrows();
  rebuildSocketMarkers();
  applySocketHighlights();

  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("click", onClick);
  window.addEventListener("keydown", onKeyDown);

  window.addEventListener("resize", onWindowResize);
  onWindowResize();

  // ── Accidental-refresh guard (v35) ───────────────────────────────────────
  window.addEventListener("beforeunload", (e) => {
    const totalPlaced =
      countPlaced("frame") +
      countPlaced("motor") +
      countPlaced("triangle_frame") +
      countPlaced("support_frame") +
      countPlaced("wheel");
    if (totalPlaced > 1) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  // ─────────────────────────────────────────────────────────────────────────

  animate();
}

/* =========================================================
   CAMERA BUTTONS BINDING
   ========================================================= */

function bindCameraButtons() {
  document.querySelectorAll(".sidebar-cam-btn").forEach((btn) => {
    const preset = btn.dataset.cam;
    if (preset) {
      btn.addEventListener("click", () => applyCameraPreset(preset));
    }
  });

  const perspBtn = document.querySelector('[data-cam="perspective"]');
  if (perspBtn) perspBtn.classList.add("active");
}

/* =========================================================
   CAMERA FRAMING
   ========================================================= */

function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = (camera.fov * Math.PI) / 180;
  let distance = maxDim / (2 * Math.tan(fov / 2));
  distance *= 1.6;

  camera.position.set(
    center.x,
    center.y + distance * 0.25,
    center.z + distance,
  );

  camera.lookAt(center);
  controls.target.copy(center);
  controls.update();
}

/* =========================================================
   LIGHTING
   ========================================================= */

function setupLights() {
  scene.background = new THREE.Color(0x252525);
  scene.fog = new THREE.FogExp2(0x252525, 0.042);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.55));

  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(6, 7, 5);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-5, 3, 4);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.6);
  rim.position.set(-3, 5, -6);
  scene.add(rim);
}

/* =========================================================
   GRID FLOOR
   ========================================================= */

function setupGrid() {
  let lowestY = -0.5;

  if (motorTemplate) {
    const box = new THREE.Box3().setFromObject(motorTemplate);
    lowestY = Math.min(lowestY, box.min.y - 0.08);
  }

  const gridY = lowestY;

  const gridMajor = new THREE.GridHelper(60, 60, 0x2a2a2a, 0x1e1e1e);
  gridMajor.position.y = gridY;
  gridMajor.material.transparent = true;
  gridMajor.material.opacity = 0.65;
  scene.add(gridMajor);

  const gridMinor = new THREE.GridHelper(60, 240, 0x181818, 0x181818);
  gridMinor.position.y = gridY - 0.001;
  gridMinor.material.transparent = true;
  gridMinor.material.opacity = 0.4;
  scene.add(gridMinor);

  const groundGeo = new THREE.PlaneGeometry(60, 60);
  const groundMat = new THREE.MeshBasicMaterial({
    color: 0x0d0d0d,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = gridY - 0.002;
  scene.add(ground);
}

/* =========================================================
   UI BINDINGS
   ========================================================= */

function bindUI() {
  bind("addMotor", () => !isFinalized && startMotorPlacement());
  bind("addFrame", () => !isFinalized && startFramePlacement());
  bind("addTriangle", () => !isFinalized && startTrianglePlacement());
  bind("addSupportFrame", () => !isFinalized && startSupportPlacement());
  bind("addFrameToSupport", () => !isFinalized && startFramePlacement());
  bind("addWheelBtn", () => !isFinalized && startWheelPlacement());

  bind("finalizeBtn", onFinalize);
  bind("editBtn", onEdit);
  bind("proceedPaymentBtn", onProceedToPayment);
  bind("saveDesignBtn", saveDesign);
  bind("printDesignBtn", printDesign);

  tooltipEl = document.createElement("div");
  tooltipEl.id = "part-tooltip";
  Object.assign(tooltipEl.style, {
    position: "fixed",
    pointerEvents: "none",
    display: "none",
    background: "rgba(15,15,15,0.95)",
    border: "1px solid #cc2200",
    color: "#e8eef4",
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: "12px",
    letterSpacing: "0.08em",
    padding: "8px 14px",
    clipPath: "polygon(0 0,calc(100% - 7px) 0,100% 7px,100% 100%,0 100%)",
    boxShadow: "0 0 14px rgba(204,34,0,0.25)",
    zIndex: "99998",
    lineHeight: "1.7",
    whiteSpace: "nowrap",
  });
  document.body.appendChild(tooltipEl);
}

function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", fn);
}

/* =========================================================
   FINALIZE / EDIT
   ========================================================= */

function onFinalize() {
  if (isFinalized) return;
  isFinalized = true;
  clearGhost();
  document.getElementById("paymentSection")?.classList.remove("hidden");
}

function onEdit() {
  if (!isFinalized) return;
  isFinalized = false;
  document.getElementById("paymentSection")?.classList.add("hidden");
}

function onProceedToPayment() {
  alert("Proceeding to payment...");
}

/* =========================================================
   SAVE DESIGN
   ========================================================= */

function saveDesign() {
  const parts = [];
  scene.traverse((obj) => {
    if (!obj.userData?.isMount) return;
    const p = obj.position;
    const r = obj.rotation;
    parts.push({
      type: obj.userData.type ?? "unknown",
      position: { x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(4) },
      rotation: { x: +r.x.toFixed(4), y: +r.y.toFixed(4), z: +r.z.toFixed(4) },
    });
  });

  const basketRows = [];
  document.querySelectorAll("#basketItems > *").forEach((row) => {
    basketRows.push(row.textContent.trim().replace(/\s+/g, " "));
  });
  const total = document.getElementById("totalPrice")?.textContent ?? "0";

  renderer.render(scene, camera);
  const screenshot = renderer.domElement.toDataURL("image/png");

  const saveData = {
    version: "1.0",
    savedAt: new Date().toISOString(),
    finalized: isFinalized,
    parts,
    basket: { rows: basketRows, total: "₹" + total },
    screenshot,
  };

  const blob = new Blob([JSON.stringify(saveData, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: "robot-design-" + Date.now() + ".json",
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showHudMessage("DESIGN SAVED ✓");
}

/* =========================================================
   PRINT DESIGN — Multi-angle screenshots
   ========================================================= */

function printDesign() {
  const angleKeys = [
    "perspective",
    "front",
    "back",
    "top",
    "bottom",
    "left",
    "right",
    "iso",
  ];
  const angleLabels = {
    perspective: "Perspective",
    front: "Front",
    back: "Back",
    top: "Top",
    bottom: "Bottom",
    left: "Left",
    right: "Right",
    iso: "Isometric",
  };

  showHudMessage("CAPTURING VIEWS...");

  setTimeout(() => {
    const screenshots = {};
    for (const key of angleKeys) {
      screenshots[key] = captureFromAngle(key);
    }

    const basketRows = [];
    document.querySelectorAll("#basketItems > *").forEach((row) => {
      basketRows.push(row.textContent.trim().replace(/\s+/g, " "));
    });
    const total = document.getElementById("totalPrice")?.textContent ?? "0";

    const counts = {};
    scene.traverse((obj) => {
      if (!obj.userData?.isMount) return;
      const t = obj.userData.type ?? "unknown";
      counts[t] = (counts[t] ?? 0) + 1;
    });

    const statsRows = Object.entries(counts)
      .map(
        ([t, n]) =>
          `<tr><td>${t.replace(/_/g, " ").toUpperCase()}</td><td>${n}</td></tr>`,
      )
      .join("");

    const basketRowsHTML = basketRows
      .map((r) => `<tr><td colspan="2">${r}</td></tr>`)
      .join("");

    const now = new Date().toLocaleString();

    const mainShot = screenshots["iso"];
    const otherAngles = [
      "perspective",
      "front",
      "back",
      "top",
      "bottom",
      "left",
      "right",
    ];

    const otherAnglesHTML = otherAngles
      .map(
        (k) => `
        <div class="angle-card">
          <div class="angle-label">${angleLabels[k].toUpperCase()}</div>
          <img src="${screenshots[k]}" alt="${angleLabels[k]} view" />
        </div>
      `,
      )
      .join("");

    const printHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Robot Design — Print</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;700;900&family=Share+Tech+Mono&family=Rajdhani:wght@400;500;600;700&family=Exo+2:wght@400;600;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #fff; color: #111; font-family: 'Rajdhani', sans-serif; padding: 22px 28px; }
    .print-header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 14px; border-bottom: 3px solid #1a1a1a; margin-bottom: 18px; }
    .print-title { font-family: 'Orbitron', sans-serif; font-size: 22px; font-weight: 900; letter-spacing: 0.12em; color: #111; line-height: 1; }
    .print-subtitle { font-family: 'Share Tech Mono', monospace; font-size: 10px; color: #666; letter-spacing: 0.15em; text-transform: uppercase; margin-top: 5px; }
    .print-meta { text-align: right; font-family: 'Share Tech Mono', monospace; font-size: 10px; color: #555; line-height: 1.7; letter-spacing: 0.05em; }
    .status-badge { display: inline-block; padding: 2px 10px; font-size: 9px; font-family: 'Orbitron', sans-serif; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; border: 1.5px solid; margin-top: 4px; }
    .status-final  { color: #166534; border-color: #166534; background: #f0fdf4; }
    .status-draft  { color: #7f1d1d; border-color: #cc2200; background: #fff5f5; }
    .main-view-wrap { width: 100%; border: 2px solid #222; margin-bottom: 14px; background: #f0f0f0; overflow: hidden; position: relative; }
    .main-view-wrap img { width: 100%; display: block; max-height: 320px; object-fit: contain; }
    .main-view-label { position: absolute; top: 8px; left: 12px; font-family: 'Orbitron', sans-serif; font-size: 9px; font-weight: 700; letter-spacing: 0.2em; color: #cc2200; background: rgba(255,255,255,0.82); padding: 3px 8px; }
    .section-title { font-family: 'Orbitron', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.2em; color: #111; text-transform: uppercase; border-left: 4px solid #cc2200; padding-left: 10px; margin-bottom: 10px; }
    .angles-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 18px; }
    .angle-card { border: 1.5px solid #222; background: #f0f0f0; overflow: hidden; position: relative; }
    .angle-label { font-family: 'Orbitron', sans-serif; font-size: 7px; font-weight: 700; letter-spacing: 0.18em; color: #cc2200; background: rgba(255,255,255,0.82); padding: 3px 6px; position: absolute; top: 0; left: 0; z-index: 1; }
    .angle-card img { width: 100%; display: block; max-height: 130px; object-fit: contain; }
    .tables-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .table-card { border: 1.5px solid #222; }
    .table-card-header { background: #1a1a1a; color: #cc2200; font-family: 'Orbitron', sans-serif; font-size: 9px; font-weight: 700; letter-spacing: 0.18em; padding: 6px 12px; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    td { padding: 6px 12px; border-bottom: 1px solid #e5e5e5; font-family: 'Rajdhani', sans-serif; letter-spacing: 0.03em; }
    td:last-child { text-align: right; font-family: 'Share Tech Mono', monospace; font-weight: 700; }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) td { background: #fafafa; }
    .total-bar { display: flex; justify-content: space-between; align-items: center; border: 2px solid #1a1a1a; padding: 10px 20px; margin-bottom: 16px; background: #f8f8f8; }
    .total-label { font-family: 'Orbitron', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.1em; color: #111; }
    .total-value { font-family: 'Orbitron', sans-serif; font-size: 22px; font-weight: 900; color: #cc2200; letter-spacing: 0.06em; }
    .print-footer { border-top: 1px solid #ccc; padding-top: 10px; display: flex; justify-content: space-between; font-family: 'Share Tech Mono', monospace; font-size: 9px; color: #888; letter-spacing: 0.08em; }
    @media print { body { padding: 12px 16px; } }
  </style>
</head>
<body>
  <div class="print-header">
    <div>
      <div class="print-title">ROBOT CONFIGURATOR</div>
      <div class="print-subtitle">Design Report &nbsp;·&nbsp; MK-1 Unit &nbsp;·&nbsp; Multi-Angle View</div>
    </div>
    <div class="print-meta">
      Generated: ${now}<br>
      Parts: ${Object.values(counts).reduce((a, b) => a + b, 0)}<br>
      <span class="status-badge ${isFinalized ? "status-final" : "status-draft"}">
        ${isFinalized ? "✓ Finalized" : "⚠ Draft"}
      </span>
    </div>
  </div>
  <div class="main-view-wrap">
    <div class="main-view-label">◈ ISOMETRIC VIEW</div>
    <img src="${mainShot}" alt="Isometric View"/>
  </div>
  <div class="section-title">◼ MULTI-ANGLE VIEWS</div>
  <div class="angles-grid">${otherAnglesHTML}</div>
  <div class="tables-row">
    <div class="table-card">
      <div class="table-card-header">Component Manifest</div>
      <table>
        <tr><td><strong>Type</strong></td><td><strong>Qty</strong></td></tr>
        ${statsRows || "<tr><td colspan='2'>No parts placed</td></tr>"}
      </table>
    </div>
    <div class="table-card">
      <div class="table-card-header">Cost Breakdown</div>
      <table>
        ${basketRowsHTML || "<tr><td colspan='2'>Empty</td></tr>"}
      </table>
    </div>
  </div>
  <div class="total-bar">
    <span class="total-label">TOTAL REQUISITION COST</span>
    <span class="total-value">₹${total}</span>
  </div>
  <div class="print-footer">
    <span>ROBOT CONFIGURATOR v1.0 — UNIT MK-1</span>
    <span>CONFIDENTIAL — INTERNAL USE ONLY</span>
    <span>${now}</span>
  </div>
  <script>window.onload = () => { window.print(); };<\/script>
</body>
</html>`;

    const win = window.open("", "_blank", "width=1000,height=800");
    win.document.write(printHTML);
    win.document.close();

    showHudMessage("PRINT REPORT READY ✓");
  }, 100);
}

/* =========================================================
   KEYBOARD SHORTCUT BAR
   ========================================================= */

const SHORTCUT_DEFS = {
  idle: [
    { key: "CLICK", action: "Select part" },
    { key: "DEL", action: "Delete selected" },
    { key: "CTRL+Z", action: "Undo" },
    { key: "ESC", action: "Deselect" },
    { key: "SCROLL", action: "Zoom" },
    { key: "RMB drag", action: "Pan" },
  ],
  frame: [
    { key: "CLICK", action: "Place frame" },
    { key: "← →", action: "Rotate on support" },
    { key: "ESC", action: "Exit mode" },
    { key: "CTRL+Z", action: "Undo last" },
  ],
  motor: [
    { key: "HOVER", action: "Auto-orient" },
    { key: "CLICK", action: "Place motor" },
    { key: "← →", action: "Add 90° rotation" },
    { key: "ESC", action: "Exit mode" },
  ],
  triangle: [
    { key: "HOVER", action: "Auto-orient" },
    { key: "CLICK", action: "Place triangle" },
    { key: "← →", action: "Flip 180°" },
    { key: "ESC", action: "Exit mode" },
  ],
  support: [
    { key: "HOVER", action: "Auto-orient" },
    { key: "CLICK", action: "Place support" },
    { key: "← →", action: "Rotate 90°" },
    { key: "ESC", action: "Exit mode" },
  ],
  wheel: [
    { key: "CLICK", action: "Snap wheel" },
    { key: "ESC", action: "Exit mode" },
  ],
};

let shortcutBarEl = null;

function initShortcutBar() {
  shortcutBarEl = document.createElement("div");
  shortcutBarEl.id = "shortcut-bar";
  Object.assign(shortcutBarEl.style, {
    position: "fixed",
    bottom: "0",
    left: "300px",
    right: "300px",
    height: "34px",
    background: "rgba(15,15,15,0.96)",
    borderTop: "1px solid rgba(204,34,0,0.2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0",
    zIndex: "9000",
    backdropFilter: "blur(6px)",
    overflow: "hidden",
  });
  document.body.appendChild(shortcutBarEl);

  if (!document.getElementById("sb-kf")) {
    const s = document.createElement("style");
    s.id = "sb-kf";
    s.textContent = `
      @keyframes sbItemIn {
        from { opacity:0; transform:translateY(4px); }
        to   { opacity:1; transform:translateY(0); }
      }
      .sb-sep { width:1px; height:16px; background:rgba(204,34,0,0.15); flex-shrink:0; margin:0; }
      .sb-item { display:flex; align-items:center; gap:6px; padding:0 14px; height:100%; animation:sbItemIn 0.18s ease both; cursor:default; flex-shrink:0; transition: background 0.15s; }
      .sb-item:hover { background:rgba(204,34,0,0.06); }
      .sb-key { font-family:'Orbitron',sans-serif; font-size:9px; font-weight:700; letter-spacing:0.08em; color:#cc2200; background:rgba(204,34,0,0.12); border:1px solid rgba(204,34,0,0.3); padding:2px 6px; white-space:nowrap; line-height:1.4; }
      .sb-action { font-family:'Share Tech Mono',monospace; font-size:9.5px; letter-spacing:0.06em; color:#5a6268; text-transform:uppercase; white-space:nowrap; }
      .sb-mode-label { font-family:'Orbitron',sans-serif; font-size:8px; font-weight:700; letter-spacing:0.18em; padding:0 16px; text-transform:uppercase; flex-shrink:0; white-space:nowrap; }
      .sb-chain-label { font-family:'Share Tech Mono',monospace; font-size:9px; letter-spacing:0.1em; color:#cc2200; padding:0 12px; flex-shrink:0; white-space:nowrap; display:flex; align-items:center; gap:6px; }
    `;
    document.head.appendChild(s);
  }

  updateShortcutBar();
}

function updateShortcutBar() {
  if (!shortcutBarEl) return;
  shortcutBarEl.innerHTML = "";

  const mode = placementMode || "idle";

  const modeColors = {
    idle: { color: "#5a6268", label: "BROWSE" },
    frame: { color: "#909aa8", label: "FRAME ●" },
    motor: { color: "#cc2200", label: "MOTOR ●" },
    triangle: { color: "#808898", label: "TRIANGLE ●" },
    support: { color: "#606870", label: "SUPPORT ●" },
    wheel: { color: "#e83a1a", label: "WHEEL ●" },
  };

  const mc = modeColors[mode] || modeColors.idle;
  const modeLabel = document.createElement("div");
  modeLabel.className = "sb-mode-label";
  modeLabel.style.color = mc.color;
  modeLabel.style.borderRight = `1px solid rgba(204,34,0,0.15)`;
  modeLabel.textContent = mc.label;
  shortcutBarEl.appendChild(modeLabel);

  if (queuedIntent) {
    const chainEl = document.createElement("div");
    chainEl.className = "sb-chain-label";
    const placed = countPlaced(queuedIntent.requiredType);
    const need = queuedIntent.requiredCount - placed;
    chainEl.innerHTML =
      `<span style="color:#cc2200">⟳</span>` +
      `<span>QUEUED: ${queuedIntent.label} — ${need} more needed</span>`;
    chainEl.style.borderRight = "1px solid rgba(204,34,0,0.15)";
    shortcutBarEl.appendChild(chainEl);
  }

  const defs = SHORTCUT_DEFS[mode] || SHORTCUT_DEFS.idle;

  const patchedDefs = defs.map((d) => {
    if (mode === "frame" && d.key === "← →") {
      const deg = (((frameOnSupportRotationSteps % 4) + 4) % 4) * 90;
      return { key: "← →", action: `Rotate on support (${deg}°)` };
    }
    if (mode === "motor" && d.key === "← →") {
      const deg = (((motorManualRotSteps % 4) + 4) % 4) * 90;
      return { key: "← →", action: `+${deg}° manual` };
    }
    if (mode === "triangle" && d.key === "← →") {
      return {
        key: "← →",
        action: `flip ${triangleManualRotSteps === 0 ? "0°→180°" : "180°→0°"}`,
      };
    }
    if (mode === "support" && d.key === "← →") {
      const deg = (((supportManualRotSteps % 4) + 4) % 4) * 90;
      return { key: "← →", action: `+${deg}° manual` };
    }
    return d;
  });

  patchedDefs.forEach((def, i) => {
    if (i > 0) {
      const sep = document.createElement("div");
      sep.className = "sb-sep";
      shortcutBarEl.appendChild(sep);
    }
    const item = document.createElement("div");
    item.className = "sb-item";
    item.style.animationDelay = `${i * 0.04}s`;

    const key = document.createElement("span");
    key.className = "sb-key";
    key.textContent = def.key;

    const action = document.createElement("span");
    action.className = "sb-action";
    action.textContent = def.action;

    item.appendChild(key);
    item.appendChild(action);
    shortcutBarEl.appendChild(item);
  });
}

/* =========================================================
   HUD MESSAGE
   ========================================================= */

function showHudMessage(text) {
  const existing = document.getElementById("hud-msg");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "hud-msg";
  el.textContent = text;
  Object.assign(el.style, {
    position: "fixed",
    bottom: "32px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(15,15,15,0.94)",
    border: "1px solid #cc2200",
    color: "#e8eef4",
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: "12px",
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    padding: "10px 28px",
    clipPath: "polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,0 100%)",
    zIndex: "99999",
    boxShadow: "0 0 18px rgba(204,34,0,0.3)",
    animation: "hudMsgIn 0.3s ease both",
  });
  document.body.appendChild(el);

  if (!document.getElementById("hud-kf")) {
    const s = document.createElement("style");
    s.id = "hud-kf";
    s.textContent = `@keyframes hudMsgIn{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`;
    document.head.appendChild(s);
  }

  setTimeout(() => {
    el.style.transition = "opacity 0.5s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 500);
  }, 2500);
}

/* =========================================================
   PLACEMENT RULES — POPUP VALIDATION
   ========================================================= */

function countPlaced(type) {
  let n = 0;
  scene.traverse((o) => {
    if (o.userData?.isMount && o.userData.type === type) n++;
  });
  return n;
}

function showPopup(message, actionLabel, actionFn) {
  const existing = document.getElementById("rule-popup");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "rule-popup";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "999999",
  });

  const box = document.createElement("div");
  Object.assign(box.style, {
    background: "#111111",
    border: "2px solid #cc2200",
    padding: "32px 40px",
    maxWidth: "460px",
    width: "90%",
    fontFamily: "'Share Tech Mono', monospace",
    color: "#e8eef4",
    textAlign: "center",
    clipPath: "polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%)",
    boxShadow: "0 0 40px rgba(204,34,0,0.25)",
    position: "relative",
  });

  const title = document.createElement("div");
  title.textContent = "⚠  BUILD RULE VIOLATION";
  Object.assign(title.style, {
    fontSize: "10px",
    letterSpacing: "0.2em",
    color: "#cc2200",
    marginBottom: "16px",
    fontWeight: "700",
    fontFamily: "'Orbitron', sans-serif",
  });

  const msg = document.createElement("div");
  msg.textContent = message;
  Object.assign(msg.style, {
    fontSize: "13px",
    lineHeight: "1.6",
    color: "#c0c8d0",
    marginBottom: "24px",
    letterSpacing: "0.04em",
  });

  const btnRow = document.createElement("div");
  Object.assign(btnRow.style, {
    display: "flex",
    gap: "12px",
    justifyContent: "center",
    flexWrap: "wrap",
  });

  function makeBtn(label, primary) {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      background: primary ? "#cc2200" : "transparent",
      border: "1.5px solid #cc2200",
      color: primary ? "#111111" : "#cc2200",
      fontFamily: "'Orbitron', sans-serif",
      fontSize: "10px",
      letterSpacing: "0.2em",
      padding: "8px 22px",
      cursor: "pointer",
      textTransform: "uppercase",
      transition: "background 0.15s, color 0.15s",
    });
    b.onmouseover = () => {
      b.style.background = "#cc2200";
      b.style.color = "#111111";
    };
    b.onmouseout = () => {
      b.style.background = primary ? "#cc2200" : "transparent";
      b.style.color = primary ? "#111111" : "#cc2200";
    };
    return b;
  }

  const dismissBtn = makeBtn("UNDERSTOOD", false);
  dismissBtn.onclick = () => overlay.remove();
  btnRow.appendChild(dismissBtn);

  if (actionLabel && typeof actionFn === "function") {
    const orLabel = document.createElement("span");
    orLabel.textContent = "—  or  —";
    Object.assign(orLabel.style, {
      color: "#3a2820",
      fontSize: "10px",
      alignSelf: "center",
      letterSpacing: "0.12em",
    });
    btnRow.appendChild(orLabel);

    const addBtn = makeBtn(actionLabel, true);
    addBtn.onclick = () => {
      overlay.remove();
      actionFn();
    };
    btnRow.appendChild(addBtn);
  }

  box.appendChild(title);
  box.appendChild(msg);
  box.appendChild(btnRow);
  overlay.appendChild(box);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}

/* =========================================================
   HELPERS
   ========================================================= */

function updateMouse(e) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

function makeGhost(obj) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.material = o.material.clone();
      o.material.transparent = true;
      o.material.opacity = 0.18;
    }
  });
}

function makeSolid(obj) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.material.transparent = false;
      o.material.opacity = 1;
    }
  });
}

function clearGhost() {
  document
    .querySelectorAll(".btn.active-mode")
    .forEach((b) => b.classList.remove("active-mode"));
  if (ghost) scene.remove(ghost);
  ghost = null;
  motorRotationGroup = null;
  placementMode = null;
  applySocketHighlights();
  frameOnSupportRotationSteps = 0;
  frameHoverType = "frame";

  motorAutoBaseYaw = 0;
  motorManualRotSteps = 0;

  supportManualRotSteps = 0;

  setHoverMesh(null, null);
  hideTooltip();

  frameOnSupportMarkers.forEach((m) => {
    m.material = supportFrameSocketMat;
  });

  motorAutoBaseYaw = 0;
  motorManualRotSteps = 0;

  triangleAutoBaseYaw = 0;
  triangleManualRotSteps = 0;
  if (hoveredTriangleMarker) {
    hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
    hoveredTriangleMarker.scale.setScalar(1.5);
    hoveredTriangleMarker = null;
  }

  hideInstructionPanel();
  clearQueuedIntent();
  updateShortcutBar();
  updateLegendHighlight();
  clearTimeout(idleTimer);
  if (!isFinalized) idleTimer = setTimeout(showIdleArrows, IDLE_DELAY_MS);
}

function applySocketDepth(target, socket, depth) {
  const q = new THREE.Quaternion();
  socket.getWorldQuaternion(q);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  target.position.addScaledVector(forward, depth);
}

function findMount(obj) {
  let o = obj;
  while (o) {
    if (o.userData?.isMount) return o;
    o = o.parent;
  }
  return null;
}

/* =========================================================
   MESH-LEVEL EMISSIVE HELPERS
   ========================================================= */

function resolveMeshAndMount(obj) {
  let mount = null;
  let o = obj;
  while (o) {
    if (o.userData?.isMount) {
      mount = o;
      break;
    }
    o = o.parent;
  }
  if (!mount) return { mesh: null, mount: null };
  const mesh = obj.isMesh ? obj : null;
  return { mesh, mount };
}

function setMeshEmissive(mesh, colorHex) {
  if (!mesh?.material?.emissive) return new THREE.Color(0, 0, 0);
  const prev = mesh.material.emissive.clone();
  mesh.material.emissive.set(colorHex);
  return prev;
}

function restoreMeshEmissive(mesh, savedColor) {
  if (mesh?.material?.emissive) mesh.material.emissive.copy(savedColor);
}

function getMeshesOfMount() {
  return [];
}
function setEmissiveOnMeshes() {}
let hoveredMeshes = [];
let selectedMeshes = [];

/* =========================================================
   PAGE SIZE / RESIZE HANDLER
   ========================================================= */

function onWindowResize() {
  if (!renderer) return;

  const canvas = renderer.domElement;
  const container = canvas.parentElement || canvas;
  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

/* =========================================================
   SOCKET MARKERS
   ========================================================= */

function rebuildSocketMarkers() {
  [
    ...frameMarkers,
    ...motorMarkers,
    ...triangleMarkers, // union — covers both sub-arrays
    ...frameOnSupportMarkers,
    ...wheelMarkers,
  ].forEach((m) => scene.remove(m));

  frameMarkers = [];
  motorMarkers = [];
  // ── v34: reset both sub-arrays then rebuild union at the end ──────────────
  triangleSocketMarkers = [];
  stressConnectorMarkers = [];
  triangleMarkers = [];
  // ─────────────────────────────────────────────────────────────────────────
  frameOnSupportMarkers = [];
  wheelMarkers = [];

  scene.updateMatrixWorld(true);

  // ── Proximity deactivation ────────────────────────────────────────────────
  const SOCKET_MERGE_DIST = 0.08;
  const usedPositions = [];

  scene.traverse((o) => {
    if (!o.name) return;
    if (!isSocketNode(o.name)) return;
    if (!usedSockets.has(o.uuid)) return;
    const wp = new THREE.Vector3();
    o.getWorldPosition(wp);
    usedPositions.push(wp);
  });

  if (usedPositions.length > 0) {
    scene.traverse((o) => {
      if (!o.name) return;
      if (!isSocketNode(o.name)) return;
      if (usedSockets.has(o.uuid)) return;
      const wp = new THREE.Vector3();
      o.getWorldPosition(wp);
      for (const up of usedPositions) {
        if (wp.distanceTo(up) < SOCKET_MERGE_DIST) {
          usedSockets.add(o.uuid);
          break;
        }
      }
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  scene.traverse((o) => {
    if (!o.name || usedSockets.has(o.uuid)) return;

    if (ghost && isDescendantOf(o, ghost)) return;

    if (o.name.startsWith("SOCKET_FRAME_SUPPORT")) {
      addMarker(o, frameOnSupportMarkers, supportFrameSocketMat);
      return;
    }

    if (o.name.startsWith("SOCKET_FRAME")) addMarker(o, frameMarkers, frameMat);
    if (o.name.startsWith("SOCKET_MOTOR")) addMarker(o, motorMarkers, motorMat);
    if (o.name.startsWith("WHEEL_SOCKET"))
      addMarker(o, wheelMarkers, wheelSocketMat);

    // ── v34: SOCKET_TRIANGLE → triangleSocketMarkers (triangle placement only)
    //         SOCKET_STRESS_CONNECTOR → stressConnectorMarkers (support frames only)
    if (o.name.startsWith("SOCKET_TRIANGLE"))
      addMarker(o, triangleSocketMarkers, frameMat);
    if (o.name.startsWith("SOCKET_STRESS_CONNECTOR"))
      addMarker(o, stressConnectorMarkers, frameMat);
  });

  // ── v34: rebuild union after both sub-arrays are populated ────────────────
  triangleMarkers = [...triangleSocketMarkers, ...stressConnectorMarkers];
  // ─────────────────────────────────────────────────────────────────────────
}

function isSocketNode(name) {
  return (
    name.startsWith("SOCKET_FRAME") ||
    name.startsWith("SOCKET_MOTOR") ||
    name.startsWith("WHEEL_SOCKET") ||
    name.startsWith("SOCKET_TRIANGLE") ||
    name.startsWith("SOCKET_STRESS_CONNECTOR") ||
    name.startsWith("SOCKET_STRESS_SUPPORT")
  );
}

// ── Active socket materials — INDUSTRIAL PALETTE ──────────────────────────
const MAT_FRAME_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xe8eef4 });
const MAT_FRAME_DIM = new THREE.MeshBasicMaterial({
  color: 0x2a2e32,
  transparent: true,
  opacity: 0.22,
});
const MAT_MOTOR_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xff2200 });
const MAT_MOTOR_DIM = new THREE.MeshBasicMaterial({
  color: 0x2a0a00,
  transparent: true,
  opacity: 0.18,
});
const MAT_SUPPORT_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xb0bcc8 });
const MAT_SUPPORT_DIM = new THREE.MeshBasicMaterial({
  color: 0x1e2228,
  transparent: true,
  opacity: 0.18,
});
const MAT_WHEEL_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xff3010 });
const MAT_WHEEL_DIM = new THREE.MeshBasicMaterial({
  color: 0x280a00,
  transparent: true,
  opacity: 0.18,
});
const MAT_TRI_ACTIVE = new THREE.MeshBasicMaterial({ color: 0x8090a0 });
const MAT_TRI_DIM = new THREE.MeshBasicMaterial({
  color: 0x181c20,
  transparent: true,
  opacity: 0.18,
});
const MAT_MOTOR_HOVER = new THREE.MeshBasicMaterial({ color: 0xffffff });
const MAT_TRI_HOVER = new THREE.MeshBasicMaterial({ color: 0xffffff });
// ──────────────────────────────────────────────────────────────────────────

let hoveredMotorMarker = null;

function addMarker(socket, list, mat) {
  const m = new THREE.Mesh(socketGeo, mat);
  socket.getWorldPosition(m.position);
  m.userData.socket = socket;
  list.push(m);
  scene.add(m);
}

function applySocketHighlights() {
  const mode = placementMode;

  // ── Unified frame mode: light up BOTH frame and support-frame sockets ─────
  const frameActive = mode === "frame";
  frameMarkers.forEach((m) => {
    m.material = frameActive ? MAT_FRAME_ACTIVE : MAT_FRAME_DIM;
    m.scale.setScalar(frameActive ? 1.5 : 0.7);
    m.visible = true;
  });
  frameOnSupportMarkers.forEach((m) => {
    m.material = frameActive ? MAT_SUPPORT_ACTIVE : MAT_SUPPORT_DIM;
    m.scale.setScalar(frameActive ? 1.5 : 0.7);
    m.visible = true;
  });
  // ─────────────────────────────────────────────────────────────────────────

  const motorActive = mode === "motor";
  motorMarkers.forEach((m) => {
    m.material = motorActive ? MAT_MOTOR_ACTIVE : MAT_MOTOR_DIM;
    m.scale.setScalar(motorActive ? 1.5 : 0.7);
    m.visible = true;
  });

  // triangleMarkers is the full union — both SOCKET_TRIANGLE and SOCKET_STRESS_CONNECTOR
  // are highlighted together in triangle or support mode (same visual treatment)
  const triActive = mode === "triangle" || mode === "support";
  triangleMarkers.forEach((m) => {
    m.material = triActive ? MAT_TRI_ACTIVE : MAT_TRI_DIM;
    m.scale.setScalar(triActive ? 1.5 : 0.7);
    m.visible = true;
  });

  const wheelActive = mode === "wheel";
  wheelMarkers.forEach((m) => {
    m.material = wheelActive ? MAT_WHEEL_ACTIVE : MAT_WHEEL_DIM;
    m.scale.setScalar(wheelActive ? 1.5 : 0.7);
    m.visible = true;
  });

  if (!mode) {
    [
      ...frameMarkers,
      ...motorMarkers,
      ...triangleMarkers,
      ...frameOnSupportMarkers,
      ...wheelMarkers,
    ].forEach((m) => {
      m.visible = false;
    });
  }

  hoveredMotorMarker = null;
}

/* =========================================================
   PLACEMENT MODES
   ========================================================= */

function startMotorPlacement() {
  hideIdleArrows();
  clearTimeout(idleTimer);
  if (frameMarkers.length === 0) {
    setQueuedIntent({
      mode: "motor",
      label: "Add Motor",
      requiredType: "frame",
      requiredCount: countPlaced("frame") + 1,
      intendedFn: startMotorPlacement,
    });
    showHudMessage("Place a Rect. Frame first → Motor will auto-activate");
    startFramePlacement();
    return;
  }
  document
    .querySelectorAll(".btn.active-mode")
    .forEach((b) => b.classList.remove("active-mode"));
  const _ab = document.getElementById("addMotor");
  if (_ab) _ab.classList.add("active-mode");
  clearGhost();
  placementMode = "motor";
  motorAutoBaseYaw = 0;
  motorManualRotSteps = 0;
  applySocketHighlights();
  updateShortcutBar();
  updateLegendHighlight();
  showInstructionPanel("motor");

  ghost = new THREE.Group();
  motorRotationGroup = new THREE.Group();

  const m = motorTemplate.clone(true);
  makeGhost(m);

  motorRotationGroup.add(m);
  ghost.add(motorRotationGroup);
  scene.add(ghost);
}

function startFramePlacement() {
  hideIdleArrows();
  clearTimeout(idleTimer);
  document
    .querySelectorAll(".btn.active-mode")
    .forEach((b) => b.classList.remove("active-mode"));

  const addFrameBtn = document.getElementById("addFrame");
  if (addFrameBtn) addFrameBtn.classList.add("active-mode");
  const addFrameToSupportBtn = document.getElementById("addFrameToSupport");
  if (addFrameToSupportBtn) addFrameToSupportBtn.classList.add("active-mode");

  clearGhost();
  frameOnSupportRotationSteps = 0;
  frameHoverType = "frame";
  placementMode = "frame";
  applySocketHighlights();
  updateShortcutBar();
  updateLegendHighlight();
  showInstructionPanel("frame");
  ghost = frameTemplate.clone(true);
  makeGhost(ghost);
  scene.add(ghost);
}

function startTrianglePlacement() {
  hideIdleArrows();
  clearTimeout(idleTimer);
  document
    .querySelectorAll(".btn.active-mode")
    .forEach((b) => b.classList.remove("active-mode"));
  const _ab = document.getElementById("addTriangle");
  if (_ab) _ab.classList.add("active-mode");
  clearGhost();
  placementMode = "triangle";
  applySocketHighlights();
  updateShortcutBar();
  updateLegendHighlight();
  showInstructionPanel("triangle");
  ghost = triangleTemplate.clone(true);
  makeGhost(ghost);
  scene.add(ghost);
}

/* =========================================================
   START SUPPORT PLACEMENT
   — CHANGED: now requires 2 triangular frames (was 1).
     The queued intent also targets requiredCount: 2 so the
     chain-toast progress dots correctly show 2 steps.
     Once 2 triangles are placed the support mode auto-fires.
     Placing MORE triangles after a bridge is always allowed
     because triangle placement has no upper prerequisite limit.
   ========================================================= */
function startSupportPlacement() {
  hideIdleArrows();
  clearTimeout(idleTimer);
  if (countPlaced("triangle_frame") < 2) {
    const have = countPlaced("triangle_frame");
    const need = 2 - have;
    setQueuedIntent({
      mode: "support",
      label: "Support Frame",
      requiredType: "triangle_frame",
      requiredCount: 2,
      intendedFn: startSupportPlacement,
    });
    showHudMessage(
      `Place ${need} more Tri. Frame${need !== 1 ? "s" : ""} → Support Frame auto-activates`,
    );
    startTrianglePlacement();
    return;
  }
  document
    .querySelectorAll(".btn.active-mode")
    .forEach((b) => b.classList.remove("active-mode"));
  const _ab = document.getElementById("addSupportFrame");
  if (_ab) _ab.classList.add("active-mode");
  clearGhost();
  placementMode = "support";
  applySocketHighlights();
  updateShortcutBar();
  updateLegendHighlight();
  showInstructionPanel("support");
  ghost = supportTemplate.clone(true);
  makeGhost(ghost);
  scene.add(ghost);
}

/* =========================================================
   PLACEMENT RESTART — keeps mode alive after each placement
   ========================================================= */

function restartPlacementMode(mode) {
  if (ghost) scene.remove(ghost);
  ghost = null;
  motorRotationGroup = null;

  if (mode === "motor") {
    motorAutoBaseYaw = 0;
    motorManualRotSteps = 0;
    hoveredMotorMarker = null;
  }

  if (mode === "triangle") {
    triangleAutoBaseYaw = 0;
    triangleManualRotSteps = 0;
    if (hoveredTriangleMarker) {
      hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
      hoveredTriangleMarker.scale.setScalar(1.5);
      hoveredTriangleMarker = null;
    }
  }

  if (mode === "support") {
    supportManualRotSteps = 0;
    if (hoveredTriangleMarker) {
      hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
      hoveredTriangleMarker.scale.setScalar(1.5);
      hoveredTriangleMarker = null;
    }
  }

  if (mode === "frame") {
    frameHoverType = "frame";
  }

  switch (mode) {
    case "frame":
      ghost = frameTemplate.clone(true);
      makeGhost(ghost);
      scene.add(ghost);
      break;

    case "motor":
      ghost = new THREE.Group();
      motorRotationGroup = new THREE.Group();
      const m = motorTemplate.clone(true);
      makeGhost(m);
      motorRotationGroup.add(m);
      ghost.add(motorRotationGroup);
      scene.add(ghost);
      break;

    case "triangle":
      ghost = triangleTemplate.clone(true);
      makeGhost(ghost);
      scene.add(ghost);
      break;

    case "support":
      ghost = supportTemplate.clone(true);
      makeGhost(ghost);
      scene.add(ghost);
      break;

    case "wheel":
      if (wheelTemplate) {
        ghost = wheelTemplate.clone(true);
        makeGhost(ghost);
        scene.add(ghost);
      }
      break;
  }

  rebuildSocketMarkers();
  applySocketHighlights();
  updateShortcutBar();
}

/* =========================================================
   SUPPORT FRAME — LONGITUDINAL AXIS CORRECTION  (FIX v37)
   =========================================================
   Strategy: derive the intended support-frame axis directly from
   the LINE CONNECTING THE TWO TRIANGLE MOUNT CENTRES.  That line
   is exactly the axis the support frame should run along.
   No bounding-box heuristics needed — works for any frame shape.

   For each triangle mount we pick whichever of its free
   SOCKET_STRESS_CONNECTOR sockets lies CLOSEST to the opposite
   mount's centre.  Those two sockets are the canonical "inner"
   connectors even when the user clicked an outer one.
   ========================================================= */

/**
 * Given any clicked SOCKET_STRESS_CONNECTOR, resolve the best
 * socket pair (one per triangle mount) that lies most directly
 * on the axis connecting the two triangle mounts.
 *
 * Returns { socketA, posA, socketB, posB }.
 */
/* =========================================================
   getFreeBridgeableTriangleMounts
   =========================================================
   Returns the list of triangle_frame mounts that are NOT yet
   occupied by any placed stress bridge.

   A triangle mount is considered "occupied" if any placed
   support_frame mount has a socket (socketA or socketB) that
   is a descendant of that triangle mount.

   Rule: each stress bridge consumes 1 pair of triangles.
   To place a new bridge you need exactly 2 free (unoccupied)
   triangle mounts. Adding only 1 new triangle is never enough.
   ========================================================= */
function getFreeBridgeableTriangleMounts() {
  // 1. Collect all placed triangle mounts
  const allTriangleMounts = [];
  scene.traverse((o) => {
    if (o.userData?.isMount && o.userData.type === "triangle_frame") {
      allTriangleMounts.push(o);
    }
  });

  // 2. Collect all placed support_frame mounts and their socket nodes
  const bridgeSockets = []; // flat list of socket scene-nodes used by bridges
  scene.traverse((o) => {
    if (o.userData?.isMount && o.userData.type === "support_frame") {
      if (o.userData.socket) bridgeSockets.push(o.userData.socket);
      if (o.userData.socketB) bridgeSockets.push(o.userData.socketB);
    }
  });

  // 3. A triangle mount is "occupied" if any bridge socket is a descendant of it
  function isOccupied(triangleMount) {
    return bridgeSockets.some((s) => isDescendantOrSelf(s, triangleMount));
  }

  return allTriangleMounts.filter((m) => !isOccupied(m));
}

/* =========================================================
   buildTriangleMountMap — used by resolveBestSupportSocketPair
   Only includes FREE (unoccupied) triangle mounts that still
   have at least 1 free SOCKET_STRESS_CONNECTOR socket.
   ========================================================= */
function buildTriangleMountMap() {
  const freeMounts = new Set(getFreeBridgeableTriangleMounts());
  const mountMap = new Map();

  scene.traverse((o) => {
    if (!o.name?.startsWith("SOCKET_STRESS_CONNECTOR")) return;
    if (usedSockets.has(o.uuid)) return;
    if (ghost && isDescendantOf(o, ghost)) return;

    let m = o.parent;
    while (m && !m.userData?.isMount) m = m.parent;
    // Only accept sockets on FREE triangle mounts
    if (!m || !freeMounts.has(m)) return;

    o.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    o.getWorldPosition(pos);

    if (!mountMap.has(m)) mountMap.set(m, []);
    mountMap.get(m).push({ socket: o, pos });
  });

  return mountMap;
}

/* =========================================================
   canPlaceSupportBridge
   Returns true only when there are ≥2 free (unoccupied)
   triangle mounts available — one for each end of the bridge.
   ========================================================= */
function canPlaceSupportBridge() {
  return getFreeBridgeableTriangleMounts().length >= 2;
}

function resolveBestSupportSocketPair(clickedSocket) {
  scene.updateMatrixWorld(true);
  clickedSocket.updateMatrixWorld(true);

  // ── 1. Build mount → sockets map (ghost-aware) ────────────────────────────
  const mountMap = buildTriangleMountMap();
  const mounts = [...mountMap.keys()];

  // ── Hard block: need ≥2 distinct triangle mounts ─────────────────────────
  // Never fall back to single-socket snapping — return null to block placement.
  if (mounts.length < 2) return null;

  // ── 2. Identify which mount owns the clicked socket ───────────────────────
  let clickedMount = clickedSocket.parent;
  while (clickedMount && !clickedMount.userData?.isMount)
    clickedMount = clickedMount.parent;

  // mountA = the triangle the user hovered; mountB = the closest OTHER triangle
  let mountA =
    clickedMount && mountMap.has(clickedMount) ? clickedMount : mounts[0];

  const mountCentre = (mount) =>
    new THREE.Box3().setFromObject(mount).getCenter(new THREE.Vector3());

  const centreA = mountCentre(mountA);
  let mountB = null;
  let closestDist = Infinity;
  for (const m of mounts) {
    if (m === mountA) continue;
    const d = mountCentre(m).distanceTo(centreA);
    if (d < closestDist) {
      closestDist = d;
      mountB = m;
    }
  }

  // Still couldn't find a partner (shouldn't happen given mounts.length ≥ 2)
  if (!mountB) return null;

  const centreB = mountCentre(mountB);

  // ── 3. Pick the inner-facing socket from each mount ───────────────────────
  // For mountA: socket closest to mountB's centre
  // For mountB: socket closest to mountA's centre
  const pickClosest = (arr, target) => {
    let best = arr[0];
    let bestD = best.pos.distanceTo(target);
    for (let i = 1; i < arr.length; i++) {
      const d = arr[i].pos.distanceTo(target);
      if (d < bestD) {
        bestD = d;
        best = arr[i];
      }
    }
    return best;
  };

  const entryA = pickClosest(mountMap.get(mountA), centreB);
  const entryB = pickClosest(mountMap.get(mountB), centreA);

  return {
    socketA: entryA.socket,
    posA: entryA.pos.clone(),
    socketB: entryB.socket,
    posB: entryB.pos.clone(),
  };
}

/* =========================================================
   SUPPORT FRAME 2-POINT SNAP — FIX v35 + v36
   ========================================================= */

function findOppositeTriangleSocket(socket) {
  socket.updateMatrixWorld(true);
  const posA = new THREE.Vector3();
  socket.getWorldPosition(posA);

  let mountA = socket.parent;
  while (mountA && !mountA.userData?.isMount) mountA = mountA.parent;

  let bestSocket = null;
  let bestPos = null;
  let bestDist = Infinity;

  scene.traverse((o) => {
    if (!o.name?.startsWith("SOCKET_STRESS_CONNECTOR")) return;
    if (usedSockets.has(o.uuid)) return;
    let m = o.parent;
    while (m && !m.userData?.isMount) m = m.parent;
    if (m === mountA) return;
    if (m?.userData?.type !== "triangle_frame") return;
    o.updateMatrixWorld(true);
    const wp = new THREE.Vector3();
    o.getWorldPosition(wp);
    const d = wp.distanceTo(posA);
    if (d < bestDist) {
      bestDist = d;
      bestSocket = o;
      bestPos = wp.clone();
    }
  });

  return bestSocket ? { socket: bestSocket, pos: bestPos } : null;
}

function applyTwoPointSupportSnap(
  mountGroup,
  connectorRoot,
  posA,
  posB,
  manualSteps,
) {
  // Support frames are ALWAYS flat — only Y rotation is ever applied.
  // Reset fully so world-space connector reads start clean.
  mountGroup.rotation.set(0, 0, 0);
  mountGroup.position.set(0, 0, 0);
  mountGroup.updateMatrixWorld(true);

  let connL = null,
    connR = null;
  connectorRoot.traverse((o) => {
    const n = o.name?.toUpperCase();
    if (n === "SOCKET_STRESS_SUPPORT_L") connL = o;
    if (n === "SOCKET_STRESS_SUPPORT_R") connR = o;
  });

  // Target Y: midpoint of anchor sockets, kept flat (no Y-tilt from sockets).
  const targetY = posB ? (posA.y + posB.y) / 2 : posA.y;

  if (connL && connR && posB) {
    // Read connector positions at identity rotation
    const lWorld0 = new THREE.Vector3();
    const rWorld0 = new THREE.Vector3();
    connL.getWorldPosition(lWorld0);
    connR.getWorldPosition(rWorld0);

    // All span math in XZ only — Y differences must never affect yaw
    const connSpanX = rWorld0.x - lWorld0.x;
    const connSpanZ = rWorld0.z - lWorld0.z;
    const targetSpanX = posB.x - posA.x;
    const targetSpanZ = posB.z - posA.z;

    const fromAngle = Math.atan2(connSpanX, connSpanZ);
    const toAngle = Math.atan2(targetSpanX, targetSpanZ);
    const baseYaw = toAngle - fromAngle;

    // Try both 180-degree flips; pick the one with best XZ alignment
    let bestYaw = baseYaw;
    let bestConnector = connL;
    let bestError = Infinity;

    for (const yaw of [baseYaw, baseYaw + Math.PI]) {
      mountGroup.rotation.set(0, yaw, 0); // ONLY Y rotation
      mountGroup.updateMatrixWorld(true);

      for (const [snap, other] of [
        [connL, connR],
        [connR, connL],
      ]) {
        const sW = new THREE.Vector3();
        const oW = new THREE.Vector3();
        snap.getWorldPosition(sW);
        other.getWorldPosition(oW);
        const dx = posA.x - sW.x;
        const dz = posA.z - sW.z;
        // Error computed purely in XZ plane
        const err = Math.hypot(oW.x + dx - posB.x, oW.z + dz - posB.z);
        if (err < bestError) {
          bestError = err;
          bestYaw = yaw;
          bestConnector = snap;
        }
      }
    }

    // Apply final yaw — ONLY Y axis, never X or Z
    mountGroup.rotation.set(0, bestYaw + manualSteps * (Math.PI / 2), 0);
    mountGroup.updateMatrixWorld(true);

    // Translate XZ so bestConnector aligns to posA
    const cWorld = new THREE.Vector3();
    bestConnector.getWorldPosition(cWorld);
    mountGroup.position.x += posA.x - cWorld.x;
    mountGroup.position.z += posA.z - cWorld.z;
    mountGroup.updateMatrixWorld(true);

    // Set Y: use connector midpoint, force flat
    const lW = new THREE.Vector3();
    const rW = new THREE.Vector3();
    connL.getWorldPosition(lW);
    connR.getWorldPosition(rW);
    const connMidY = (lW.y + rW.y) / 2;
    mountGroup.position.y += targetY - connMidY + SUPPORT_SNAP_Y_ADJUST;

    // Final safety clamp — ensure X and Z rotation are exactly zero
    mountGroup.rotation.set(0, mountGroup.rotation.y, 0);
    return;
  }

  // Single-connector fallback
  const firstConn = connL || connR;
  if (firstConn) {
    mountGroup.rotation.set(0, manualSteps * (Math.PI / 2), 0);
    mountGroup.updateMatrixWorld(true);
    const cWorld = new THREE.Vector3();
    firstConn.getWorldPosition(cWorld);
    mountGroup.position.x += posA.x - cWorld.x;
    mountGroup.position.y += targetY - cWorld.y + SUPPORT_SNAP_Y_ADJUST;
    mountGroup.position.z += posA.z - cWorld.z;
    mountGroup.rotation.set(0, mountGroup.rotation.y, 0);
  } else {
    mountGroup.rotation.set(0, manualSteps * (Math.PI / 2), 0);
    mountGroup.position.set(posA.x, targetY + SUPPORT_SNAP_Y_ADJUST, posA.z);
  }
}

/* =========================================================
   MOUSE MOVE
   ========================================================= */

function onMouseMove(e) {
  if (!placementMode) {
    updateMouse(e);
    raycaster.setFromCamera(mouse, camera);

    const hits = raycaster.intersectObjects(scene.children, true);

    let hitMesh = null;
    let hitMount = null;

    for (const h of hits) {
      if (
        frameMarkers.includes(h.object) ||
        motorMarkers.includes(h.object) ||
        triangleMarkers.includes(h.object) ||
        frameOnSupportMarkers.includes(h.object) ||
        wheelMarkers.includes(h.object)
      )
        continue;

      if (ghost && isDescendantOf(h.object, ghost)) continue;

      const { mesh, mount } = resolveMeshAndMount(h.object);
      if (mount) {
        hitMesh = mesh;
        hitMount = mount;
        break;
      }
    }

    setHoverMesh(hitMesh, hitMount);

    if (hitMount) {
      showTooltip(hitMount, e.clientX, e.clientY);
    } else {
      hideTooltip();
    }
    return;
  }

  if (isFinalized || !ghost) return;

  updateMouse(e);
  raycaster.setFromCamera(mouse, camera);

  // ── UNIFIED FRAME ──────────────────────────────────────────────────────────
  if (placementMode === "frame") {
    const supportHit = raycaster.intersectObjects(frameOnSupportMarkers)[0];
    if (supportHit) {
      frameHoverType = "support";
      const socket = supportHit.object.userData.socket;
      socket.updateMatrixWorld(true);
      const pos = new THREE.Vector3();
      socket.getWorldPosition(pos);

      const localY = getFrameSupportSocketLocalY();

      ghost.position.set(
        pos.x,
        pos.y - localY + FRAME_ON_SUPPORT_Y_OFFSET,
        pos.z,
      );
      ghost.rotation.set(0, frameOnSupportRotationSteps * (Math.PI / 2), 0);
      return;
    }

    if (frameMarkers.length === 0) {
      frameHoverType = "frame";
      const groundPlane = new THREE.Plane(
        new THREE.Vector3(0, 1, 0),
        -baseFrameYLevel,
      );
      const target = new THREE.Vector3();
      raycaster.ray.intersectPlane(groundPlane, target);
      if (target) {
        ghost.position.set(target.x, baseFrameYLevel, target.z);
        ghost.rotation.set(0, 0, 0);
      }
      return;
    }

    const frameHit = raycaster.intersectObjects(frameMarkers)[0];
    if (!frameHit) return;

    frameHoverType = "frame";
    const socket = frameHit.object.userData.socket;
    const { mountPos } = computeFrameSnapPosition(socket);
    ghost.position.copy(mountPos);
    ghost.rotation.set(0, 0, 0);
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (placementMode === "wheel") {
    const hit = raycaster.intersectObjects(wheelMarkers)[0];
    if (!hit) return;
    const socket = hit.object.userData.socket;
    socket.updateMatrixWorld(true);
    ghost.matrix.copy(socket.matrixWorld);
    ghost.matrix.decompose(ghost.position, ghost.quaternion, ghost.scale);
    return;
  }

  // ── MOTOR ──────────────────────────────────────────────────────────────────
  if (placementMode === "motor") {
    const hit = raycaster.intersectObjects(motorMarkers)[0];

    if (hoveredMotorMarker && hoveredMotorMarker !== hit?.object) {
      hoveredMotorMarker.material = MAT_MOTOR_ACTIVE;
      hoveredMotorMarker.scale.setScalar(1.5);
      hoveredMotorMarker = null;
    }

    if (!hit) return;

    const socket = hit.object.userData.socket;
    socket.updateMatrixWorld(true);

    if (hit.object !== hoveredMotorMarker) {
      hoveredMotorMarker = hit.object;
      hoveredMotorMarker.material = MAT_MOTOR_HOVER;
      hoveredMotorMarker.scale.setScalar(2.0);
    }

    const socketWorldPos = new THREE.Vector3();
    socket.getWorldPosition(socketWorldPos);

    const autoYaw = computeMotorAutoYaw(socket);
    motorAutoBaseYaw = autoYaw;

    const finalYaw = motorAutoBaseYaw + motorManualRotSteps * (Math.PI / 2);

    ghost.position.copy(socketWorldPos);
    ghost.rotation.set(0, finalYaw, 0);
    motorRotationGroup.rotation.set(0, 0, 0);

    applySocketDepth(ghost, socket, 0.05);
    return;
  }

  // ── SUPPORT — raycast ONLY against stressConnectorMarkers ─────────────────
  // v38: Hard gate — if fewer than 2 distinct triangle mounts have free
  // stress-connector sockets, hide the ghost and bail out entirely.
  if (placementMode === "support") {
    const targets = stressConnectorMarkers;

    // Upfront check: do we even have a valid pair available?
    if (!canPlaceSupportBridge()) {
      // Reset any hovered marker and park ghost off-screen
      if (hoveredTriangleMarker) {
        hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
        hoveredTriangleMarker.scale.setScalar(1.5);
        hoveredTriangleMarker = null;
      }
      if (ghost) ghost.position.set(0, -9999, 0);
      return;
    }

    const hit = raycaster.intersectObjects(targets)[0];

    if (hoveredTriangleMarker && hoveredTriangleMarker !== hit?.object) {
      hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
      hoveredTriangleMarker.scale.setScalar(1.5);
      hoveredTriangleMarker = null;
      supportManualRotSteps = 0;
      updateShortcutBar();
    }

    if (!hit) return;

    const rawSocket = hit.object.userData.socket;
    rawSocket.updateMatrixWorld(true);

    if (hit.object !== hoveredTriangleMarker) {
      hoveredTriangleMarker = hit.object;
      hoveredTriangleMarker.material = MAT_TRI_HOVER;
      hoveredTriangleMarker.scale.setScalar(2.0);
      supportManualRotSteps = 0;
      updateShortcutBar();
    }

    // Resolve the best-aligned socket pair regardless of which socket was hovered.
    // Returns null when fewer than 2 distinct triangle mounts are available —
    // in that case we hide the ghost and show a warning rather than snapping wrongly.
    const pair = resolveBestSupportSocketPair(rawSocket);
    if (!pair) {
      // Not enough triangle mounts — hide ghost, warn user
      ghost.position.set(0, -9999, 0); // move off-screen
      showHudMessage(
        "⚠ Need 2 Triangular Frames from different mounts to place a bridge",
      );
      return;
    }
    const { posA, posB } = pair;

    ghost.position.set(0, 0, 0);
    ghost.rotation.set(0, 0, 0);
    ghost.scale.set(1, 1, 1);
    ghost.updateMatrixWorld(true);

    applyTwoPointSupportSnap(ghost, ghost, posA, posB, supportManualRotSteps);
    return;
  }

  // ── TRIANGLE — raycast ONLY against triangleSocketMarkers (SOCKET_TRIANGLE) ──
  const targets = triangleSocketMarkers;

  const hit = raycaster.intersectObjects(targets)[0];

  if (hoveredTriangleMarker && hoveredTriangleMarker !== hit?.object) {
    hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
    hoveredTriangleMarker.scale.setScalar(1.5);
    hoveredTriangleMarker = null;
    triangleManualRotSteps = 0;
    updateShortcutBar();
  }

  if (!hit) return;

  const socket = hit.object.userData.socket;
  socket.updateMatrixWorld(true);

  if (hit.object !== hoveredTriangleMarker) {
    hoveredTriangleMarker = hit.object;
    hoveredTriangleMarker.material = MAT_TRI_HOVER;
    hoveredTriangleMarker.scale.setScalar(2.0);
    triangleManualRotSteps = 0;
    triangleAutoBaseYaw = computeTriangleAutoYaw(socket);
    updateShortcutBar();
  }

  const socketWorldPos = new THREE.Vector3();
  socket.getWorldPosition(socketWorldPos);

  const finalYaw = triangleAutoBaseYaw + triangleManualRotSteps * Math.PI;

  ghost.position.copy(socketWorldPos);
  ghost.rotation.set(0, finalYaw, 0);
  ghost.position.y = socketWorldPos.y + TRIANGLE_FRAME_Y_OFFSET;
  ghost.scale.set(1, 1, 1);
}

/* =========================================================
   CLICK HANDLER — persistent placement mode
   ========================================================= */

function onClick(e) {
  if (isFinalized) return;

  updateMouse(e);
  raycaster.setFromCamera(mouse, camera);

  // ── BROWSE MODE: select parts ──────────────────────────────────────────
  if (!placementMode) {
    const hits = raycaster.intersectObjects(scene.children, true);
    for (const h of hits) {
      if (
        frameMarkers.includes(h.object) ||
        motorMarkers.includes(h.object) ||
        triangleMarkers.includes(h.object) ||
        frameOnSupportMarkers.includes(h.object) ||
        wheelMarkers.includes(h.object)
      )
        continue;
      if (ghost && isDescendantOf(h.object, ghost)) continue;

      const { mesh, mount } = resolveMeshAndMount(h.object);
      if (mount) {
        selectMesh(mesh, mount);
        return;
      }
    }
    selectMesh(null, null);
    return;
  }

  // ── UNIFIED FRAME ────────────────────────────────────────────────────────
  if (placementMode === "frame") {
    const supportHit = raycaster.intersectObjects(frameOnSupportMarkers)[0];
    if (supportHit) {
      const socket = supportHit.object.userData.socket;
      if (!usedSockets.has(socket.uuid)) {
        placeFrameOnSupport(socket, frameOnSupportRotationSteps);
        frameOnSupportRotationSteps = 0;
        frameHoverType = "frame";
        restartPlacementMode("frame");
        checkQueuedIntent();
      }
      return;
    }

    if (frameMarkers.length === 0) {
      placeFrameAtPosition(ghost.position.x, ghost.position.z);
      restartPlacementMode("frame");
      checkQueuedIntent();
      return;
    }

    const frameHit = raycaster.intersectObjects(frameMarkers)[0];
    if (!frameHit) return;
    const socket = frameHit.object.userData.socket;
    if (usedSockets.has(socket.uuid)) return;
    placeFrame(socket);
    restartPlacementMode("frame");
    checkQueuedIntent();
    return;
  }

  // ── SUPPORT BRIDGE — use resolveBestSupportSocketPair for correct axis snap
  // v36: always resolve to the best-aligned pair, no matter which socket was clicked
  if (placementMode === "support") {
    // Hard gate — must have ≥2 distinct triangle mounts with free sockets
    if (!canPlaceSupportBridge()) {
      showHudMessage(
        "⚠ Need 2 Triangular Frames on separate mounts to place a bridge",
      );
      return;
    }

    const hit = raycaster.intersectObjects(stressConnectorMarkers)[0];
    if (!hit) return;

    const rawSocket = hit.object.userData.socket;

    // Resolve best pair — returns null if fewer than 2 distinct triangle mounts
    const pair = resolveBestSupportSocketPair(rawSocket);
    if (!pair) {
      showHudMessage(
        "⚠ Need 2 Triangular Frames on different mounts to place a bridge",
      );
      return;
    }
    const { socketA, posA, socketB, posB } = pair;

    if (usedSockets.has(socketA.uuid)) return;
    if (socketB && usedSockets.has(socketB.uuid)) return;

    placeSupportBridgeFromPair(
      socketA,
      posA,
      socketB,
      posB,
      supportManualRotSteps,
    );
    restartPlacementMode("support");
    checkQueuedIntent();
    return;
  }

  // ── WHEEL ──────────────────────────────────────────────────────────────
  if (placementMode === "wheel") {
    const hit = raycaster.intersectObjects(wheelMarkers)[0];
    if (!hit) return;
    const socket = hit.object.userData.socket;
    if (usedSockets.has(socket.uuid)) return;
    placeWheel(socket);

    rebuildSocketMarkers();
    applySocketHighlights();

    if (wheelMarkers.length === 0) {
      showHudMessage("All wheel sockets occupied — exiting placement");
      clearGhost();
    } else {
      restartPlacementMode("wheel");
    }
    checkQueuedIntent();
    return;
  }

  // ── MOTOR ──────────────────────────────────────────────────────────────
  if (placementMode === "motor") {
    const hit = raycaster.intersectObjects(motorMarkers)[0];
    if (!hit) return;
    const socket = hit.object.userData.socket;
    if (usedSockets.has(socket.uuid)) return;

    placeMotor(socket, motorAutoBaseYaw, motorManualRotSteps);

    rebuildSocketMarkers();
    applySocketHighlights();

    if (motorMarkers.length === 0) {
      showHudMessage("All motor sockets occupied — exiting placement");
      clearGhost();
    } else {
      restartPlacementMode("motor");
    }
    checkQueuedIntent();
    return;
  }

  // ── TRIANGLE — ONLY triangleSocketMarkers (SOCKET_TRIANGLE) ───────────────
  if (placementMode === "triangle") {
    const hit = raycaster.intersectObjects(triangleSocketMarkers)[0];
    if (!hit) return;
    const socket = hit.object.userData.socket;
    if (usedSockets.has(socket.uuid)) return;
    placeTriangle(socket, triangleAutoBaseYaw, triangleManualRotSteps);
    restartPlacementMode("triangle");
    checkQueuedIntent();
    return;
  }
}

/* =========================================================
   PLACE FUNCTIONS
   ========================================================= */

function placeFrameAtPosition(x, z) {
  const frame = frameTemplate.clone(true);
  makeSolid(frame);

  const mount = new THREE.Group();
  mount.userData = { isMount: true, type: "frame" };
  mount.position.set(x, baseFrameYLevel, z);
  mount.rotation.set(0, 0, 0);
  mount.add(frame);
  scene.add(mount);
  addToInventory("frame");
  pushUndo(mount, [], "frame");
}

function placeFrame(socket) {
  if (usedSockets.has(socket.uuid)) return;

  const clickedSuffix = socket.name
    .replace(/^SOCKET_FRAME_/i, "")
    .toUpperCase();
  const snapSuffix = OPPOSITE_SOCKET_SUFFIX[clickedSuffix] ?? null;
  const snapSocketName = snapSuffix ? `SOCKET_FRAME_${snapSuffix}` : null;

  const { mountPos } = computeFrameSnapPosition(socket);

  const frame = frameTemplate.clone(true);
  makeSolid(frame);

  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "frame" };
  mount.rotation.set(0, 0, 0);
  mount.position.copy(mountPos);
  mount.add(frame);
  scene.add(mount);

  scene.updateMatrixWorld(true);

  usedSockets.add(socket.uuid);
  const usedUuids = [socket.uuid];

  let snapFound = false;
  mount.traverse((o) => {
    if (snapFound) return;
    if (!o.name) return;
    if (o.name.toUpperCase().startsWith("SOCKET_FRAME_SUPPORT")) return;
    if (
      snapSocketName &&
      o.name.toUpperCase() === snapSocketName.toUpperCase()
    ) {
      usedSockets.add(o.uuid);
      usedUuids.push(o.uuid);
      snapFound = true;
    }
  });

  if (!snapFound) {
    const clickedPos = new THREE.Vector3();
    socket.getWorldPosition(clickedPos);
    let closestUuid = null;
    let closestDist = Infinity;
    mount.traverse((o) => {
      if (!o.name) return;
      if (!o.name.toUpperCase().startsWith("SOCKET_FRAME")) return;
      if (o.name.toUpperCase().startsWith("SOCKET_FRAME_SUPPORT")) return;
      const wp = new THREE.Vector3();
      o.getWorldPosition(wp);
      const d = wp.distanceTo(clickedPos);
      if (d < closestDist) {
        closestDist = d;
        closestUuid = o.uuid;
      }
    });
    if (closestUuid) {
      usedSockets.add(closestUuid);
      usedUuids.push(closestUuid);
    }
  }

  addToInventory("frame");
  pushUndo(mount, usedUuids, "frame");
}

/* =========================================================
   MOTOR PLACEMENT
   ========================================================= */

function placeMotor(socket, autoBaseYaw = 0, manualSteps = 0) {
  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "motor" };

  socket.updateMatrixWorld(true);

  const socketPos = new THREE.Vector3();
  socket.getWorldPosition(socketPos);

  const finalYaw = autoBaseYaw + manualSteps * (Math.PI / 2);

  mount.position.copy(socketPos);
  mount.rotation.set(0, finalYaw, 0);

  applySocketDepth(mount, socket, 0.05);

  const solidRotGroup = new THREE.Group();
  const solidMotor = motorTemplate.clone(true);
  makeSolid(solidMotor);
  solidRotGroup.add(solidMotor);
  mount.add(solidRotGroup);

  scene.add(mount);
  usedSockets.add(socket.uuid);
  addToInventory("motor");
  pushUndo(mount, [socket.uuid], "motor");
}

/* =========================================================
   WHEEL PLACEMENT
   ========================================================= */

function startWheelPlacement() {
  hideIdleArrows();
  clearTimeout(idleTimer);
  if (countPlaced("motor") < 1) {
    setQueuedIntent({
      mode: "wheel",
      label: "Add Wheel",
      requiredType: "motor",
      requiredCount: 1,
      intendedFn: startWheelPlacement,
    });
    showHudMessage("Place a Motor first → Wheel placement auto-activates");
    startMotorPlacement();
    return;
  }
  if (wheelMarkers.length === 0) {
    showHudMessage("⚠ All wheel sockets are occupied");
    return;
  }
  document
    .querySelectorAll(".btn.active-mode")
    .forEach((b) => b.classList.remove("active-mode"));
  const _ab = document.getElementById("addWheelBtn");
  if (_ab) _ab.classList.add("active-mode");

  clearGhost();
  placementMode = "wheel";
  applySocketHighlights();
  updateShortcutBar();
  updateLegendHighlight();
  showInstructionPanel("wheel");

  if (!wheelTemplate) {
    console.warn("Wheel template not loaded yet");
    return;
  }

  ghost = wheelTemplate.clone(true);
  makeGhost(ghost);
  scene.add(ghost);
}

function placeWheel(socket) {
  if (!wheelTemplate) return;

  const wheel = wheelTemplate.clone(true);
  makeSolid(wheel);

  socket.updateMatrixWorld(true);

  const socketPos = new THREE.Vector3();
  const socketQuat = new THREE.Quaternion();
  socket.getWorldPosition(socketPos);
  socket.getWorldQuaternion(socketQuat);

  let connector = null;
  wheel.traverse((o) => {
    if (o.name && o.name.toUpperCase() === "MOTOR_CONNECTOR") connector = o;
  });

  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "wheel" };

  mount.quaternion.copy(socketQuat);

  if (connector) {
    mount.position.set(0, 0, 0);
    mount.add(wheel);
    scene.add(mount);
    mount.updateMatrixWorld(true);

    const connectorWorldPos = new THREE.Vector3();
    connector.getWorldPosition(connectorWorldPos);

    mount.position.x += socketPos.x - connectorWorldPos.x;
    mount.position.y += socketPos.y - connectorWorldPos.y;
    mount.position.z += socketPos.z - connectorWorldPos.z;
  } else {
    console.warn("Wheel: MOTOR_CONNECTOR socket not found in wheel.glb");
    mount.position.copy(socketPos);
    mount.add(wheel);
    scene.add(mount);
  }

  usedSockets.add(socket.uuid);
  addToInventory("wheel");
  pushUndo(mount, [socket.uuid], "wheel");
  rebuildSocketMarkers();
  applySocketHighlights();
}

function placeTriangle(socket, autoBaseYaw = 0, manualSteps = 0) {
  const triangle = triangleTemplate.clone(true);
  makeSolid(triangle);

  let connector = null;
  triangle.traverse((o) => {
    if (o.name === "SOCKET_FRAME_CONNECTOR") connector = o;
  });

  socket.updateMatrixWorld(true);

  const socketPos = new THREE.Vector3();
  socket.getWorldPosition(socketPos);

  const finalYaw = autoBaseYaw + manualSteps * Math.PI;

  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "triangle_frame" };

  mount.rotation.set(0, finalYaw, 0);

  if (connector) {
    mount.position.set(0, 0, 0);
    mount.add(triangle);
    scene.add(mount);
    mount.updateMatrixWorld(true);

    const connectorWorldPos = new THREE.Vector3();
    connector.getWorldPosition(connectorWorldPos);

    mount.position.x += socketPos.x - connectorWorldPos.x;
    mount.position.y = socketPos.y + TRIANGLE_FRAME_Y_OFFSET;
    mount.position.z += socketPos.z - connectorWorldPos.z;
  } else {
    mount.position.set(
      socketPos.x,
      socketPos.y + TRIANGLE_FRAME_Y_OFFSET,
      socketPos.z,
    );
    mount.add(triangle);
    scene.add(mount);
  }

  usedSockets.add(socket.uuid);
  addToInventory("triangle_frame");
  pushUndo(mount, [socket.uuid], "triangle_frame");
}

/* =========================================================
   PLACE RECTANGULAR FRAME ON SUPPORT FRAME
   ========================================================= */

function placeFrameOnSupport(socket, rotationSteps) {
  socket.updateMatrixWorld(true);
  const posSupA = new THREE.Vector3();
  socket.getWorldPosition(posSupA);

  let parentMount = socket.parent;
  while (parentMount && !parentMount.userData?.isMount)
    parentMount = parentMount.parent;

  let siblingSocket = null;
  let posSupB = null;
  if (parentMount) {
    parentMount.updateMatrixWorld(true);
    let bestDist = -1;
    parentMount.traverse((o) => {
      if (!o.name?.startsWith("SOCKET_FRAME_SUPPORT")) return;
      if (o.uuid === socket.uuid) return;
      const wp = new THREE.Vector3();
      o.getWorldPosition(wp);
      const d = wp.distanceTo(posSupA);
      if (d > bestDist) {
        bestDist = d;
        siblingSocket = o;
        posSupB = wp.clone();
      }
    });
  }

  const frame = frameTemplate.clone(true);
  makeSolid(frame);

  frame.position.set(0, 0, 0);
  frame.rotation.set(0, 0, 0);
  frame.scale.set(1, 1, 1);
  frame.updateMatrixWorld(true);

  const rectConnectors = [];
  frame.traverse((o) => {
    if (!o.name) return;
    const n = o.name.toUpperCase();
    if (n.startsWith("SOCKET_FRAME_SUPPORT")) {
      const wp = new THREE.Vector3();
      o.getWorldPosition(wp);
      rectConnectors.push({ name: o.name, x: wp.x, y: wp.y, z: wp.z });
    }
  });

  if (rectConnectors.length === 0) {
    const mount = new THREE.Group();
    mount.userData = { isMount: true, socket, type: "frame" };
    mount.rotation.set(0, rotationSteps * (Math.PI / 2), 0);
    const localY = getFrameSupportSocketLocalY();
    mount.position.set(
      posSupA.x,
      posSupA.y - localY + FRAME_ON_SUPPORT_Y_OFFSET,
      posSupA.z,
    );
    mount.add(frame);
    scene.add(mount);
    usedSockets.add(socket.uuid);
    if (siblingSocket) usedSockets.add(siblingSocket.uuid);
    addToInventory("frame");
    const uuids = [socket.uuid];
    if (siblingSocket) uuids.push(siblingSocket.uuid);
    pushUndo(mount, uuids, "frame");
    return;
  }

  const candidateAngles = [];
  if (posSupB) {
    const axisAngle = Math.atan2(posSupB.x - posSupA.x, posSupB.z - posSupA.z);
    for (let i = 0; i < 4; i++)
      candidateAngles.push(axisAngle + (i * Math.PI) / 2);
  } else {
    for (let i = 0; i < 4; i++) candidateAngles.push((i * Math.PI) / 2);
  }

  let bestError = Infinity;
  let bestAngle = 0;
  let bestSnapConn = rectConnectors[0];

  for (const snapConn of rectConnectors) {
    for (const angle of candidateAngles) {
      const cos = Math.cos(angle),
        sin = Math.sin(angle);
      const rsX = cos * snapConn.x + sin * snapConn.z;
      const rsZ = -sin * snapConn.x + cos * snapConn.z;
      const mX = posSupA.x - rsX;
      const mZ = posSupA.z - rsZ;

      let error = 0;
      if (posSupB) {
        let minDist = Infinity;
        for (const c2 of rectConnectors) {
          if (c2 === snapConn) continue;
          const c2wX = mX + cos * c2.x + sin * c2.z;
          const c2wZ = mZ + (-sin * c2.x + cos * c2.z);
          const d = Math.hypot(c2wX - posSupB.x, c2wZ - posSupB.z);
          if (d < minDist) minDist = d;
        }
        error = minDist;
      }

      if (error < bestError) {
        bestError = error;
        bestAngle = angle;
        bestSnapConn = snapConn;
      }
    }
  }

  const finalAngle = bestAngle + rotationSteps * (Math.PI / 2);
  const cos = Math.cos(finalAngle),
    sin = Math.sin(finalAngle);

  const rsX = cos * bestSnapConn.x + sin * bestSnapConn.z;
  const rsZ = -sin * bestSnapConn.x + cos * bestSnapConn.z;

  const finalMountX = posSupA.x - rsX;
  const finalMountY = posSupA.y - bestSnapConn.y + FRAME_ON_SUPPORT_Y_OFFSET;
  const finalMountZ = posSupA.z - rsZ;

  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "frame" };
  mount.rotation.set(0, finalAngle, 0);
  mount.position.set(finalMountX, finalMountY, finalMountZ);
  mount.add(frame);
  scene.add(mount);
  mount.updateMatrixWorld(true);

  usedSockets.add(socket.uuid);
  if (siblingSocket) usedSockets.add(siblingSocket.uuid);
  addToInventory("frame");
  const fosUuids = [socket.uuid];
  if (siblingSocket) fosUuids.push(siblingSocket.uuid);
  pushUndo(mount, fosUuids, "frame");
}

/* =========================================================
   SUPPORT FRAME BRIDGE — ORIGINAL (kept for compatibility)
   ========================================================= */

function placeSupportBridge(socket, manualSteps = 0) {
  const support = supportTemplate.clone(true);
  makeSolid(support);

  socket.updateMatrixWorld(true);
  const posA = new THREE.Vector3();
  socket.getWorldPosition(posA);

  const opposite = findOppositeTriangleSocket(socket);
  const posB = opposite?.pos ?? null;
  const socketB = opposite?.socket ?? null;

  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, socketB, type: "support_frame" };

  mount.position.set(0, 0, 0);
  mount.rotation.set(0, 0, 0);
  mount.add(support);
  scene.add(mount);
  mount.updateMatrixWorld(true);

  applyTwoPointSupportSnap(mount, support, posA, posB, manualSteps);

  usedSockets.add(socket.uuid);
  if (socketB) usedSockets.add(socketB.uuid);
  addToInventory("support_frame");
  pushUndo(
    mount,
    socketB ? [socket.uuid, socketB.uuid] : [socket.uuid],
    "support_frame",
  );
}

/* =========================================================
   SUPPORT FRAME BRIDGE — v36: from pre-resolved pair
   =========================================================
   Called from onClick after resolveBestSupportSocketPair has
   already determined the correct socketA / posA / socketB / posB.
   ========================================================= */

function placeSupportBridgeFromPair(
  socketA,
  posA,
  socketB,
  posB,
  manualSteps = 0,
) {
  const support = supportTemplate.clone(true);
  makeSolid(support);

  const mount = new THREE.Group();
  mount.userData = {
    isMount: true,
    socket: socketA,
    socketB: socketB ?? null,
    type: "support_frame",
  };

  mount.position.set(0, 0, 0);
  mount.rotation.set(0, 0, 0);
  mount.add(support);
  scene.add(mount);
  mount.updateMatrixWorld(true);

  applyTwoPointSupportSnap(mount, support, posA, posB, manualSteps);

  usedSockets.add(socketA.uuid);
  if (socketB) usedSockets.add(socketB.uuid);
  addToInventory("support_frame");
  pushUndo(
    mount,
    socketB ? [socketA.uuid, socketB.uuid] : [socketA.uuid],
    "support_frame",
  );
}

/* =========================================================
   SINGLE-MESH HOVER & SELECTION
   ========================================================= */

function isDescendantOf(obj, ancestor) {
  let o = obj;
  while (o) {
    if (o === ancestor) return true;
    o = o.parent;
  }
  return false;
}

function setHoverMesh(mesh, mount) {
  if (hoveredMesh === mesh) {
    hoveredMount = mount;
    return;
  }

  if (hoveredMesh && hoveredMesh !== selectedMesh) {
    restoreMeshEmissive(hoveredMesh, hoveredOrigEm);
  }

  hoveredMesh = mesh;
  hoveredMount = mount;

  if (hoveredMesh) {
    if (hoveredMesh === selectedMesh) {
      hoveredOrigEm.copy(selectedOrigEm);
    } else {
      hoveredOrigEm = setMeshEmissive(hoveredMesh, 0x1a1a1a);
    }
  }
}

function selectMesh(mesh, mount) {
  if (selectedMesh === mesh) {
    restoreMeshEmissive(selectedMesh, selectedOrigEm);
    selectedMesh = null;
    selectedMount = null;
    return;
  }

  if (selectedMesh) {
    if (selectedMesh === hoveredMesh) {
      restoreMeshEmissive(selectedMesh, selectedOrigEm);
      setMeshEmissive(selectedMesh, 0x1a1a1a);
    } else {
      restoreMeshEmissive(selectedMesh, selectedOrigEm);
    }
    selectedMesh = null;
  }

  selectedMount = mount;
  selectedMesh = mesh;

  if (selectedMesh) {
    if (selectedMesh === hoveredMesh) {
      selectedOrigEm = hoveredOrigEm.clone();
    } else {
      selectedOrigEm = setMeshEmissive(selectedMesh, 0x2a1a10);
    }
    if (selectedMesh?.material?.emissive) {
      selectedMesh.material.emissive.set(0x2a1a10);
    }
  }
}

/* =========================================================
   UNDO
   ========================================================= */

function performUndo() {
  if (undoStack.length === 0) {
    showHudMessage("NOTHING TO UNDO");
    return;
  }

  const { mount, socketUuids, type } = undoStack.pop();

  if (selectedMount === mount) {
    restoreMeshEmissive(selectedMesh, selectedOrigEm);
    selectedMesh = null;
    selectedMount = null;
  }
  if (hoveredMount === mount) {
    restoreMeshEmissive(hoveredMesh, hoveredOrigEm);
    hoveredMesh = null;
    hoveredMount = null;
  }

  socketUuids.forEach((uuid) => usedSockets.delete(uuid));

  scene.remove(mount);
  removeFromInventory(type);

  rebuildSocketMarkers();
  applySocketHighlights();

  showHudMessage("UNDO ✓");
}

/* =========================================================
   KEYBOARD HANDLER
   ========================================================= */

function onKeyDown(e) {
  // ── Block F5 (accidental refresh) — v35 ──────────────────────────────────
  if (e.key === "F5") {
    e.preventDefault();
    e.stopPropagation();
    showHudMessage("USE CTRL+R OR BROWSER REFRESH TO RELOAD");
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (isFinalized) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    performUndo();
    return;
  }

  if (e.key === "Escape") {
    if (placementMode) {
      clearGhost();
    } else if (selectedMount) {
      restoreMeshEmissive(selectedMesh, selectedOrigEm);
      selectedMesh = null;
      selectedMount = null;
    }
    return;
  }

  // ── ARROW KEYS: rotation in placement modes ───────────────────────────────
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (!placementMode) return;
    e.preventDefault();

    const dir = e.key === "ArrowRight" ? 1 : -1;

    if (placementMode === "motor") {
      motorManualRotSteps += dir;
      const totalDeg = (((motorManualRotSteps % 4) + 4) % 4) * 90;
      showHudMessage(`Motor manual offset: +${totalDeg}°`);
      updateShortcutBar();
      if (ghost) {
        const finalYaw = motorAutoBaseYaw + motorManualRotSteps * (Math.PI / 2);
        ghost.rotation.set(0, finalYaw, 0);
        motorRotationGroup.rotation.set(0, 0, 0);
      }
    }

    if (placementMode === "triangle" && ghost) {
      triangleManualRotSteps = (triangleManualRotSteps + 1) % 2;
      const totalDeg = triangleManualRotSteps * 180;
      showHudMessage(`Triangle manual offset: +${totalDeg}°`);
      updateShortcutBar();
      ghost.rotation.set(
        0,
        triangleAutoBaseYaw + triangleManualRotSteps * Math.PI,
        0,
      );
    }

    if (placementMode === "support" && ghost) {
      supportManualRotSteps += dir;
      const totalDeg = (((supportManualRotSteps % 4) + 4) % 4) * 90;
      showHudMessage(`Support manual offset: +${totalDeg}°`);
      updateShortcutBar();

      if (hoveredTriangleMarker) {
        const rawSocket = hoveredTriangleMarker.userData.socket;
        rawSocket.updateMatrixWorld(true);

        // Use the best pair for the ghost preview too — guard against null
        const pair = resolveBestSupportSocketPair(rawSocket);
        if (!pair) return;
        const { posA, posB } = pair;

        ghost.position.set(0, 0, 0);
        ghost.rotation.set(0, 0, 0);
        ghost.scale.set(1, 1, 1);
        ghost.updateMatrixWorld(true);

        applyTwoPointSupportSnap(
          ghost,
          ghost,
          posA,
          posB,
          supportManualRotSteps,
        );
      }
    }

    if (placementMode === "frame") {
      frameOnSupportRotationSteps += dir;
      const deg = (((frameOnSupportRotationSteps % 4) + 4) % 4) * 90;
      showHudMessage(`Frame rotation on support: ${deg}°`);
      updateShortcutBar();
      if (ghost && frameHoverType === "support") {
        ghost.rotation.set(0, frameOnSupportRotationSteps * (Math.PI / 2), 0);
      }
    }
  }

  if (e.key === "Numpad1" || (e.key === "1" && e.altKey))
    applyCameraPreset("front");
  if (e.key === "Numpad3" || (e.key === "3" && e.altKey))
    applyCameraPreset("right");
  if (e.key === "Numpad7" || (e.key === "7" && e.altKey))
    applyCameraPreset("top");
  if (e.key === "Numpad5" || (e.key === "5" && e.altKey))
    applyCameraPreset("iso");
  if (e.key === "Numpad0" || (e.key === "0" && e.altKey))
    applyCameraPreset("perspective");

  // ── DELETE with dependency check ──────────────────────────────────────────
  if ((e.key === "Delete" || e.key === "Backspace") && selectedMount) {
    const mountToDelete = selectedMount;

    const result = checkDeletionAllowed(mountToDelete);

    if (!result.ok) {
      showDependencyBlockedPopup(mountToDelete, result);
      return;
    }

    const { socket, socketB, type } = mountToDelete.userData;

    restoreMeshEmissive(selectedMesh, selectedOrigEm);
    selectedMesh = null;
    selectedMount = null;

    if (hoveredMount === mountToDelete) {
      restoreMeshEmissive(hoveredMesh, hoveredOrigEm);
      hoveredMesh = null;
      hoveredMount = null;
    }

    usedSockets.delete(socket?.uuid);
    if (socketB) usedSockets.delete(socketB.uuid);

    for (const entry of undoStack) {
      if (entry.mount === mountToDelete) {
        entry.socketUuids.forEach((uuid) => usedSockets.delete(uuid));
      }
    }

    scene.remove(mountToDelete);

    removeFromInventory(type);
    rebuildSocketMarkers();
    applySocketHighlights();
  }
}

/* =========================================================
   COLOR LEGEND — interactive, mode-aware
   ========================================================= */

const LEGEND_MODE_MAP = {
  frame: ["white", "steel"],
  motor: ["red"],
  triangle: ["grey"],
  support: ["grey"],
  wheel: ["hotred"],
};

function initColorLegend() {
  const legend = document.getElementById("colorLegend");
  const toggleBtn = document.getElementById("legendToggle");
  if (!legend) return;

  toggleBtn?.addEventListener("click", () => {
    legend.classList.toggle("collapsed");
    toggleBtn.title = legend.classList.contains("collapsed")
      ? "Expand"
      : "Collapse";
  });

  legend.querySelectorAll(".legend-item").forEach((el, i) => {
    el.style.animationDelay = `${0.05 + i * 0.06}s`;
  });
}

function updateLegendHighlight() {
  const legend = document.getElementById("colorLegend");
  if (!legend) return;

  const relevantColors = placementMode ? LEGEND_MODE_MAP[placementMode] : null;

  if (!relevantColors || relevantColors.length === 0) {
    legend.classList.remove("mode-active");
    legend
      .querySelectorAll(".legend-item")
      .forEach((el) => el.classList.remove("legend-relevant"));
    return;
  }

  legend.classList.add("mode-active");
  legend.querySelectorAll(".legend-item").forEach((el) => {
    const strong = el.querySelector("strong");
    const colorWord = strong?.textContent?.trim().toUpperCase();
    const colorMap = {
      WHITE: "white",
      RED: "red",
      GREY: "grey",
      STEEL: "steel",
      "HOT RED": "hotred",
    };
    el.classList.toggle(
      "legend-relevant",
      relevantColors.includes(colorMap[colorWord]),
    );
  });
}

/* =========================================================
   IDLE ARROWS
   ========================================================= */

let idleTimer = null;
let idleArrowsShown = false;
const IDLE_DELAY_MS = 3000;

function initIdleArrows() {
  const reset = () => {
    clearTimeout(idleTimer);
    hideIdleArrows();
    if (!placementMode && !isFinalized) {
      idleTimer = setTimeout(showIdleArrows, IDLE_DELAY_MS);
    }
  };

  window.addEventListener("mousemove", reset, { passive: true });
  window.addEventListener("click", reset, { passive: true });
  window.addEventListener("keydown", reset, { passive: true });

  idleTimer = setTimeout(showIdleArrows, IDLE_DELAY_MS);
}

function getNextActionTarget() {
  if (motorMarkers.length > 0 && countPlaced("motor") === 0) {
    return { id: "addMotor", label: "Click to add a Motor" };
  }
  if (
    countPlaced("motor") > 0 &&
    wheelMarkers.length > 0 &&
    countPlaced("wheel") === 0
  ) {
    return { id: "addWheelBtn", label: "Click to add Wheels" };
  }
  if (countPlaced("triangle_frame") < 2) {
    return { id: "addTriangle", label: "Add Tri. Frames for structure" };
  }
  if (
    countPlaced("triangle_frame") >= 2 &&
    countPlaced("support_frame") === 0
  ) {
    return { id: "addSupportFrame", label: "Now add a Support Frame" };
  }
  return { id: "addFrame", label: "Expand with more Frames" };
}

function showIdleArrows() {
  if (placementMode || isFinalized) return;
  hideIdleArrows();

  const target = getNextActionTarget();
  const btnEl = document.getElementById(target.id);
  if (!btnEl) return;

  const container = document.getElementById("idle-arrows");
  if (!container) return;

  const rect = btnEl.getBoundingClientRect();

  const arrow = document.createElement("div");
  arrow.className = "idle-arrow";
  arrow.style.left = `${rect.right + 6}px`;
  arrow.style.top = `${rect.top + rect.height / 2 - 14}px`;

  arrow.innerHTML = `
    <div class="idle-arrow-shaft">
      <div class="idle-arrow-line"></div>
      <div class="idle-arrow-head">▶</div>
    </div>
    <div class="idle-arrow-label">${target.label}</div>
  `;

  btnEl.style.transition = "box-shadow 0.4s ease";
  btnEl.style.boxShadow =
    "0 0 18px rgba(204,34,0,0.45), inset 0 0 12px rgba(204,34,0,0.08)";

  container.appendChild(arrow);
  idleArrowsShown = true;

  arrow.dataset.btnId = target.id;
}

function hideIdleArrows() {
  if (!idleArrowsShown) return;

  const container = document.getElementById("idle-arrows");
  if (container) {
    container.querySelectorAll(".idle-arrow").forEach((arrow) => {
      const btn = document.getElementById(arrow.dataset.btnId);
      if (btn) btn.style.boxShadow = "";
    });
    container.innerHTML = "";
  }

  idleArrowsShown = false;
}

/* =========================================================
   LOOP
   ========================================================= */

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  if (placementMode) {
    const t = Date.now() * 0.003;
    const pulse = 1.3 + Math.sin(t) * 0.3;

    const activeList =
      placementMode === "motor"
        ? motorMarkers
        : placementMode === "frame"
          ? [...frameMarkers, ...frameOnSupportMarkers]
          : placementMode === "triangle"
            ? triangleMarkers
            : placementMode === "support"
              ? triangleMarkers
              : placementMode === "wheel"
                ? wheelMarkers
                : [];

    activeList.forEach((m) => {
      if (placementMode === "motor" && m === hoveredMotorMarker) return;
      m.scale.setScalar(pulse);
    });
  }

  renderer.render(scene, camera);
}

/* =========================================================
   HOVER HIGHLIGHT + TOOLTIP
   ========================================================= */

function showTooltip(mount, clientX, clientY) {
  if (!tooltipEl || !mount) return;
  const type = mount.userData.type ?? "unknown";
  const label = PART_LABELS[type] ?? type.replace(/_/g, " ").toUpperCase();
  const cost = PART_COSTS[type];
  const costStr = cost != null ? `₹${cost.toLocaleString()}` : "—";

  const deps = getDependentMounts(mount);
  const depWarning =
    deps.length > 0
      ? `<br><span style="color:#cc6600;font-size:10px">⚠ ${deps.length} dependent${deps.length !== 1 ? "s" : ""} — delete those first</span>`
      : "";

  tooltipEl.innerHTML =
    `<span style="color:#cc2200;font-weight:700;letter-spacing:0.15em;font-family:'Orbitron',sans-serif;font-size:10px">${label.toUpperCase()}</span><br>` +
    `<span style="color:#606870">Unit cost: </span><span style="color:#d0d8e0">${costStr}</span>` +
    depWarning;

  const TW = tooltipEl.offsetWidth || 180;
  const TH = tooltipEl.offsetHeight || 52;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let tx = clientX + 16;
  let ty = clientY - 12;
  if (tx + TW > vw - 10) tx = clientX - TW - 10;
  if (ty + TH > vh - 10) ty = vh - TH - 10;
  if (ty < 8) ty = 8;

  tooltipEl.style.left = tx + "px";
  tooltipEl.style.top = ty + "px";
  tooltipEl.style.display = "block";
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = "none";
}
