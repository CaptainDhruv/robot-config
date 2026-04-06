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
  refreshInventory,
} from "./ui/inventory.js";
import { supabase } from "./supabaseClient.js";

// ── PART CONFIG — loaded dynamically from Supabase part_config table ──────────
import {
  getPartConfig,
  subscribePartConfig,
  getPrice,
  getLabel,
  getPartMeta,
  getAllPrices,
  getAllLabels,
  buildTooltipHTML,
} from "./partConfig.js";

// Dynamic getters — replace all PART_COSTS[x] with PART_COSTS()[x]
const PART_COSTS = () => getAllPrices();
const PART_LABELS = () => getAllLabels();

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
let lastHoveredTriangleSocketUUID = null;

// ── Support auto-orientation state (1-click placement) ───────────────────────
let supportManualRotSteps = 0;
let supportFirstSocket = null;
let supportFirstMarker = null;

// ── Frame-on-support rotation ─────────────────────────────────────────────────
let frameOnSupportRotationSteps = 0;
let frameOnSupportAutoYaw = 0;
let currentHoveredSupportSocket = null;

// ── Tracks which socket type the ghost is currently hovering ─────────────────
let frameHoverType = "frame";

// ── Undo history ─────────────────────────────────────────────────────────────
const undoStack = [];
const redoStack = [];
const MAX_UNDO = 50;

function pushUndo(mount, socketUuids, type) {
  undoStack.push({ mount, socketUuids: [...socketUuids], type });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  updateUndoRedoButtons();
}

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
   PART WEIGHTS (stays static — not in DB)
   ========================================================= */
const WORLD_TO_CM = 10.07;

const PART_WEIGHTS = {
  frame: 450,
  motor: 380,
  triangle_frame: 180,
  support_frame: 220,
  wheel: 290,
};

/* =========================================================
   BASKET TYPE COLOURS — mirror component button accents
   ========================================================= */

const BASKET_BTN_COLORS = {
  frame: "#797979", // btn-frame border (grey)
  motor: "#f9b100", // btn-motor border (yellow)
  triangle_frame: "#ada7ab", // btn-triangle border (silver)
  support_frame: "#ff770e", // btn-support border (orange)
  wheel: "#36454f", // btn-wheel border (dark steel)
};

// Keyword groups used to recognise a basket row's type from its text.
const BASKET_TYPE_KEYWORDS = [
  { type: "motor", kw: ["motor housing", "motor"] },
  {
    type: "triangle_frame",
    kw: ["triangular frame", "tri. frame", "triangle"],
  },
  {
    type: "support_frame",
    kw: ["stress bridge", "support frame", "stress", "bridge"],
  },
  { type: "wheel", kw: ["wheel"] },
  { type: "frame", kw: ["rectangular frame", "rect. frame", "frame"] },
];

/**
 * Colours each basket row to match its component-button accent,
 * and hides any non-part rows (the inventory.js summary/total bar).
 * Idempotent — safe to call repeatedly.
 */
function applyBasketTypeColors() {
  const basketEl = document.getElementById("basketItems");
  if (!basketEl) return;

  // Build lowercased DB-label → type map (refreshed each call for live config)
  const dbLabels = getAllLabels();
  const labelToType = {};
  for (const [type, label] of Object.entries(dbLabels)) {
    labelToType[label.toLowerCase()] = type;
  }

  Array.from(basketEl.children).forEach((child) => {
    const text = child.textContent.toLowerCase().trim();
    let matched = null;

    // 1. Exact DB-label match (most reliable)
    for (const [lbl, type] of Object.entries(labelToType)) {
      if (text.includes(lbl)) {
        matched = type;
        break;
      }
    }

    // 2. Keyword fallback
    if (!matched) {
      for (const { type, kw } of BASKET_TYPE_KEYWORDS) {
        if (kw.some((k) => text.includes(k))) {
          matched = type;
          break;
        }
      }
    }

    if (matched) {
      const color = BASKET_BTN_COLORS[matched] ?? "rgba(208,88,24,0.65)";
      child.style.setProperty("border-left-color", color, "important");
      child.style.setProperty("border-left-width", "3px", "important");
      child.dataset.partType = matched;
      child.style.display = ""; // ensure visible
    } else {
      // Unmatched = inventory.js injected summary/total bar — hide it.
      // The basket-footer already shows the grand total.
      child.style.display = "none";
    }
  });
}

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

  const savedBg = scene.background ? scene.background.clone() : null;
  const savedFog = scene.fog;
  scene.background = new THREE.Color(0xffffff);
  scene.fog = null;
  renderer.setClearColor(0xffffff, 1);
  if (sceneGridMajor) sceneGridMajor.visible = false;
  if (sceneGridMinor) sceneGridMinor.visible = false;
  if (sceneGround) sceneGround.visible = false;

  renderer.render(scene, camera);
  const dataURL = renderer.domElement.toDataURL("image/png");

  scene.background = savedBg ?? new THREE.Color(0x8aaec8);
  scene.fog = savedFog;
  renderer.setClearColor(0x8aaec8, 1);
  if (sceneGridMajor) sceneGridMajor.visible = true;
  if (sceneGridMinor) sceneGridMinor.visible = true;
  if (sceneGround) sceneGround.visible = true;

  camera.position.copy(savedPos);
  camera.quaternion.copy(savedQuat);
  controls.target.copy(savedTarget);
  controls.update();
  renderer.render(scene, camera);

  return dataURL;
}

/* =========================================================
   INSTRUCTION PANEL — DISABLED (no-ops)
   ========================================================= */

function showInstructionPanel(_mode) {}
function hideInstructionPanel() {}

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
const SUPPORT_SNAP_Y_ADJUST = 0.1;

/* =========================================================
   RAYCAST
   ========================================================= */

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let _mouseDownX = 0;
let _mouseDownY = 0;
const CLICK_MOVE_THRESHOLD = 5;

/* =========================================================
   SOCKET MARKERS
   ========================================================= */

const socketGeo = new THREE.SphereGeometry(0.09, 12, 12);
const frameMat = new THREE.MeshBasicMaterial({ color: 0xd06010 });
const motorMat = new THREE.MeshBasicMaterial({ color: 0xe87830 });
const supportFrameSocketMat = new THREE.MeshBasicMaterial({ color: 0xd06010 });
const wheelSocketMat = new THREE.MeshBasicMaterial({ color: 0xb84a14 });

let frameMarkers = [];
let motorMarkers = [];
let triangleSocketMarkers = [];
let stressConnectorMarkers = [];
let triangleMarkers = [];
let frameOnSupportMarkers = [];
let wheelMarkers = [];

let sceneGridMajor = null;
let sceneGridMinor = null;
let sceneGround = null;

/* =========================================================
   SUPPORT SOCKET PAIRS (TRIANGLE)
   ========================================================= */

const SUPPORT_TRIANGLE_PAIRS = [
  ["SOCKET_STRESS_CONNECTOR_A", "SOCKET_STRESS_CONNECTOR_B"],
  ["SOCKET_STRESS_CONNECTOR_C", "SOCKET_STRESS_CONNECTOR_D"],
];

/* =========================================================
   FRAME SOCKET HELPERS
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
   MOTOR AUTO-ORIENTATION HELPER
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
   FRAME-ON-SUPPORT AUTO-ORIENTATION HELPER
   ========================================================= */

function computeFrameOnSupportSnap(socket, rotSteps) {
  scene.updateMatrixWorld(true);
  socket.updateMatrixWorld(true);

  const posSupA = new THREE.Vector3();
  socket.getWorldPosition(posSupA);

  let parentMount = socket.parent;
  while (parentMount && !parentMount.userData?.isMount)
    parentMount = parentMount.parent;

  let posSupB = null;
  if (parentMount) {
    parentMount.updateMatrixWorld(true);
    let bestDist = -1;
    parentMount.traverse((o) => {
      if (!o.name?.startsWith("SOCKET_FRAME_SUPPORT") || o.uuid === socket.uuid)
        return;
      const wp = new THREE.Vector3();
      o.getWorldPosition(wp);
      const d = wp.distanceTo(posSupA);
      if (d > bestDist) {
        bestDist = d;
        posSupB = wp.clone();
      }
    });
  }

  const frame = frameTemplate.clone(true);
  frame.position.set(0, 0, 0);
  frame.rotation.set(0, 0, 0);
  frame.scale.set(1, 1, 1);
  frame.updateMatrixWorld(true);

  const rectConnectors = [];
  frame.traverse((o) => {
    if (!o.name) return;
    if (o.name.toUpperCase().startsWith("SOCKET_FRAME_SUPPORT")) {
      const wp = new THREE.Vector3();
      o.getWorldPosition(wp);
      rectConnectors.push({ x: wp.x, y: wp.y, z: wp.z });
    }
  });

  if (rectConnectors.length === 0) {
    const localY = getFrameSupportSocketLocalY();
    return {
      position: new THREE.Vector3(
        posSupA.x,
        posSupA.y - localY + FRAME_ON_SUPPORT_Y_OFFSET,
        posSupA.z,
      ),
      rotation: rotSteps * (Math.PI / 2),
    };
  }

  const candidateAngles = [];
  if (posSupB) {
    const axisAngle = Math.atan2(posSupB.x - posSupA.x, posSupB.z - posSupA.z);
    for (let i = 0; i < 4; i++)
      candidateAngles.push(axisAngle + (i * Math.PI) / 2);
  } else {
    for (let i = 0; i < 4; i++) candidateAngles.push((i * Math.PI) / 2);
  }

  let bestError = Infinity,
    bestAngle = 0,
    bestSnapConn = rectConnectors[0];
  for (const snapConn of rectConnectors) {
    for (const angle of candidateAngles) {
      const cos = Math.cos(angle),
        sin = Math.sin(angle);
      const rsX = cos * snapConn.x + sin * snapConn.z;
      const rsZ = -sin * snapConn.x + cos * snapConn.z;
      const mX = posSupA.x - rsX,
        mZ = posSupA.z - rsZ;
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

  const finalAngle = bestAngle + rotSteps * (Math.PI / 2);
  const cos = Math.cos(finalAngle),
    sin = Math.sin(finalAngle);
  const rsX = cos * bestSnapConn.x + sin * bestSnapConn.z;
  const rsZ = -sin * bestSnapConn.x + cos * bestSnapConn.z;

  return {
    position: new THREE.Vector3(
      posSupA.x - rsX,
      posSupA.y - bestSnapConn.y + FRAME_ON_SUPPORT_Y_OFFSET,
      posSupA.z - rsZ,
    ),
    rotation: finalAngle,
  };
}
/* =========================================================
   TRIANGLE AUTO-ORIENTATION HELPER
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

  const socketWorldQuat = new THREE.Quaternion();
  socket.getWorldQuaternion(socketWorldQuat);
  const euler = new THREE.Euler().setFromQuaternion(socketWorldQuat, "YXZ");
  return euler.y;
}

/* =========================================================
   DEPENDENCY RULES
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
  return PART_LABELS()[type] ?? type.replace(/_/g, " ");
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
    ([t, n]) => `${n}× ${PART_LABELS()[t] ?? t.replace(/_/g, " ")}`,
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
    if (mount.userData?.isBase) continue;
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

  hoveredMotorMarker = null;
  hoveredTriangleMarker = null;

  rebuildSocketMarkers();
  updateWheelButtonState();
  updateSupportButtonState();
  applySocketHighlights();
  updateWeightDisplay();

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
  renderer.setClearColor(0x8aaec8, 1);

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

  // ── Load part config from Supabase BEFORE any UI renders ─────────────────
  await getPartConfig(supabase);

  // ── COMPONENT BUTTON TOOLTIPS (reads live from partConfig) ────────
  const BTN_TO_TYPE = {
    addFrame: "frame",
    addMotor: "motor",
    addWheelBtn: "wheel",
    addTriangle: "triangle_frame",
    addSupportFrame: "support_frame",
  };
  const SIDEBAR_REQUIRES = {
    motor: "Needs: free motor socket on a frame",
    wheel: "Needs: 1× Motor placed first",
    support_frame: "Needs: 2× Triangular Frames",
  };
  const sideTip = document.createElement("div");
  Object.assign(sideTip.style, {
    position: "fixed",
    pointerEvents: "none",
    display: "none",
    background: "rgba(12,16,26,0.97)",
    border: "1px solid rgba(208,88,24,0.5)",
    borderLeft: "3px solid #d05818",
    color: "#e8eef4",
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: "11px",
    letterSpacing: "0.06em",
    padding: "10px 14px",
    zIndex: "99990",
    lineHeight: "1.7",
    minWidth: "200px",
    maxWidth: "280px",
    boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
    clipPath: "polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,0 100%)",
  });
  sideTip.innerHTML = `
    <div id="stip-title" style="font-family:'Orbitron',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;color:#d05818;margin-bottom:5px"></div>
    <div id="stip-desc" style="font-size:10px;color:#8aacbf;margin-bottom:6px;white-space:normal;line-height:1.5"></div>
    <div style="display:flex;flex-direction:column;gap:2px">
      <div id="stip-cost" style="color:#d8e8f4;font-size:11px;font-weight:700"></div>
      <div id="stip-req" style="font-size:9px;color:#6a8098;letter-spacing:0.06em"></div>
    </div>`;
  document.body.appendChild(sideTip);
  let _sideTipTimer = null;
  document.querySelectorAll(".btn-tip-wrap").forEach((wrap) => {
    const type = BTN_TO_TYPE[wrap.dataset.tip];
    if (!type) return;
    wrap.addEventListener("mouseenter", () => {
      clearTimeout(_sideTipTimer);
      const meta = getPartMeta(type);
      const finalPrice = getPrice(type);
      sideTip.querySelector("#stip-title").textContent =
        meta.label.toUpperCase();
      sideTip.querySelector("#stip-desc").textContent = meta.description;
      sideTip.querySelector("#stip-cost").textContent =
        `₹${meta.price.toLocaleString("en-IN")} + ${meta.gst_percent}% GST = ₹${finalPrice.toLocaleString("en-IN")}`;
      sideTip.querySelector("#stip-req").textContent =
        SIDEBAR_REQUIRES[type] ?? "";
      const rect = wrap.getBoundingClientRect();
      sideTip.style.left = rect.right + 12 + "px";
      sideTip.style.top =
        Math.max(
          8,
          Math.min(rect.top + rect.height / 2 - 55, window.innerHeight - 160),
        ) + "px";
      sideTip.style.display = "block";
    });
    wrap.addEventListener("mouseleave", () => {
      _sideTipTimer = setTimeout(() => {
        sideTip.style.display = "none";
      }, 80);
    });
  });
  // ─────────────────────────────────────────────────────────────────

  // Subscribe to live admin changes — updates basket/weight/tooltips instantly

  // Subscribe to live admin changes — updates basket/weight/tooltips instantly
  subscribePartConfig(supabase, () => {
    updateWeightDisplay();
    updateBasketTotals();
    refreshInventory();
  });
  // ─────────────────────────────────────────────────────────────────────────

  frameTemplate = await loadGLB("/assets/models/rectangle_frame.glb");
  motorTemplate = await loadGLB("/assets/models/motor_housing.glb");
  triangleTemplate = await loadGLB("/assets/models/triangle_frame.glb");

  triangleTemplate.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((mat) => {
      if (!mat) return;
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
      if (mat.color) mat.color.multiplyScalar(1.35);
      mat.needsUpdate = true;
    });
  });
  supportTemplate = await loadGLB("/assets/models/support_frame.glb");
  wheelTemplate = await loadGLB("/assets/models/wheel.glb");

  setupGrid();

  const baseFrameModel = frameTemplate.clone(true);
  baseFrameModel.position.set(0, 0, 0);
  baseFrameModel.rotation.set(0, 0, 0);
  baseFrameModel.scale.set(1, 1, 1);

  const baseMount = new THREE.Group();
  baseMount.userData = { isMount: true, type: "frame", isBase: true };
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
  initMinimap();
  initWeightSection();
  initComponentPreview();
  rebuildSocketMarkers();
  updateWheelButtonState();
  updateSupportButtonState();
  updateUndoRedoButtons();
  applySocketHighlights();

  // ── Basket colour-matching + green-bar removal ────────────────────────────
  const _bEl = document.getElementById("basketItems");
  if (_bEl) {
    applyBasketTypeColors();
    new MutationObserver(() => applyBasketTypeColors()).observe(_bEl, {
      childList: true,
      subtree: false,
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mousedown", (e) => {
    _mouseDownX = e.clientX;
    _mouseDownY = e.clientY;
  });
  canvas.addEventListener("click", (e) => {
    const dx = e.clientX - _mouseDownX;
    const dy = e.clientY - _mouseDownY;
    if (Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD) return;
    onClick(e);
  });
  canvas.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown);

  window.addEventListener("resize", onWindowResize);
  onWindowResize();

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

  animate();
}

/* ── Helper to refresh basket totals when config updates live ── */
function updateBasketTotals() {
  const counts = {};
  scene.traverse((o) => {
    if (!o.userData?.isMount) return;
    const t = o.userData.type ?? "unknown";
    counts[t] = (counts[t] ?? 0) + 1;
  });

  let total = 0;
  const basketEl = document.getElementById("basketItems");
  if (basketEl) {
    basketEl.innerHTML = "";
    for (const [type, qty] of Object.entries(counts)) {
      const price = getPrice(type);
      const label = getLabel(type);
      const subtotal = price * qty;
      total += subtotal;

      const row = document.createElement("div");
      row.dataset.partType = type;
      const color = BASKET_BTN_COLORS[type] ?? "rgba(208,88,24,0.65)";
      row.style.setProperty("border-left-color", color, "important");
      row.style.setProperty("border-left-width", "3px", "important");

      row.innerHTML = `
        <span style="font-family:'Oswald',sans-serif;font-size:13px;font-weight:400;letter-spacing:0.06em;color:#e8f4ff;display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;color:#8aacbf;background:#111820;border:1px solid #2a3848;padding:1px 5px;letter-spacing:0.06em;font-family:'Oswald',sans-serif;">${qty}×</span>
          ${label}
        </span>
        <span style="text-align:right;flex-shrink:0;margin-left:8px;">
         <span style="font-family:'Oswald',sans-serif;font-size:14px;font-weight:600;letter-spacing:0.06em;color:#ffffff;display:block;">₹${subtotal.toLocaleString("en-IN")}</span>
        <span style="font-family:'Oswald',sans-serif;font-size:8px;font-weight:300;letter-spacing:0.08em;color:#6a8098;display:block;">₹${price.toLocaleString("en-IN")} EACH</span>
        </span>
      `;
      basketEl.appendChild(row);
    }
  }

  const totalEl = document.getElementById("totalPrice");
  if (totalEl) totalEl.textContent = total.toLocaleString("en-IN");
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

  const perspBtn = document.querySelector('[data-cam="front"]');
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
  scene.background = new THREE.Color(0x8aaec8);
  scene.fog = new THREE.FogExp2(0x8aaec8, 0.014);

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

  sceneGridMajor = new THREE.GridHelper(60, 60, 0x6a8aaa, 0x5a7a9a);
  sceneGridMajor.position.y = gridY;
  sceneGridMajor.material.transparent = true;
  sceneGridMajor.material.opacity = 0.55;
  scene.add(sceneGridMajor);

  sceneGridMinor = new THREE.GridHelper(60, 240, 0x4a6a88, 0x4a6a88);
  sceneGridMinor.position.y = gridY - 0.001;
  sceneGridMinor.material.transparent = true;
  sceneGridMinor.material.opacity = 0.3;
  scene.add(sceneGridMinor);

  const groundGeo = new THREE.PlaneGeometry(60, 60);
  const groundMat = new THREE.MeshBasicMaterial({
    color: 0x3a5470,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  sceneGround = new THREE.Mesh(groundGeo, groundMat);
  sceneGround.rotation.x = -Math.PI / 2;
  sceneGround.position.y = gridY - 0.002;
  scene.add(sceneGround);
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
  bind("proceedPaymentBtn", onProceedToPayment);
  bind("undoBtn", () => !isFinalized && performUndo());
  bind("redoBtn", () => !isFinalized && performRedo());

  const rotLeftBtn = document.getElementById("rotLeftBtn");
  const rotRightBtn = document.getElementById("rotRightBtn");

  const arrowLeft = document.getElementById("arrowKeyLeft");
  const arrowRight = document.getElementById("arrowKeyRight");

  function fireArrow(dir) {
    if (!placementMode) return;
    flashArrowKey(dir === 1 ? "right" : "left");

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
    if (placementMode === "frame") {
      frameOnSupportRotationSteps += dir;
      const deg = (((frameOnSupportRotationSteps % 4) + 4) % 4) * 90;
      showHudMessage(`Frame rotation on support: ${deg}°`);
      updateShortcutBar();
      if (
        ghost &&
        frameHoverType === "support" &&
        currentHoveredSupportSocket
      ) {
        const snap = computeFrameOnSupportSnap(
          currentHoveredSupportSocket,
          frameOnSupportRotationSteps,
        );
        ghost.position.copy(snap.position);
        ghost.rotation.set(0, snap.rotation, 0);
      }
    }
  }

  if (arrowLeft) arrowLeft.addEventListener("click", () => fireArrow(-1));
  if (arrowRight) arrowRight.addEventListener("click", () => fireArrow(1));

  if (rotLeftBtn)
    rotLeftBtn.addEventListener("click", () => {
      if (placementMode === "triangle" && ghost) {
        triangleManualRotSteps = (triangleManualRotSteps + 1) % 2;
        showHudMessage(`Triangle: ${triangleManualRotSteps * 180}°`);
        updateShortcutBar();
        updateRotationDisplay();
        ghost.rotation.set(
          0,
          triangleAutoBaseYaw + triangleManualRotSteps * Math.PI,
          0,
        );
      }
    });

  if (rotRightBtn)
    rotRightBtn.addEventListener("click", () => {
      if (placementMode === "triangle" && ghost) {
        triangleManualRotSteps = (triangleManualRotSteps + 1) % 2;
        showHudMessage(`Triangle: ${triangleManualRotSteps * 180}°`);
        updateShortcutBar();
        updateRotationDisplay();
        ghost.rotation.set(
          0,
          triangleAutoBaseYaw + triangleManualRotSteps * Math.PI,
          0,
        );
      }
    });

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
  if (placementMode) clearGhost();
  printDesign();
}

function onEdit() {}

function onProceedToPayment() {
  if (placementMode) clearGhost();
  showAddressOverlay();
}
/* =========================================================
   ADDRESS OVERLAY
   ========================================================= */

function showAddressOverlay() {
  const existing = document.getElementById("addr-overlay");
  if (existing) existing.remove();

  const counts = {};
  scene.traverse((o) => {
    if (!o.userData?.isMount) return;
    const t = o.userData.type ?? "unknown";
    counts[t] = (counts[t] ?? 0) + 1;
  });
  const totalCost = document.getElementById("totalPrice")?.textContent ?? "0";
  const totalParts = Object.values(counts).reduce((a, b) => a + b, 0);
  const orderRef = "MK1-" + Date.now().toString(36).toUpperCase().slice(-8);

  const INDIAN_STATES = [
    "Andaman and Nicobar Islands",
    "Andhra Pradesh",
    "Arunachal Pradesh",
    "Assam",
    "Bihar",
    "Chandigarh",
    "Chhattisgarh",
    "Dadra and Nagar Haveli and Daman and Diu",
    "Delhi",
    "Goa",
    "Gujarat",
    "Haryana",
    "Himachal Pradesh",
    "Jammu and Kashmir",
    "Jharkhand",
    "Karnataka",
    "Kerala",
    "Ladakh",
    "Lakshadweep",
    "Madhya Pradesh",
    "Maharashtra",
    "Manipur",
    "Meghalaya",
    "Mizoram",
    "Nagaland",
    "Odisha",
    "Puducherry",
    "Punjab",
    "Rajasthan",
    "Sikkim",
    "Tamil Nadu",
    "Telangana",
    "Tripura",
    "Uttar Pradesh",
    "Uttarakhand",
    "West Bengal",
  ];

  if (!document.getElementById("addr-kf")) {
    const s = document.createElement("style");
    s.id = "addr-kf";
    s.textContent = `
      @keyframes addrFadeIn  { from{opacity:0} to{opacity:1} }
      @keyframes addrCardIn  { from{opacity:0;transform:translate(-50%,-47%)} to{opacity:1;transform:translate(-50%,-50%)} }
      .addr-input, .addr-select {
        background:#111820; border:1.5px solid #2a3848; color:#d8e8f4;
        font-family:'Share Tech Mono',monospace; font-size:13px; letter-spacing:0.04em;
        padding:10px 14px; width:100%; border-radius:0;
        box-shadow:inset 0 2px 4px rgba(0,0,0,0.3);
        transition:border-color .15s,box-shadow .15s; appearance:none; -webkit-appearance:none;
      }
      .addr-input::placeholder { color:#4a6078; }
      .addr-input:focus, .addr-select:focus {
        outline:none; border-color:#d05818;
        box-shadow:0 0 0 2px rgba(208,88,24,0.18),inset 0 2px 4px rgba(0,0,0,0.3);
      }
      .addr-input.addr-err, .addr-select.addr-err {
        border-color:#cc2200;
        box-shadow:0 0 0 2px rgba(204,34,0,0.18),inset 0 2px 4px rgba(0,0,0,0.3);
      }
      .addr-select-wrap { position:relative; }
      .addr-select-wrap::after {
        content:"▾"; position:absolute; right:12px; top:50%; transform:translateY(-50%);
        color:#8aacbf; font-size:14px; pointer-events:none;
      }
      .addr-select option { background:#18202e; color:#d8e8f4; }
      .addr-label {
        font-family:'Orbitron',sans-serif; font-size:8px; font-weight:700;
        letter-spacing:0.22em; text-transform:uppercase; color:#a8c4d8;
        display:block; margin-bottom:6px;
      }
      .addr-rule-hint {
        font-family:'Share Tech Mono',monospace; font-size:9px; letter-spacing:0.06em;
        color:#4a6078; margin-top:4px; display:block; line-height:1.4;
        transition:color 0.15s;
      }
      .addr-input.addr-err ~ .addr-rule-hint,
      .addr-select.addr-err ~ .addr-rule-hint,
      .addr-select-wrap .addr-select.addr-err ~ .addr-rule-hint { color:#e05040; }
      .addr-field { display:flex; flex-direction:column; }
      .addr-row { display:grid; gap:14px; margin-bottom:14px; }
      .addr-row-1   { grid-template-columns:1fr; }
      .addr-row-2   { grid-template-columns:1fr 1fr; }
      .addr-row-211 { grid-template-columns:1fr 1fr 110px; }
      .addr-btn {
        font-family:'Orbitron',sans-serif; font-size:9px; font-weight:700;
        letter-spacing:0.2em; text-transform:uppercase; padding:11px 26px;
        border:1.5px solid; cursor:pointer; transition:all .12s ease;
        display:flex; align-items:center; gap:8px;
      }
      .addr-btn-cancel { background:transparent; border-color:#2a3848; color:#8aacbf; box-shadow:3px 3px 0 #0e1420; }
      .addr-btn-cancel:hover { background:#1e2838; border-color:#8aacbf; color:#d8e8f4; box-shadow:5px 5px 0 #0e1420; transform:translate(-2px,-2px); }
      .addr-btn-submit { background:transparent; border-color:#d05818; color:#d05818; box-shadow:4px 4px 0 #5a2008; }
      .addr-btn-submit:hover { background:#d05818; color:#0e1018; box-shadow:6px 6px 0 #5a2008; transform:translate(-2px,-2px); }
      @media(max-width:540px){
        .addr-row-2,.addr-row-211{ grid-template-columns:1fr; }
      }
    `;
    document.head.appendChild(s);
  }

  const backdrop = document.createElement("div");
  backdrop.id = "addr-overlay";
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(8,12,20,0.92)",
    zIndex: "10000001",
    animation: "addrFadeIn 0.2s ease both",
    backdropFilter: "blur(6px)",
    overflowY: "auto",
  });

  const card = document.createElement("div");
  Object.assign(card.style, {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%,-50%)",
    width: "min(560px, 92vw)",
    background: "#18202e",
    border: "1.5px solid rgba(208,88,24,0.3)",
    borderLeft: "3px solid #d05818",
    clipPath: "polygon(0 0,calc(100% - 18px) 0,100% 18px,100% 100%,0 100%)",
    boxShadow: "0 0 60px rgba(0,0,0,0.7),0 0 30px rgba(208,88,24,0.07)",
    animation: "addrCardIn 0.3s ease both",
  });

  const al = document.createElement("div");
  Object.assign(al.style, {
    height: "2px",
    background:
      "linear-gradient(90deg,#d05818,rgba(208,88,24,0.1),transparent)",
  });
  card.appendChild(al);

  const strip = document.createElement("div");
  Object.assign(strip.style, {
    background: "rgba(208,88,24,0.06)",
    borderBottom: "1px solid rgba(208,88,24,0.14)",
    padding: "11px 26px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "10px",
  });
  const stripLbl = document.createElement("div");
  Object.assign(stripLbl.style, {
    fontFamily: "'Orbitron',sans-serif",
    fontSize: "8px",
    fontWeight: "700",
    letterSpacing: "0.24em",
    color: "#d05818",
    textTransform: "uppercase",
  });
  stripLbl.textContent = "Your Order";

  const stripStats = document.createElement("div");
  Object.assign(stripStats.style, {
    display: "flex",
    gap: "18px",
    alignItems: "center",
  });
  const mkStat = (val, lbl, accent) => {
    const b = document.createElement("div");
    b.style.textAlign = "center";
    const v = document.createElement("div");
    v.textContent = val;
    Object.assign(v.style, {
      fontFamily: "'Orbitron',sans-serif",
      fontSize: "15px",
      fontWeight: "700",
      color: accent ? "#d05818" : "#d8e8f4",
      letterSpacing: "0.06em",
      lineHeight: "1",
    });
    const l = document.createElement("div");
    l.textContent = lbl;
    Object.assign(l.style, {
      fontFamily: "'Share Tech Mono',monospace",
      fontSize: "8px",
      letterSpacing: "0.12em",
      color: "#384858",
      marginTop: "3px",
      textTransform: "uppercase",
    });
    b.appendChild(v);
    b.appendChild(l);
    return b;
  };
  stripStats.appendChild(mkStat(totalParts, "Parts", false));
  const stripSep = document.createElement("div");
  Object.assign(stripSep.style, {
    width: "1px",
    height: "26px",
    background: "rgba(208,88,24,0.2)",
  });
  stripStats.appendChild(stripSep);
  stripStats.appendChild(
    mkStat(
      "₹" + Number(totalCost.replace(/[^0-9.]/g, "")).toLocaleString("en-IN"),
      "Total",
      true,
    ),
  );
  strip.appendChild(stripLbl);
  strip.appendChild(stripStats);
  card.appendChild(strip);

  const form = document.createElement("form");
  form.autocomplete = "on";
  form.onsubmit = (e) => e.preventDefault();
  const body = document.createElement("div");
  body.style.padding = "22px 26px 26px";

  const secTitle = document.createElement("div");
  Object.assign(secTitle.style, {
    fontFamily: "'Orbitron',sans-serif",
    fontSize: "10px",
    fontWeight: "700",
    letterSpacing: "0.22em",
    color: "#6a8098",
    textTransform: "uppercase",
    marginBottom: "18px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
  });
  secTitle.innerHTML = `<span style="width:3px;height:13px;background:#d05818;display:inline-block;flex-shrink:0"></span>Delivery Address`;
  body.appendChild(secTitle);

  const mkField = (
    labelTxt,
    placeholder,
    required = true,
    type = "text",
    hint = "",
  ) => {
    const wrap = document.createElement("div");
    wrap.className = "addr-field";
    const lbl = document.createElement("label");
    lbl.className = "addr-label";
    lbl.innerHTML =
      labelTxt + (required ? ' <span style="color:#d05818">*</span>' : "");
    const inp = document.createElement("input");
    inp.type = type;
    inp.placeholder = placeholder;
    inp.className = "addr-input";
    inp.addEventListener("input", () => inp.classList.remove("addr-err"));
    wrap.appendChild(lbl);
    wrap.appendChild(inp);
    if (hint) {
      const hintEl = document.createElement("span");
      hintEl.className = "addr-rule-hint";
      hintEl.textContent = hint;
      wrap.appendChild(hintEl);
    }
    return { wrap, inp };
  };

  const mkSelect = (labelTxt, options, required = true, hint = "") => {
    const wrap = document.createElement("div");
    wrap.className = "addr-field";
    const lbl = document.createElement("label");
    lbl.className = "addr-label";
    lbl.innerHTML =
      labelTxt + (required ? ' <span style="color:#d05818">*</span>' : "");
    const selWrap = document.createElement("div");
    selWrap.className = "addr-select-wrap";
    const sel = document.createElement("select");
    sel.className = "addr-select";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select state…";
    placeholder.disabled = true;
    placeholder.selected = true;
    sel.appendChild(placeholder);
    options.forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => sel.classList.remove("addr-err"));
    selWrap.appendChild(sel);
    wrap.appendChild(lbl);
    wrap.appendChild(selWrap);
    if (hint) {
      const hintEl = document.createElement("span");
      hintEl.className = "addr-rule-hint";
      hintEl.textContent = hint;
      wrap.appendChild(hintEl);
    }
    return { wrap, inp: sel };
  };

  const mkRow = (cls, ...fields) => {
    const r = document.createElement("div");
    r.className = `addr-row ${cls}`;
    fields.forEach((f) => r.appendChild(f.wrap));
    return r;
  };

  const fName = mkField(
    "Full Name",
    "e.g. Rahul Sharma",
    true,
    "text",
    "First & last name · letters and spaces only",
  );
  fName.inp.autocomplete = "name";
  const fLine1 = mkField(
    "Address Line 1",
    "House / Flat No., Building Name",
    true,
    "text",
    "At least 5 characters",
  );
  fLine1.inp.autocomplete = "address-line1";
  const fLine2 = mkField(
    "Address Line 2",
    "Street, Area, Landmark",
    false,
    "text",
    "Optional",
  );
  fLine2.inp.autocomplete = "address-line2";
  const fLine3 = mkField(
    "Address Line 3",
    "Locality / Neighbourhood",
    false,
    "text",
    "Optional",
  );
  fLine3.inp.autocomplete = "address-line3";
  const fCity = mkField(
    "City",
    "e.g. Bengaluru",
    true,
    "text",
    "Letters and spaces only",
  );
  fCity.inp.autocomplete = "address-level2";
  const fState = mkSelect(
    "State",
    INDIAN_STATES,
    true,
    "Select your state from the list",
  );
  fState.inp.autocomplete = "address-level1";
  const fPin = mkField("PIN Code", "560001", true, "text", "Exactly 6 digits");
  fPin.inp.autocomplete = "postal-code";
  const fPhone = mkField(
    "Phone Number",
    "+91 98765 43210",
    true,
    "tel",
    "10-digit mobile number · digits only",
  );
  fPhone.inp.autocomplete = "tel";

  body.appendChild(mkRow("addr-row-1", fName));
  body.appendChild(mkRow("addr-row-1", fLine1));
  body.appendChild(mkRow("addr-row-1", fLine2));
  body.appendChild(mkRow("addr-row-1", fLine3));
  body.appendChild(mkRow("addr-row-211", fCity, fState, fPin));
  body.appendChild(mkRow("addr-row-1", fPhone));

  const divider2 = document.createElement("div");
  Object.assign(divider2.style, {
    height: "1px",
    background: "rgba(255,255,255,0.05)",
    margin: "18px 0 16px",
  });
  body.appendChild(divider2);

  const btnRow = document.createElement("div");
  Object.assign(btnRow.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "10px",
  });
  const note = document.createElement("span");
  Object.assign(note.style, {
    fontFamily: "'Share Tech Mono',monospace",
    fontSize: "9px",
    color: "#384858",
    letterSpacing: "0.1em",
  });
  note.textContent = "* Required fields";

  const btnGroup = document.createElement("div");
  btnGroup.style.cssText = "display:flex;gap:10px;";

  const cancelBtn2 = document.createElement("button");
  cancelBtn2.type = "button";
  cancelBtn2.className = "addr-btn addr-btn-cancel";
  cancelBtn2.textContent = "CANCEL";
  cancelBtn2.onclick = () => backdrop.remove();

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "addr-btn addr-btn-submit";
  submitBtn.innerHTML = `<span>▶</span> CONFIRM ORDER`;
  submitBtn.onclick = async () => {
    let valid = true;
    const errors = [];

    // Full name: required, letters+spaces only, at least 2 chars
    const nameVal = fName.inp.value.trim();
    if (!nameVal || nameVal.length < 2 || !/^[a-zA-Z\s'.]+$/.test(nameVal)) {
      fName.inp.classList.add("addr-err");
      valid = false;
      if (!nameVal) errors.push("Full name is required");
      else errors.push("Name must contain letters only");
    }

    // Address line 1: required, at least 5 chars
    const line1Val = fLine1.inp.value.trim();
    if (!line1Val || line1Val.length < 5) {
      fLine1.inp.classList.add("addr-err");
      valid = false;
      errors.push("Address Line 1 must be at least 5 characters");
    }

    // City: required, letters+spaces only
    const cityVal = fCity.inp.value.trim();
    if (!cityVal || !/^[a-zA-Z\s]+$/.test(cityVal)) {
      fCity.inp.classList.add("addr-err");
      valid = false;
      errors.push(
        !cityVal ? "City is required" : "City must contain letters only",
      );
    }

    // State: required
    if (!fState.inp.value) {
      fState.inp.classList.add("addr-err");
      valid = false;
      errors.push("Please select a state");
    }

    // PIN: required, exactly 6 digits
    const pinVal = fPin.inp.value.trim();
    if (!pinVal || !/^\d{6}$/.test(pinVal)) {
      fPin.inp.classList.add("addr-err");
      valid = false;
      errors.push("PIN code must be exactly 6 digits");
    }

    // Phone: required, 10 digits
    const phoneDigits = fPhone.inp.value.replace(/\D/g, "");
    if (!fPhone.inp.value.trim() || phoneDigits.length < 10) {
      fPhone.inp.classList.add("addr-err");
      valid = false;
      errors.push("Phone number must have at least 10 digits");
    }

    if (!valid) {
      showHudMessage("⚠ " + (errors[0] ?? "Please fix the highlighted fields"));
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span>⟳</span> SAVING ORDER...`;

    const addrLines = [
      fLine1.inp.value.trim(),
      fLine2.inp.value.trim(),
      fLine3.inp.value.trim(),
      `${fCity.inp.value.trim()}, ${fState.inp.value.trim()} — ${fPin.inp.value.trim()}`,
      fPhone.inp.value.trim(),
    ].filter(Boolean);

    const customerName = fName.inp.value.trim();
    const customerPhone = fPhone.inp.value.replace(/\D/g, "").slice(-10);

    try {
      const savedOrder = await saveOrderToSupabase({
        orderRef,
        totalCost,
        totalParts,
        customerName,
        customerPhone,
        fLine1,
        fLine2,
        fLine3,
        fCity,
        fState,
        fPin,
      });

      backdrop.remove();

      try {
        await initiateRazorpayPayment({
          savedOrder,
          orderRef,
          totalCost,
          totalParts,
          customerName,
          customerPhone: fPhone.inp.value.replace(/\D/g, "").slice(-10),
          addrLines,
        });
      } catch (payErr) {
        console.warn("[PAYMENT]", payErr.message);
      }
    } catch (err) {
      console.error("[ORDER SAVE ERROR]", err);
      const msg = err?.message ?? String(err);
      showHudMessage("⚠ " + msg.slice(0, 80));
      alert("Order save failed:\n\n" + msg);
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<span>▶</span> CONFIRM ORDER`;
    }
  };

  btnGroup.appendChild(cancelBtn2);
  btnGroup.appendChild(submitBtn);
  btnRow.appendChild(note);
  btnRow.appendChild(btnGroup);
  body.appendChild(btnRow);
  form.appendChild(body);
  card.appendChild(form);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  setTimeout(() => fName.inp.focus(), 120);
}

/* =========================================================
   ORDER CONFIRMATION OVERLAY
   ========================================================= */

function showOrderConfirmOverlay(
  addrLines,
  orderRef,
  totalCost,
  totalParts,
  paymentResult,
  savedOrder,
) {
  const existing = document.getElementById("order-confirm-overlay");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "order-confirm-overlay";
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(8,12,20,0.94)",
    zIndex: "10000002",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backdropFilter: "blur(8px)",
    animation: "addrFadeIn 0.2s ease both",
  });

  const card = document.createElement("div");
  Object.assign(card.style, {
    width: "min(460px, 90vw)",
    background: "#18202e",
    border: "1.5px solid rgba(208,88,24,0.3)",
    borderLeft: "3px solid #d05818",
    clipPath: "polygon(0 0,calc(100% - 18px) 0,100% 18px,100% 100%,0 100%)",
    boxShadow: "0 0 60px rgba(0,0,0,0.7),0 0 40px rgba(208,88,24,0.08)",
    padding: "40px 44px 36px",
    textAlign: "center",
    position: "relative",
  });

  const al = document.createElement("div");
  Object.assign(al.style, {
    position: "absolute",
    top: "0",
    left: "0",
    right: "0",
    height: "2px",
    background: "linear-gradient(90deg,transparent,#d05818,transparent)",
  });
  card.appendChild(al);

  const icon = document.createElement("div");
  icon.textContent = "✓";
  Object.assign(icon.style, {
    fontFamily: "'Orbitron',sans-serif",
    fontSize: "44px",
    color: "#d05818",
    lineHeight: "1",
    marginBottom: "14px",
    textShadow: "0 0 40px rgba(208,88,24,0.5)",
  });

  const title = document.createElement("div");
  title.textContent = "ORDER PLACED";
  Object.assign(title.style, {
    fontFamily: "'Orbitron',sans-serif",
    fontSize: "17px",
    fontWeight: "900",
    letterSpacing: "0.2em",
    color: "#d8e8f4",
    marginBottom: "8px",
  });

  const sub = document.createElement("div");
  sub.textContent = "Your MK-1 build has been submitted for production.";
  Object.assign(sub.style, {
    fontFamily: "'Share Tech Mono',monospace",
    fontSize: "10px",
    color: "#384858",
    letterSpacing: "0.1em",
    lineHeight: "1.6",
    marginBottom: "24px",
  });

  const addrBox = document.createElement("div");
  Object.assign(addrBox.style, {
    background: "#111820",
    border: "1px solid #2a3848",
    borderLeft: "3px solid rgba(208,88,24,0.4)",
    padding: "14px 18px",
    textAlign: "left",
    marginBottom: "18px",
  });
  const addrLbl = document.createElement("div");
  addrLbl.textContent = "SHIPPING TO";
  Object.assign(addrLbl.style, {
    fontFamily: "'Orbitron',sans-serif",
    fontSize: "7px",
    fontWeight: "700",
    letterSpacing: "0.3em",
    color: "#d05818",
    marginBottom: "10px",
  });
  addrBox.appendChild(addrLbl);
  addrLines.forEach((line) => {
    const p = document.createElement("div");
    p.textContent = line;
    Object.assign(p.style, {
      fontFamily: "'Share Tech Mono',monospace",
      fontSize: "12px",
      color: "#8aacbf",
      letterSpacing: "0.04em",
      lineHeight: "1.8",
    });
    addrBox.appendChild(p);
  });

  const refEl = document.createElement("div");
  const paymentLine = paymentResult?.razorpay_payment_id
    ? `<br><span style="font-size:9px;color:#2a6848;letter-spacing:0.1em;font-family:'Share Tech Mono',monospace">✓ PAYMENT ID: ${paymentResult.razorpay_payment_id}</span>`
    : `<br><span style="font-size:9px;color:#cc4422;letter-spacing:0.1em;font-family:'Share Tech Mono',monospace">⚠ PAYMENT PENDING</span>`;
  refEl.innerHTML = `ORDER REF: ${orderRef}${paymentLine}${savedOrder ? `<br><span style="font-size:8px;color:#2a3848;letter-spacing:0.12em">DB ID: ${savedOrder.id}</span>` : ""}`;
  Object.assign(refEl.style, {
    fontFamily: "'Orbitron',sans-serif",
    fontSize: "9px",
    fontWeight: "700",
    letterSpacing: "0.2em",
    color: "#384858",
    marginBottom: "24px",
    lineHeight: "1.8",
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "addr-btn addr-btn-submit";
  closeBtn.style.margin = "0 auto";
  closeBtn.style.justifyContent = "center";
  closeBtn.textContent = "START NEW BUILD";
  closeBtn.onclick = () => window.location.reload();

  const printBtn = document.createElement("button");
  printBtn.className = "addr-btn";
  Object.assign(printBtn.style, {
    margin: "0 auto",
    justifyContent: "center",
    background: "transparent",
    borderColor: "#2a6868",
    color: "#4a9898",
    boxShadow: "4px 4px 0 #0e2626",
  });
  printBtn.innerHTML = `<span style="margin-right:8px">▤</span> PRINT DESIGN SUMMARY`;
  printBtn.onclick = () => printDesign();

  const btnGroup = document.createElement("div");
  Object.assign(btnGroup.style, {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    width: "100%",
    alignItems: "center",
  });
  btnGroup.appendChild(closeBtn);
  btnGroup.appendChild(printBtn);

  card.appendChild(icon);
  card.appendChild(title);
  card.appendChild(sub);
  card.appendChild(addrBox);
  card.appendChild(refEl);
  card.appendChild(btnGroup);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
}

/* =========================================================
   SUPABASE — Order saving
   ========================================================= */

async function saveOrderToSupabase({
  orderRef,
  totalCost,
  totalParts,
  customerName,
  customerPhone,
  fLine1,
  fLine2,
  fLine3,
  fCity,
  fState,
  fPin,
}) {
  const amountNum = parseFloat(String(totalCost).replace(/[^0-9.]/g, "")) || 0;

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .insert({
      order_ref: orderRef,
      customer_name: customerName,
      customer_phone: customerPhone,
      address_line1: fLine1.inp.value.trim(),
      address_line2: fLine2.inp.value.trim() || null,
      address_line3: fLine3.inp.value.trim() || null,
      city: fCity.inp.value.trim(),
      state: fState.inp.value.trim(),
      pin: fPin.inp.value.trim(),
      total_amount: amountNum,
      parts_count: totalParts,
      status: "pending",
    })
    .select()
    .single();

  if (orderErr) {
    console.error("[SUPABASE ORDER ERROR]", orderErr);
    throw new Error(
      `Order insert failed: ${orderErr.message} (code: ${orderErr.code ?? "unknown"}, hint: ${orderErr.hint ?? "none"})`,
    );
  }

  const partRows = [];
  const countsByType = {};
  scene.traverse((o) => {
    if (!o.userData?.isMount) return;
    const t = o.userData.type ?? "unknown";
    countsByType[t] = (countsByType[t] ?? 0) + 1;
  });

  for (const [type, qty] of Object.entries(countsByType)) {
    const unitCost = getPrice(type);
    const partLabel = getLabel(type);
    partRows.push({
      order_id: order.id,
      part_type: type,
      part_label: partLabel,
      quantity: qty,
      unit_cost: unitCost,
      total_cost: unitCost * qty,
    });
  }

  if (partRows.length > 0) {
    const { error: partsErr } = await supabase
      .from("order_parts")
      .insert(partRows);
    if (partsErr)
      console.error("[SUPABASE] Parts insert error:", partsErr.message);
  }

  console.log(`[SUPABASE] Order saved: ${order.id} (${orderRef})`);
  return order;
}

async function uploadPrintReport(orderId, orderRef) {
  try {
    showHudMessage("GENERATING REPORT...");
    // Capture all needed angles
    const captureKeys = ["iso", "top", "left", "front"];
    const overlayLabels = {
      iso: "ISOMETRIC",
      top: "TOP",
      left: "LEFT",
      front: "FRONT",
    };
    const angleLabels = {
      iso: "Isometric",
      top: "Top View",
      left: "Side View",
      front: "Front View",
    };

    const screenshots = {};
    for (const key of captureKeys) {
      const raw = captureFromAngle(key);
      screenshots[key] = await addTechnicalOverlay(raw, overlayLabels[key]);
    }

    const reportHTML = buildFullReportHTML(screenshots, angleLabels, orderRef);
    const blob = new Blob([reportHTML], { type: "text/html" });
    const filePath = `orders/${orderId}/${orderRef}_report.html`;

    const { error: uploadErr } = await supabase.storage
      .from("reports")
      .upload(filePath, blob, { contentType: "text/html", upsert: true });
    if (uploadErr) {
      console.error("[REPORT] Storage upload FAILED:", uploadErr.message);
      showHudMessage("⚠ Report storage failed: " + uploadErr.message);
      return;
    }

    const { data: urlData, error: urlErr } = await supabase.storage
      .from("reports")
      .createSignedUrl(filePath, 60 * 60 * 24 * 365);
    if (urlErr) console.error("[REPORT] Signed URL FAILED:", urlErr.message);
    const publicUrl = urlData?.signedUrl ?? null;

    const { error: upsertErr } = await supabase
      .from("print_reports")
      .upsert(
        { order_id: orderId, storage_path: filePath, public_url: publicUrl },
        { onConflict: "order_id" },
      );
    if (upsertErr) {
      console.error("[REPORT] print_reports upsert FAILED:", upsertErr.message);
      showHudMessage("⚠ Report DB save failed: " + upsertErr.message);
      return;
    }

    showHudMessage("REPORT SAVED ✓");
  } catch (err) {
    console.error("[REPORT UPLOAD ERROR]", err);
    showHudMessage("⚠ Report upload failed: " + err.message);
  }
}
function _getDimensions() {
  const box = new THREE.Box3();
  scene.traverse((o) => {
    if (o.userData?.isMount) box.union(new THREE.Box3().setFromObject(o));
  });
  if (box.isEmpty()) return "—";
  const size = box.getSize(new THREE.Vector3());
  const W = (size.x * WORLD_TO_CM).toFixed(1);
  const D = (size.z * WORLD_TO_CM).toFixed(1);
  const H = (size.y * WORLD_TO_CM).toFixed(1);
  return `W ${W}cm × D ${D}cm × H ${H}cm`;
}

function buildFullReportHTML(screenshots, angleLabels, orderRef) {
  const counts = {};
  scene.traverse((o) => {
    if (!o.userData?.isMount) return;
    const t = o.userData.type ?? "unknown";
    counts[t] = (counts[t] ?? 0) + 1;
  });

  const partCostMap = getAllPrices();
  const partLabelMap = getAllLabels();
  const total = document.getElementById("totalPrice")?.textContent ?? "0";
  const totalParts = Object.values(counts).reduce((a, b) => a + b, 0);
  const now = new Date().toLocaleString();

  let computedTotal = 0;
  const manifestRows = Object.entries(counts)
    .map(([t, n]) => {
      const cost = (partCostMap[t] ?? 0) * n;
      computedTotal += cost;
      return `<tr><td>${(partLabelMap[t] ?? t.replace(/_/g, " ")).toUpperCase()}</td><td style="text-align:center">${n}</td><td style="text-align:right;font-family:'Oswald',sans-serif;color:#cc2200">₹${cost.toLocaleString("en-IN")}</td></tr>`;
    })
    .join("");

  let totalGrams = 0;
  const weightRows = Object.entries(counts)
    .map(([t, n]) => {
      const unitG = PART_WEIGHTS[t] ?? 0;
      const lineG = unitG * n;
      totalGrams += lineG;
      const label = (partLabelMap[t] ?? t.replace(/_/g, " ")).toUpperCase();
      const lineDisp =
        lineG >= 1000 ? `${(lineG / 1000).toFixed(2)} kg` : `${lineG} g`;
      return `<tr><td>${label}</td><td style="text-align:center">${n}</td><td style="text-align:right;color:#555">${unitG} g ea</td><td style="text-align:right;font-family:'Oswald',sans-serif;font-weight:600;color:#1a5276">${lineDisp}</td></tr>`;
    })
    .join("");

  const totalWeightDisp =
    totalGrams >= 1000
      ? `${(totalGrams / 1000).toFixed(2)} kg`
      : `${totalGrams} g`;

  const mainShot = screenshots["iso"];
  const secondaryKeys = ["top", "left", "front"];
  const secondaryHTML = secondaryKeys
    .map(
      (k) => `
    <div class="angle-card">
      <div class="angle-label">${angleLabels[k] ?? k}</div>
      <img src="${screenshots[k]}" alt="${angleLabels[k]} view"/>
    </div>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Robot Design — ${orderRef}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&display=swap');

  *{box-sizing:border-box;margin:0;padding:0}

  body{
    background:#fff;
    color:#111;
    font-family:'Oswald',sans-serif;
    font-weight:400;
    padding:22px 28px;
  }

  .print-header{
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    padding-bottom:14px;
    border-bottom:3px solid #1a1a1a;
    margin-bottom:18px;
  }
  .print-title{
    font-family:'Oswald',sans-serif;
    font-size:26px;
    font-weight:700;
    letter-spacing:0.14em;
    color:#111;
    line-height:1;
    text-transform:uppercase;
  }
  .print-subtitle{
    font-family:'Oswald',sans-serif;
    font-size:11px;
    font-weight:300;
    color:#666;
    letter-spacing:0.18em;
    text-transform:uppercase;
    margin-top:6px;
  }
  .print-meta{
    text-align:right;
    font-family:'Oswald',sans-serif;
    font-size:11px;
    font-weight:400;
    color:#555;
    line-height:1.8;
    letter-spacing:0.06em;
  }
  .status-badge{
    display:inline-block;
    padding:2px 10px;
    font-size:9px;
    font-family:'Oswald',sans-serif;
    font-weight:600;
    letter-spacing:0.18em;
    text-transform:uppercase;
    border:1.5px solid;
    margin-top:4px;
  }
  .status-final{color:#166534;border-color:#166534;background:#f0fdf4}
  .status-draft{color:#7f1d1d;border-color:#cc2200;background:#fff5f5}

  .main-view-wrap{
    width:100%;
    border:2px solid #222;
    margin-bottom:8px;
    background:#ffffff;
    overflow:hidden;
    position:relative;
    display:flex;
    align-items:center;
    justify-content:center;
  }
  .main-view-wrap img{
    display:block;
    max-height:480px;
    max-width:100%;
    object-fit:contain;
    margin:0 auto;
    background:#ffffff;
  }
  .main-view-label{
    position:absolute;
    top:10px;
    left:14px;
    font-family:'Oswald',sans-serif;
    font-size:10px;
    font-weight:600;
    letter-spacing:0.22em;
    color:#fff;
    background:rgba(0,0,0,0.6);
    padding:3px 12px;
    text-transform:uppercase;
  }

  .section-title{
    font-family:'Oswald',sans-serif;
    font-size:12px;
    font-weight:700;
    letter-spacing:0.22em;
    color:#111;
    text-transform:uppercase;
    border-left:4px solid #cc2200;
    padding-left:10px;
    margin-bottom:10px;
    margin-top:16px;
  }

  .angles-grid{
    display:grid;
    grid-template-columns:repeat(3,1fr);
    gap:10px;
    margin-bottom:18px;
  }
  .angle-card{
    border:1.5px solid #222;
    background:#ffffff;
    overflow:hidden;
    position:relative;
    display:flex;
    align-items:center;
    justify-content:center;
  }
  .angle-label{
    font-family:'Oswald',sans-serif;
    font-size:9px;
    font-weight:600;
    letter-spacing:0.2em;
    text-transform:uppercase;
    color:#fff;
    background:rgba(0,0,0,0.65);
    padding:3px 10px;
    position:absolute;
    top:0;
    left:0;
    z-index:2;
  }
  .angle-card img{
    width:100%;
    display:block;
    max-height:300px;
    object-fit:contain;
    background:#ffffff;
    margin:0 auto;
  }

  .tables-row{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:14px;
    margin-bottom:16px;
  }
  .table-card{border:1.5px solid #222}
  .table-card-header{
    background:#1a1a1a;
    color:#cc2200;
    font-family:'Oswald',sans-serif;
    font-size:10px;
    font-weight:600;
    letter-spacing:0.2em;
    padding:7px 12px;
    text-transform:uppercase;
  }
  .table-card-header.weight-header{color:#2e86c1}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td{
    padding:6px 10px;
    border-bottom:1px solid #e5e5e5;
    font-family:'Oswald',sans-serif;
    font-weight:400;
    letter-spacing:0.04em;
  }
  th{
    font-family:'Oswald',sans-serif;
    font-weight:600;
    letter-spacing:0.08em;
    font-size:11px;
  }
  tr:last-child td{border-bottom:none}
  tr:nth-child(even) td{background:#fafafa}

  .manifest-subtotal td{
    font-family:'Oswald',sans-serif !important;
    font-size:11px !important;
    font-weight:700 !important;
    color:#cc2200 !important;
    background:#fff5f5 !important;
    border-top:2px solid #cc2200 !important;
    border-bottom:none !important;
    letter-spacing:0.1em;
  }
  .manifest-total-parts td{
    font-family:'Oswald',sans-serif !important;
    font-size:10px !important;
    font-weight:400 !important;
    color:#555 !important;
    background:#f8f8f8 !important;
    border-bottom:none !important;
    letter-spacing:0.08em;
  }
  .weight-total-row td{
    font-family:'Oswald',sans-serif !important;
    font-size:12px !important;
    font-weight:700 !important;
    color:#1a5276 !important;
    background:#eaf4fb !important;
    border-top:2px solid #2e86c1 !important;
    border-bottom:none !important;
    letter-spacing:0.1em;
  }

  .print-footer{
    border-top:1px solid #ccc;
    padding-top:10px;
    display:flex;
    justify-content:space-between;
    align-items:center;
    font-family:'Oswald',sans-serif;
    font-size:10px;
    font-weight:300;
    color:#888;
    letter-spacing:0.1em;
    margin-top:16px;
    text-transform:uppercase;
  }

  .save-pdf-btn{
    display:inline-flex;
    align-items:center;
    gap:8px;
    background:#cc2200;
    color:#fff;
    border:none;
    font-family:'Oswald',sans-serif;
    font-size:11px;
    font-weight:600;
    letter-spacing:0.2em;
    text-transform:uppercase;
    padding:10px 22px;
    cursor:pointer;
    box-shadow:3px 3px 0 #7a1000;
    transition:all 0.12s ease;
  }
  .save-pdf-btn:hover{
    background:#a81a00;
    box-shadow:5px 5px 0 #7a1000;
    transform:translate(-2px,-2px);
  }
  .save-pdf-btn:active{
    transform:translate(1px,1px);
    box-shadow:1px 1px 0 #7a1000;
  }
  .save-pdf-btn svg{
    width:14px;
    height:14px;
    fill:#fff;
    flex-shrink:0;
  }

  @media print{
    .save-pdf-btn{display:none !important}
    .no-print{display:none !important}
    body{padding:12px 16px}
  }
</style>
</head><body>

  <div class="print-header">
    <div>
      <div class="print-title">ROBOT CONFIGURATOR</div>
      <div class="print-subtitle">Design Report · MK-1 Unit · ${orderRef}</div>
    </div>
<div class="print-meta">
      Generated: ${now}<br>
      Parts: ${totalParts} · Weight: ${totalWeightDisp}<br>
      Dimensions: ${_getDimensions()}
    </div>
  </div>

  <div class="main-view-wrap">
    <div class="main-view-label">◈ Isometric View</div>
    <img src="${mainShot}" alt="Isometric View"/>
  </div>

  <div class="section-title">◼ ORTHOGRAPHIC VIEWS WITH DIMENSIONS</div>
  <div class="angles-grid">${secondaryHTML}</div>

  <div class="section-title">◼ COMPONENT DATA</div>
  <div class="tables-row">
    <div class="table-card">
      <div class="table-card-header">Component Manifest</div>
      <table>
        <tr>
          <td><strong>Type</strong></td>
          <td style="text-align:center"><strong>Qty</strong></td>
          <td style="text-align:right"><strong>Cost</strong></td>
        </tr>
        ${manifestRows || "<tr><td colspan='3'>No parts placed</td></tr>"}
        <tr class="manifest-subtotal">
          <td colspan="2">TOTAL COST</td>
          <td style="text-align:right">₹${computedTotal.toLocaleString("en-IN")}</td>
        </tr>
        <tr class="manifest-total-parts">
          <td colspan="3">${totalParts} PARTS · ${Object.keys(counts).length} TYPES</td>
        </tr>
      </table>
    </div>
    <div class="table-card">
      <div class="table-card-header weight-header">Weight Breakdown</div>
      <table>
        <tr>
          <td><strong>Type</strong></td>
          <td style="text-align:center"><strong>Qty</strong></td>
          <td style="text-align:right"><strong>Unit</strong></td>
          <td style="text-align:right"><strong>Total</strong></td>
        </tr>
        ${weightRows || "<tr><td colspan='4'>No parts placed</td></tr>"}
        <tr class="weight-total-row">
          <td colspan="3">TOTAL WEIGHT</td>
          <td style="text-align:right">${totalWeightDisp}</td>
        </tr>
      </table>
    </div>
  </div>

  <div class="print-footer">
    <span>ROBOT CONFIGURATOR v1.0 — UNIT MK-1</span>
    <span>ORDER REF: ${orderRef}</span>
    <span>${now}</span>
  </div>

  <!-- ── SAVE PDF BUTTON BAR ── -->
  <div class="no-print" style="display:flex;justify-content:flex-end;margin-top:18px;">
    <button class="save-pdf-btn" onclick="window.print()">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/>
      </svg>
      SAVE AS PDF
    </button>
  </div>

</body></html>`;
}
/* =========================================================
   TECHNICAL OVERLAY
   ========================================================= */

function addTechnicalOverlay(dataURL, viewLabel) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const W = img.naturalWidth || 1200;
      const H = img.naturalHeight || 600;

      // ── Draw full image onto a working canvas ─────────────────────
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, W, H);

      // ── Detect model bounding box (non-background pixels) ─────────
      const imageData = ctx.getImageData(0, 0, W, H);
      const data = imageData.data;

      // Sample the actual background colour from the four corners
      function getPixel(x, y) {
        const i = (y * W + x) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      }
      const corners = [
        getPixel(0, 0),
        getPixel(W - 1, 0),
        getPixel(0, H - 1),
        getPixel(W - 1, H - 1),
      ];
      const bgR = Math.round(corners.reduce((s, c) => s + c[0], 0) / 4);
      const bgG = Math.round(corners.reduce((s, c) => s + c[1], 0) / 4);
      const bgB = Math.round(corners.reduce((s, c) => s + c[2], 0) / 4);
      const BG_TOL = 28; // tolerance — pixels within this distance from bg colour are background

      let minX = W,
        maxX = 0,
        minY = H,
        maxY = 0;
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const i = (py * W + px) * 4;
          const a = data[i + 3];
          if (a < 128) continue;
          const dr = data[i] - bgR;
          const dg = data[i + 1] - bgG;
          const db = data[i + 2] - bgB;
          const dist = Math.sqrt(dr * dr + dg * dg + db * db);
          if (dist > BG_TOL) {
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
          }
        }
      }
      if (maxX <= minX + 20 || maxY <= minY + 20) {
        minX = Math.round(W * 0.25);
        maxX = Math.round(W * 0.75);
        minY = Math.round(H * 0.2);
        maxY = Math.round(H * 0.8);
      }

      // ── Tight crop with uniform padding ───────────────────────────
      // Extra padding for orthographic views to leave room for dim arrows
      const isIsoOrPersp =
        viewLabel === "ISOMETRIC" || viewLabel === "PERSPECTIVE";
      const CROP_PAD = isIsoOrPersp
        ? Math.round(Math.max(W, H) * 0.06) // ISO: small padding
        : Math.round(Math.max(W, H) * 0.1); // Ortho: extra space for arrows

      const cropX = Math.max(0, minX - CROP_PAD);
      const cropY = Math.max(0, minY - CROP_PAD);
      const cropW = Math.min(W, maxX + CROP_PAD) - cropX;
      const cropH = Math.min(H, maxY + CROP_PAD) - cropY;

      // Create final canvas at cropped size
      const out = document.createElement("canvas");
      out.width = cropW;
      out.height = cropH;
      const octx = out.getContext("2d");

      // Fill background to match render bg colour
      octx.fillStyle = "#e8edf2";
      octx.fillRect(0, 0, cropW, cropH);

      // Draw cropped region
      octx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      // ── Grid on cropped canvas ─────────────────────────────────────
      const GRID = Math.round(cropW / 20);
      octx.save();
      octx.strokeStyle = "rgba(100,120,140,0.12)";
      octx.lineWidth = 0.6;
      for (let x = 0; x <= cropW; x += GRID) {
        octx.beginPath();
        octx.moveTo(x, 0);
        octx.lineTo(x, cropH);
        octx.stroke();
      }
      for (let y = 0; y <= cropH; y += GRID) {
        octx.beginPath();
        octx.moveTo(0, y);
        octx.lineTo(cropW, y);
        octx.stroke();
      }
      octx.strokeStyle = "rgba(80,110,140,0.22)";
      octx.lineWidth = 1;
      for (let x = 0; x <= cropW; x += GRID * 4) {
        octx.beginPath();
        octx.moveTo(x, 0);
        octx.lineTo(x, cropH);
        octx.stroke();
      }
      for (let y = 0; y <= cropH; y += GRID * 4) {
        octx.beginPath();
        octx.moveTo(0, y);
        octx.lineTo(cropW, y);
        octx.stroke();
      }
      octx.restore();

      // ── Dimension arrows (ortho views only) ───────────────────────
      if (!isIsoOrPersp) {
        // Model bounds in cropped coords
        const mX0 = minX - cropX,
          mX1 = maxX - cropX;
        const mY0 = minY - cropY,
          mY1 = maxY - cropY;

        const PAD = CROP_PAD * 0.55;
        const LW = Math.max(1.5, cropW / 600);
        const AH = Math.max(7, cropW / 110);
        const TICK = Math.max(5, cropW / 160);
        const FONT_SZ = Math.max(13, cropW / 70);
        const LABEL_H = FONT_SZ + 6;
        const LABEL_P = Math.round(FONT_SZ * 0.35);

        function dimArrow(x1, y1, x2, y2, label) {
          octx.save();
          octx.strokeStyle = "rgba(140,20,0,1)";
          octx.fillStyle = "rgba(140,20,0,1)";
          octx.lineWidth = LW;
          octx.font = `bold ${FONT_SZ}px 'Courier New', monospace`;
          octx.textBaseline = "middle";
          const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
          octx.beginPath();
          octx.moveTo(x1, y1);
          octx.lineTo(x2, y2);
          octx.stroke();
          function arrowhead(ax, ay, dir) {
            octx.beginPath();
            if (horizontal) {
              octx.moveTo(ax, ay);
              octx.lineTo(ax - dir * AH, ay - AH * 0.45);
              octx.lineTo(ax - dir * AH, ay + AH * 0.45);
            } else {
              octx.moveTo(ax, ay);
              octx.lineTo(ax - AH * 0.45, ay - dir * AH);
              octx.lineTo(ax + AH * 0.45, ay - dir * AH);
            }
            octx.closePath();
            octx.fill();
          }
          arrowhead(x1, y1, -1);
          arrowhead(x2, y2, 1);
          function tick(ax, ay) {
            octx.beginPath();
            if (horizontal) {
              octx.moveTo(ax, ay - TICK);
              octx.lineTo(ax, ay + TICK);
            } else {
              octx.moveTo(ax - TICK, ay);
              octx.lineTo(ax + TICK, ay);
            }
            octx.stroke();
          }
          tick(x1, y1);
          tick(x2, y2);
          const mx = (x1 + x2) / 2,
            my = (y1 + y2) / 2,
            tw = octx.measureText(label).width;
          octx.fillStyle = "rgba(255,255,255,0.93)";
          octx.fillRect(
            mx - tw / 2 - LABEL_P,
            my - LABEL_H / 2,
            tw + LABEL_P * 2,
            LABEL_H,
          );
          octx.strokeStyle = "rgba(200,50,0,0.6)";
          octx.lineWidth = Math.max(1, LW * 0.6);
          octx.strokeRect(
            mx - tw / 2 - LABEL_P,
            my - LABEL_H / 2,
            tw + LABEL_P * 2,
            LABEL_H,
          );
          octx.fillStyle = "rgba(140,20,0,1)";
          octx.textAlign = "center";
          octx.fillText(label, mx, my + 1);
          octx.restore();
        }

        const widthY = Math.min(mY1 + PAD, cropH - LABEL_H - 4);
        dimArrow(mX0, widthY, mX1, widthY, "WIDTH");
        const heightX = Math.min(mX1 + PAD, cropW - LABEL_H - 4);
        dimArrow(heightX, mY0, heightX, mY1, "HEIGHT");
      }

      resolve(out.toDataURL("image/png"));
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}

/* =========================================================
   PRINT DESIGN
   ========================================================= */

async function printDesign() {
  showHudMessage("CAPTURING VIEWS...");

  setTimeout(async () => {
    const captureKeys = ["iso", "top", "left", "front"];
    const overlayLabels = {
      iso: "ISOMETRIC",
      top: "TOP",
      left: "LEFT",
      front: "FRONT",
    };
    const angleLabels = {
      iso: "Isometric",
      top: "Top View",
      left: "Side View",
      front: "Front View",
    };

    const rawScreenshots = {};
    for (const key of captureKeys) rawScreenshots[key] = captureFromAngle(key);
    const screenshots = {};
    for (const key of captureKeys)
      screenshots[key] = await addTechnicalOverlay(
        rawScreenshots[key],
        overlayLabels[key],
      );

    const printHTML = buildFullReportHTML(
      screenshots,
      angleLabels,
      "PRINT-" + Date.now().toString(36).toUpperCase(),
    );
    const win = window.open("", "_blank", "width=1100,height=900");
    win.document.write(printHTML);
    win.document.close();
    showHudMessage("PRINT DESIGN SUMMARY READY ✓");
  }, 100);
}

/* =========================================================
   SHORTCUT BAR
   ========================================================= */

let shortcutBarEl = null;
let shortcutBarVisible = false;

function getPanelWidthPx() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--panel-w")
    .trim();
  return parseFloat(raw) || 300;
}

function toggleShortcutBar() {
  shortcutBarVisible = !shortcutBarVisible;
  if (shortcutBarEl) {
    shortcutBarEl.style.transform = shortcutBarVisible
      ? "translateY(0)"
      : "translateY(100%)";
    shortcutBarEl.style.opacity = shortcutBarVisible ? "1" : "0";
  }
  const helpBtn = document.getElementById("help-toggle-btn");
  if (helpBtn) {
    helpBtn.classList.toggle("help-btn-active", shortcutBarVisible);
    helpBtn.title = shortcutBarVisible ? "Hide shortcuts" : "Show shortcuts";
    helpBtn.style.bottom = shortcutBarVisible ? "40px" : "10px";
  }
}

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
    { key: "ESC / CLICK", action: "Exit mode" },
    { key: "CTRL+Z", action: "Undo last" },
  ],
  motor: [
    { key: "HOVER", action: "Auto-orient" },
    { key: "CLICK", action: "Place motor" },
    { key: "ESC / CLICK", action: "Exit mode" },
  ],
  triangle: [
    { key: "HOVER", action: "Auto-orient" },
    { key: "← →", action: "Flip 180°" },
    { key: "CLICK", action: "Place triangle" },
    { key: "ESC / CLICK", action: "Exit mode" },
  ],
  support: [
    { key: "CLICK 1", action: "Pick first socket" },
    { key: "CLICK 2", action: "Pick second socket" },
    { key: "← →", action: "Rotate 90°" },
    { key: "ESC / CLICK", action: "Cancel / Exit" },
  ],
  wheel: [
    { key: "CLICK", action: "Snap wheel" },
    { key: "ESC / CLICK", action: "Exit mode" },
  ],
};

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
  modeLabel.style.borderRight = "1px solid rgba(208,88,24,0.25)";
  modeLabel.textContent = mc.label;
  shortcutBarEl.appendChild(modeLabel);

  if (queuedIntent) {
    const chainEl = document.createElement("div");
    chainEl.className = "sb-chain-label";
    const placed = countPlaced(queuedIntent.requiredType);
    const need = queuedIntent.requiredCount - placed;
    chainEl.innerHTML = `<span style="color:#cc2200">⟳</span><span>QUEUED: ${queuedIntent.label} — ${need} more needed</span>`;
    chainEl.style.borderRight = "1px solid rgba(204,34,0,0.15)";
    shortcutBarEl.appendChild(chainEl);
  }

  const defs = SHORTCUT_DEFS[mode] || SHORTCUT_DEFS.idle;
  const patchedDefs = defs.map((d) => {
    if (mode === "frame" && d.key === "← →")
      return {
        key: "← →",
        action: `Rotate on support (${(((frameOnSupportRotationSteps % 4) + 4) % 4) * 90}°)`,
      };
    if (mode === "triangle" && d.key === "← →")
      return {
        key: "← →",
        action: `flip ${triangleManualRotSteps === 0 ? "0°→180°" : "180°→0°"}`,
      };
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

function initShortcutBar() {
  shortcutBarEl = document.createElement("div");
  shortcutBarEl.id = "shortcut-bar";
  const pw = getPanelWidthPx();
  Object.assign(shortcutBarEl.style, {
    position: "fixed",
    bottom: "0",
    left: `${pw}px`,
    right: `${pw}px`,
    height: "40px",
    background: "rgba(12,18,28,0.98)",
    borderTop: "1px solid rgba(208,88,24,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0",
    zIndex: "9000",
    backdropFilter: "blur(8px)",
    overflow: "hidden",
    transform: "translateY(100%)",
    opacity: "0",
    transition: "transform 0.25s ease, opacity 0.2s ease",
    boxShadow: "0 -4px 24px rgba(0,0,0,0.5)",
  });
  document.body.appendChild(shortcutBarEl);

  const helpBtn = document.createElement("button");
  helpBtn.id = "help-toggle-btn";
  helpBtn.title = "Show shortcuts";
  helpBtn.innerHTML = `<span style="display:flex;flex-direction:column;align-items:center;gap:0px;line-height:0.75;pointer-events:none"><span style="transform:rotate(90deg);display:block;font-size:13px;font-weight:900">❯</span><span style="transform:rotate(90deg);display:block;font-size:13px;font-weight:900">❯</span></span>`;
  Object.assign(helpBtn.style, {
    position: "fixed",
    bottom: "10px",
    width: "38px",
    height: "34px",
    background: "rgba(12,18,28,0.95)",
    border: "2px solid rgba(208,88,24,0.6)",
    color: "#d05818",
    cursor: "pointer",
    zIndex: "9001",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "bottom 0.25s ease, background 0.15s, border-color 0.15s",
    backdropFilter: "blur(6px)",
    borderRadius: "4px",
    boxShadow: "0 3px 0 rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)",
  });

  function positionHelpBtn() {
    const vpW = window.innerWidth - getPanelWidthPx() * 2;
    helpBtn.style.left = `${getPanelWidthPx() + vpW / 2 - 19}px`;
  }
  positionHelpBtn();
  helpBtn.addEventListener("click", toggleShortcutBar);
  document.body.appendChild(helpBtn);

  window.addEventListener("resize", () => {
    const newPw = getPanelWidthPx();
    shortcutBarEl.style.left = `${newPw}px`;
    shortcutBarEl.style.right = `${newPw}px`;
    positionHelpBtn();
  });

  if (!document.getElementById("sb-kf")) {
    const s = document.createElement("style");
    s.id = "sb-kf";
    s.textContent = `
      @keyframes sbItemIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
      .sb-sep{width:1px;height:18px;background:rgba(208,88,24,0.2);flex-shrink:0;margin:0}
      .sb-item{display:flex;align-items:center;gap:7px;padding:0 16px;height:100%;animation:sbItemIn 0.18s ease both;cursor:default;flex-shrink:0;transition:background 0.15s}
      .sb-item:hover{background:rgba(208,88,24,0.07)}
      .sb-key{font-family:'Orbitron',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;color:#e87030;background:rgba(208,88,24,0.15);border:1.5px solid rgba(208,88,24,0.5);padding:3px 8px;white-space:nowrap;line-height:1.4}
      .sb-action{font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:0.08em;color:#8aacbf;text-transform:uppercase;white-space:nowrap}
      .sb-mode-label{font-family:'Orbitron',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.2em;padding:0 18px;text-transform:uppercase;flex-shrink:0;white-space:nowrap;border-right:1px solid rgba(208,88,24,0.25);height:100%;display:flex;align-items:center}
      .sb-chain-label{font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:0.1em;color:#e87030;padding:0 14px;flex-shrink:0;white-space:nowrap;display:flex;align-items:center;gap:7px;border-right:1px solid rgba(208,88,24,0.2)}
      #help-toggle-btn.help-btn-active{background:rgba(208,88,24,0.25)!important;border-color:#d05818!important;box-shadow:0 3px 0 rgba(0,0,0,0.6),0 0 12px rgba(208,88,24,0.3)!important}
    `;
    document.head.appendChild(s);
  }

  updateShortcutBar();
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
   PLACEMENT RULES
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
      o.material.opacity = 0.45;
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
  destroyContextMenu();
  document
    .querySelectorAll(".btn.active-mode")
    .forEach((b) => b.classList.remove("active-mode"));
  if (ghost) scene.remove(ghost);
  ghost = null;
  motorRotationGroup = null;
  placementMode = null;
  document.body.classList.remove("placement-mode");
  applySocketHighlights();
  frameOnSupportRotationSteps = 0;
  frameOnSupportAutoYaw = 0;
  frameHoverType = "frame";
  currentHoveredSupportSocket = null;
  motorAutoBaseYaw = 0;
  motorManualRotSteps = 0;
  supportManualRotSteps = 0;
  supportFirstSocket = null;
  if (supportFirstMarker) {
    supportFirstMarker.material = MAT_TRI_ACTIVE;
    supportFirstMarker.scale.setScalar(1.5);
    supportFirstMarker = null;
  }
  setHoverMesh(null, null);
  hideTooltip();
  frameOnSupportMarkers.forEach((m) => {
    m.material = supportFrameSocketMat;
  });
  triangleAutoBaseYaw = 0;
  triangleManualRotSteps = 0;
  lastHoveredTriangleSocketUUID = null;
  if (hoveredTriangleMarker) {
    hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
    hoveredTriangleMarker.scale.setScalar(1.5);
    hoveredTriangleMarker = null;
  }
  hideInstructionPanel();
  hideRotationControls();
  clearQueuedIntent();
  updateShortcutBar();
  updateLegendHighlight();
  clearTimeout(idleTimer);
  hideComponentPreview();
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
   SCREEN-SPACE PROXIMITY SNAP
   ========================================================= */

function findNearestMarkerOnScreen(markers, thresholdPx) {
  thresholdPx = thresholdPx !== undefined ? thresholdPx : 40;
  const canvas = renderer.domElement;
  const rect = canvas.getBoundingClientRect();
  const mouseScreenX = ((mouse.x + 1) / 2) * rect.width;
  const mouseScreenY = ((1 - mouse.y) / 2) * rect.height;
  let best = null,
    bestDist = thresholdPx;
  for (const m of markers) {
    if (!m.visible) continue;
    const projected = m.position.clone().project(camera);
    if (projected.z > 1) continue;
    const sx = ((projected.x + 1) / 2) * rect.width;
    const sy = ((1 - projected.y) / 2) * rect.height;
    const d = Math.hypot(sx - mouseScreenX, sy - mouseScreenY);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best;
}

/* =========================================================
   MESH-LEVEL EMISSIVE HELPERS
   ========================================================= */

function resolveMeshAndMount(obj) {
  let mount = null,
    o = obj;
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
  if (!mesh._origMat) {
    mesh._origMat = mesh.material;
    mesh.material = mesh.material.clone();
  }
  const prev = mesh.material.emissive.clone();
  mesh.material.emissive.set(colorHex);
  return prev;
}

function restoreMeshEmissive(mesh, savedColor) {
  if (!mesh?.material) return;
  if (mesh._origMat) {
    mesh.material.dispose();
    mesh.material = mesh._origMat;
    delete mesh._origMat;
  } else if (mesh.material.emissive) mesh.material.emissive.copy(savedColor);
}

let hoveredMeshes = [];
let selectedMeshes = [];

/* =========================================================
   RESIZE
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
    ...triangleMarkers,
    ...frameOnSupportMarkers,
    ...wheelMarkers,
  ].forEach((m) => scene.remove(m));
  frameMarkers = [];
  motorMarkers = [];
  triangleSocketMarkers = [];
  stressConnectorMarkers = [];
  triangleMarkers = [];
  frameOnSupportMarkers = [];
  wheelMarkers = [];
  scene.updateMatrixWorld(true);

  const suppressedSockets = new Set();
  const SOCKET_MERGE_DIST = 0.12;
  const usedFramePositions = [];

  scene.traverse((o) => {
    if (!o.name || !isSocketNode(o.name)) return;
    if (!usedSockets.has(o.uuid)) return;
    if (!o.name.startsWith("SOCKET_FRAME")) return;
    const wp = new THREE.Vector3();
    o.getWorldPosition(wp);
    usedFramePositions.push(wp);
  });

  if (usedFramePositions.length > 0) {
    scene.traverse((o) => {
      if (!o.name || !isSocketNode(o.name)) return;
      if (
        o.name.startsWith("SOCKET_MOTOR") ||
        o.name.startsWith("WHEEL_SOCKET")
      )
        return;
      if (usedSockets.has(o.uuid) || suppressedSockets.has(o.uuid)) return;
      if (ghost && isDescendantOf(o, ghost)) return;
      const wp = new THREE.Vector3();
      o.getWorldPosition(wp);
      for (const up of usedFramePositions) {
        if (wp.distanceTo(up) < SOCKET_MERGE_DIST) {
          suppressedSockets.add(o.uuid);
          break;
        }
      }
    });
  }

  const FRAME_JOINT_DIST = 0.25;
  const mountFrameSockets = [];
  scene.traverse((o) => {
    if (!o.name || !o.name.startsWith("SOCKET_FRAME")) return;
    if (usedSockets.has(o.uuid) || suppressedSockets.has(o.uuid)) return;
    if (ghost && isDescendantOf(o, ghost)) return;
    let mount = o.parent;
    while (mount && !mount.userData?.isMount) mount = mount.parent;
    if (!mount) return;
    const wp = new THREE.Vector3();
    o.getWorldPosition(wp);
    mountFrameSockets.push({ mount, uuid: o.uuid, wp });
  });

  for (let i = 0; i < mountFrameSockets.length; i++) {
    for (let j = i + 1; j < mountFrameSockets.length; j++) {
      if (mountFrameSockets[i].mount === mountFrameSockets[j].mount) continue;
      if (
        mountFrameSockets[i].wp.distanceTo(mountFrameSockets[j].wp) <
        FRAME_JOINT_DIST
      ) {
        suppressedSockets.add(mountFrameSockets[i].uuid);
        suppressedSockets.add(mountFrameSockets[j].uuid);
      }
    }
  }

  scene.traverse((o) => {
    if (!o.name || usedSockets.has(o.uuid) || suppressedSockets.has(o.uuid))
      return;
    if (ghost && isDescendantOf(o, ghost)) return;
    if (o.name.toUpperCase() === "SOCKET_FRAME_SUPPORT_B") {
      let parentMount = o.parent;
      while (parentMount && !parentMount.userData?.isMount)
        parentMount = parentMount.parent;
      if (parentMount && parentMount.userData.type === "support_frame") return;
    }
    if (o.name.startsWith("SOCKET_FRAME_SUPPORT")) {
      addMarker(o, frameOnSupportMarkers, supportFrameSocketMat);
      return;
    }
    if (o.name.startsWith("SOCKET_FRAME")) {
      const upper = o.name.toUpperCase();
      // Motor attachment sockets on frames (e.g. SOCKET_FRAME_MOTOR_*) → motorMarkers, NOT frameMarkers
      if (upper.includes("MOTOR")) {
        addMarker(o, motorMarkers, motorMat);
        return;
      }
      // Wheel attachment sockets on frames → wheelMarkers
      if (upper.includes("WHEEL")) {
        addMarker(o, wheelMarkers, wheelSocketMat);
        return;
      }
      // Guard: skip any SOCKET_FRAME_* that lives on a non-frame mount
      // (e.g. SOCKET_FRAME_CONNECTOR on triangle_frame models)
      let parentMount = o.parent;
      while (parentMount && !parentMount.userData?.isMount)
        parentMount = parentMount.parent;
      if (parentMount && parentMount.userData.type !== "frame") return;
      addMarker(o, frameMarkers, frameMat);
      return;
    }
    if (o.name.startsWith("SOCKET_MOTOR")) addMarker(o, motorMarkers, motorMat);
    if (o.name.startsWith("WHEEL_SOCKET"))
      addMarker(o, wheelMarkers, wheelSocketMat);
    if (o.name.startsWith("SOCKET_TRIANGLE"))
      addMarker(o, triangleSocketMarkers, frameMat);
    if (o.name.startsWith("SOCKET_STRESS_CONNECTOR"))
      addMarker(o, stressConnectorMarkers, frameMat);
  });

  triangleMarkers = [...triangleSocketMarkers, ...stressConnectorMarkers];
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

const MAT_FRAME_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xd06010 });
const MAT_FRAME_DIM = new THREE.MeshBasicMaterial({
  color: 0x2a1a08,
  transparent: true,
  opacity: 0.22,
});
const MAT_MOTOR_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xe87830 });
const MAT_MOTOR_DIM = new THREE.MeshBasicMaterial({
  color: 0x2a1004,
  transparent: true,
  opacity: 0.18,
});
const MAT_SUPPORT_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xd06010 });
const MAT_SUPPORT_DIM = new THREE.MeshBasicMaterial({
  color: 0x2a1a08,
  transparent: true,
  opacity: 0.18,
});
const MAT_WHEEL_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xb84a14 });
const MAT_WHEEL_DIM = new THREE.MeshBasicMaterial({
  color: 0x1e0a04,
  transparent: true,
  opacity: 0.18,
});
const MAT_TRI_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xe87030 });
const MAT_TRI_DIM = new THREE.MeshBasicMaterial({
  color: 0x2a1004,
  transparent: true,
  opacity: 0.18,
});
const MAT_MOTOR_HOVER = new THREE.MeshBasicMaterial({ color: 0xffcc60 });
const MAT_TRI_HOVER = new THREE.MeshBasicMaterial({ color: 0xffaa40 });

let hoveredMotorMarker = null;

function addMarker(socket, list, mat) {
  const m = new THREE.Mesh(socketGeo, mat);
  socket.getWorldPosition(m.position);
  m.userData.socket = socket;
  list.push(m);
  scene.add(m);
}

/* =========================================================
   VALID STRESS CONNECTOR FILTER
   ========================================================= */

function getValidStressConnectorSockets() {
  scene.updateMatrixWorld(true);
  const valid = [];
  for (const marker of stressConnectorMarkers) {
    const socketA = marker.userData.socket;
    if (socketA && !usedSockets.has(socketA.uuid)) valid.push(marker);
  }
  return valid;
}

function applySocketHighlights() {
  const mode = placementMode;
  // Hide ALL markers and reset their scale so pulsing from a previous mode doesn't bleed through
  [
    ...frameMarkers,
    ...frameOnSupportMarkers,
    ...motorMarkers,
    ...triangleSocketMarkers,
    ...stressConnectorMarkers,
    ...wheelMarkers,
  ].forEach((m) => {
    m.visible = false;
    m.scale.setScalar(1);
  });

  if (mode === "frame") {
    frameMarkers.forEach((m) => {
      m.visible = true;
      m.material = MAT_FRAME_ACTIVE;
      m.scale.setScalar(1.5);
    });
    frameOnSupportMarkers.forEach((m) => {
      m.visible = true;
      m.material = MAT_SUPPORT_ACTIVE;
      m.scale.setScalar(1.5);
    });
    // Explicitly keep these off — belt-and-suspenders
    motorMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    wheelMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    triangleSocketMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    stressConnectorMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
  }
  if (mode === "motor") {
    motorMarkers.forEach((m) => {
      m.visible = true;
      m.material = MAT_MOTOR_ACTIVE;
      m.scale.setScalar(1.5);
    });
    frameMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    frameOnSupportMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    wheelMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
  }
  if (mode === "triangle") {
    triangleSocketMarkers.forEach((m) => {
      m.visible = true;
      m.material = MAT_TRI_ACTIVE;
      m.scale.setScalar(1.5);
    });
    motorMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    wheelMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    frameMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    stressConnectorMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
  }
  if (mode === "support") {
    const validSet = new Set(getValidStressConnectorSockets());
    stressConnectorMarkers.forEach((m) => {
      if (validSet.has(m)) {
        m.visible = true;
        m.material = MAT_TRI_ACTIVE;
        m.scale.setScalar(1.5);
      } else {
        m.visible = false;
        m.scale.setScalar(1);
      }
    });
    motorMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    wheelMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    frameMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    triangleSocketMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
  }
  if (mode === "wheel") {
    wheelMarkers.forEach((m) => {
      m.visible = true;
      m.material = MAT_WHEEL_ACTIVE;
      m.scale.setScalar(1.5);
    });
    motorMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    frameMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    frameOnSupportMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    triangleSocketMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
    stressConnectorMarkers.forEach((m) => {
      m.visible = false;
      m.scale.setScalar(1);
    });
  }
  hoveredMotorMarker = null;
}

/* =========================================================
   PLACEMENT MODES
   ========================================================= */

function showRotationControls(mode) {
  const el = document.getElementById("viewport-rot-controls");
  if (el) el.style.display = "flex";
}
function hideRotationControls() {
  const el = document.getElementById("viewport-rot-controls");
  if (el) el.style.display = "none";
}
function updateRotationDisplay() {}

function flashArrowKey(direction) {
  const id = direction === "left" ? "arrowKeyLeft" : "arrowKeyRight";
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("arrow-key-pressed");
  setTimeout(() => el.classList.remove("arrow-key-pressed"), 180);
}

function updateWheelButtonState() {
  const btn = document.getElementById("addWheelBtn");
  if (!btn) return;
  const shouldEnable = countPlaced("motor") > 0 && wheelMarkers.length > 0;
  btn.disabled = !shouldEnable;
  btn.style.opacity = shouldEnable ? "1" : "0.35";
  btn.style.pointerEvents = shouldEnable ? "auto" : "none";
}

function updateSupportButtonState() {
  const btn = document.getElementById("addSupportFrame");
  if (!btn) return;
  const shouldEnable =
    countPlaced("triangle_frame") >= 2 && stressConnectorMarkers.length > 0;
  btn.disabled = !shouldEnable;
  btn.style.opacity = shouldEnable ? "1" : "0.35";
  btn.style.pointerEvents = shouldEnable ? "auto" : "none";
}

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
  document.body.classList.add("placement-mode");
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
  ghost.position.set(0, -9999, 0);
  showComponentPreview("motor", motorTemplate);
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
  document.body.classList.add("placement-mode");
  applySocketHighlights();
  updateShortcutBar();
  updateLegendHighlight();
  showInstructionPanel("frame");
  ghost = frameTemplate.clone(true);
  makeGhost(ghost);
  scene.add(ghost);
  ghost.position.set(0, -9999, 0);
  showComponentPreview("frame", frameTemplate);
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
  document.body.classList.add("placement-mode");
  applySocketHighlights();
  updateShortcutBar();
  updateLegendHighlight();
  showInstructionPanel("triangle");
  ghost = triangleTemplate.clone(true);
  makeGhost(ghost);
  scene.add(ghost);
  ghost.position.set(0, -9999, 0);
  showRotationControls("triangle");
  showComponentPreview("triangle_frame", triangleTemplate);
}

function startSupportPlacement() {
  hideIdleArrows();
  clearTimeout(idleTimer);
  if (countPlaced("triangle_frame") < 2) {
    const need = 2 - countPlaced("triangle_frame");
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
  document.body.classList.add("placement-mode");
  applySocketHighlights();
  updateShortcutBar();
  updateLegendHighlight();
  showInstructionPanel("support");
  ghost = supportTemplate.clone(true);
  makeGhost(ghost);
  scene.add(ghost);
  ghost.position.set(0, -9999, 0);
  showComponentPreview("support_frame", supportTemplate);
}

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
  document.body.classList.add("placement-mode");
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
  ghost.position.set(0, -9999, 0);
  showComponentPreview("wheel", wheelTemplate);
}

/* =========================================================
   PLACEMENT RESTART
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
    lastHoveredTriangleSocketUUID = null;
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
  if (mode === "frame") frameHoverType = "frame";

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
  updateWheelButtonState();
  updateSupportButtonState();
  applySocketHighlights();
  updateShortcutBar();
}

/* =========================================================
   SUPPORT FRAME HELPERS
   ========================================================= */

function buildTriangleMountMap() {
  const mountMap = new Map();
  scene.traverse((o) => {
    if (!o.name?.startsWith("SOCKET_STRESS_CONNECTOR")) return;
    if (usedSockets.has(o.uuid)) return;
    if (ghost && isDescendantOf(o, ghost)) return;
    let m = o.parent;
    while (m && !m.userData?.isMount) m = m.parent;
    if (!m || m.userData.type !== "triangle_frame") return;
    o.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    o.getWorldPosition(pos);
    if (!mountMap.has(m)) mountMap.set(m, []);
    mountMap.get(m).push({ socket: o, pos });
  });
  return mountMap;
}

function canPlaceSupportBridge() {
  return buildTriangleMountMap().size >= 2;
}

function getParentRectFrame(triMount) {
  const attachSocket = triMount.userData?.socket;
  if (!attachSocket) return null;
  let p = attachSocket.parent;
  while (p && !p.userData?.isMount) p = p.parent;
  return p ?? null;
}

function resolveBestSupportSocketPair(clickedSocket) {
  scene.updateMatrixWorld(true);
  clickedSocket.updateMatrixWorld(true);
  const mountMap = buildTriangleMountMap();
  if (mountMap.size < 2) return null;
  let clickedMount = clickedSocket.parent;
  while (clickedMount && !clickedMount.userData?.isMount)
    clickedMount = clickedMount.parent;
  if (!clickedMount || !mountMap.has(clickedMount)) return null;
  const rectFrameA = getParentRectFrame(clickedMount);
  let bestSocketA = null,
    bestSocketB = null,
    bestPosA = null,
    bestPosB = null,
    bestDist = Infinity;
  for (const entryA of mountMap.get(clickedMount)) {
    for (const [mount, entries] of mountMap) {
      if (mount === clickedMount) continue;
      const rectFrameB = getParentRectFrame(mount);
      if (rectFrameA && rectFrameB && rectFrameA !== rectFrameB) continue;
      for (const entryB of entries) {
        const dist = entryA.pos.distanceTo(entryB.pos);
        if (dist < bestDist) {
          bestDist = dist;
          bestSocketA = entryA.socket;
          bestSocketB = entryB.socket;
          bestPosA = entryA.pos.clone();
          bestPosB = entryB.pos.clone();
        }
      }
    }
  }
  if (!bestSocketA || !bestSocketB) return null;
  return {
    socketA: bestSocketA,
    posA: bestPosA,
    socketB: bestSocketB,
    posB: bestPosB,
  };
}

function applyTwoPointSupportSnap(
  mountGroup,
  connectorRoot,
  posA,
  posB,
  manualSteps,
  sourceSocket,
) {
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
  const targetY = posB ? (posA.y + posB.y) / 2 : posA.y;
  if (connL && connR && posB) {
    const lWorld0 = new THREE.Vector3(),
      rWorld0 = new THREE.Vector3();
    connL.getWorldPosition(lWorld0);
    connR.getWorldPosition(rWorld0);
    const connSpanX = rWorld0.x - lWorld0.x,
      connSpanZ = rWorld0.z - lWorld0.z;
    const targetSpanX = posB.x - posA.x,
      targetSpanZ = posB.z - posA.z;
    const fromAngle = Math.atan2(connSpanX, connSpanZ),
      toAngle = Math.atan2(targetSpanX, targetSpanZ);
    const baseYaw = toAngle - fromAngle;
    let bestYaw = baseYaw,
      bestConnector = connL,
      bestError = Infinity,
      bestFacingScore = -Infinity;
    let triFrontWorld = new THREE.Vector3();
    if (sourceSocket) {
      let triMount = sourceSocket.parent;
      while (triMount && !triMount.userData?.isMount)
        triMount = triMount.parent;
      if (triMount) {
        const triBox = new THREE.Box3().setFromObject(triMount),
          triCenter = triBox.getCenter(new THREE.Vector3());
        const socketPos = new THREE.Vector3();
        sourceSocket.getWorldPosition(socketPos);
        triFrontWorld.subVectors(socketPos, triCenter);
        triFrontWorld.y = 0;
        if (triFrontWorld.lengthSq() > 0.0001) triFrontWorld.normalize();
      }
    }
    for (const yaw of [baseYaw, baseYaw + Math.PI]) {
      mountGroup.rotation.set(0, yaw, 0);
      mountGroup.updateMatrixWorld(true);
      for (const [snap, other] of [
        [connL, connR],
        [connR, connL],
      ]) {
        const sW = new THREE.Vector3(),
          oW = new THREE.Vector3();
        snap.getWorldPosition(sW);
        other.getWorldPosition(oW);
        const dx = posA.x - sW.x,
          dz = posA.z - sW.z;
        const err = Math.hypot(oW.x + dx - posB.x, oW.z + dz - posB.z);
        let bridgeFrontWorld = new THREE.Vector3();
        if (connectorRoot) {
          const box = new THREE.Box3().setFromObject(connectorRoot),
            center = box.getCenter(new THREE.Vector3());
          const localCenter = connectorRoot.worldToLocal(center.clone());
          const localSocket = new THREE.Vector3();
          snap.getWorldPosition(localSocket);
          connectorRoot.worldToLocal(localSocket);
          let bridgeFrontLocal = new THREE.Vector3().subVectors(
            localCenter,
            localSocket,
          );
          bridgeFrontLocal.y = 0;
          if (bridgeFrontLocal.lengthSq() > 0.0001)
            bridgeFrontLocal.normalize();
          bridgeFrontWorld = bridgeFrontLocal
            .clone()
            .applyEuler(new THREE.Euler(0, yaw, 0));
        }
        const facingScore = bridgeFrontWorld.dot(triFrontWorld);
        if (err < bestError - 0.001) {
          bestError = err;
          bestYaw = yaw;
          bestConnector = snap;
          bestFacingScore = facingScore;
        } else if (
          Math.abs(err - bestError) <= 0.001 &&
          facingScore > bestFacingScore
        ) {
          bestFacingScore = facingScore;
          bestYaw = yaw;
          bestConnector = snap;
        }
      }
    }
    mountGroup.rotation.set(0, bestYaw + manualSteps * (Math.PI / 2), 0);
    mountGroup.updateMatrixWorld(true);
    const cWorld = new THREE.Vector3();
    bestConnector.getWorldPosition(cWorld);
    mountGroup.position.x += posA.x - cWorld.x;
    mountGroup.position.z += posA.z - cWorld.z;
    mountGroup.updateMatrixWorld(true);
    const lW = new THREE.Vector3(),
      rW = new THREE.Vector3();
    connL.getWorldPosition(lW);
    connR.getWorldPosition(rW);
    const connMidY = (lW.y + rW.y) / 2;
    mountGroup.position.y += targetY - connMidY + SUPPORT_SNAP_Y_ADJUST;
    mountGroup.rotation.set(0, mountGroup.rotation.y, 0);
    return;
  }
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
    let hitMesh = null,
      hitMount = null;
    for (const h of hits) {
      if (
        [
          ...frameMarkers,
          ...motorMarkers,
          ...triangleMarkers,
          ...frameOnSupportMarkers,
          ...wheelMarkers,
        ].includes(h.object)
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
    hideTooltip();
    return;
  }

  if (isFinalized || !ghost) return;
  updateMouse(e);
  raycaster.setFromCamera(mouse, camera);

  if (placementMode === "frame") {
    const supportHit = raycaster.intersectObjects(frameOnSupportMarkers)[0];
    if (supportHit) {
      frameHoverType = "support";
      const socket = supportHit.object.userData.socket;
      currentHoveredSupportSocket = socket;
      const snap = computeFrameOnSupportSnap(
        socket,
        frameOnSupportRotationSteps,
      );
      ghost.position.copy(snap.position);
      ghost.rotation.set(0, snap.rotation, 0);
      return;
    }
    if (frameHoverType === "support") frameHoverType = "frame";
    if (frameMarkers.length === 0) {
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
    if (!frameHit) {
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
    frameHoverType = "frame";
    const socket = frameHit.object.userData.socket;
    const { mountPos } = computeFrameSnapPosition(socket);
    ghost.position.copy(mountPos);
    ghost.rotation.set(0, 0, 0);
    return;
  }

  if (placementMode === "wheel") {
    const hit = raycaster.intersectObjects(wheelMarkers)[0];
    if (!hit) {
      const groundPlane = new THREE.Plane(
        new THREE.Vector3(0, 1, 0),
        -baseFrameYLevel,
      );
      const target = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(groundPlane, target)) {
        ghost.position.set(target.x, baseFrameYLevel, target.z);
      }
      return;
    }
    const socket = hit.object.userData.socket;
    socket.updateMatrixWorld(true);
    ghost.matrix.copy(socket.matrixWorld);
    ghost.matrix.decompose(ghost.position, ghost.quaternion, ghost.scale);
    return;
  }

  if (placementMode === "motor") {
    const hit = raycaster.intersectObjects(motorMarkers)[0];
    if (hoveredMotorMarker && hoveredMotorMarker !== hit?.object) {
      hoveredMotorMarker.material = MAT_MOTOR_ACTIVE;
      hoveredMotorMarker.scale.setScalar(1.5);
      hoveredMotorMarker = null;
    }
    if (!hit) {
      const groundPlane = new THREE.Plane(
        new THREE.Vector3(0, 1, 0),
        -baseFrameYLevel,
      );
      const target = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(groundPlane, target)) {
        ghost.position.set(target.x, baseFrameYLevel, target.z);
        ghost.rotation.set(0, motorAutoBaseYaw, 0);
      }
      return;
    }
    const socket = hit.object.userData.socket;
    socket.updateMatrixWorld(true);
    if (hit.object !== hoveredMotorMarker) {
      hoveredMotorMarker = hit.object;
      hoveredMotorMarker.material = MAT_MOTOR_HOVER;
      hoveredMotorMarker.scale.setScalar(2.0);
    }
    const socketWorldPos = new THREE.Vector3();
    socket.getWorldPosition(socketWorldPos);
    motorAutoBaseYaw = computeMotorAutoYaw(socket);
    ghost.position.copy(socketWorldPos);
    ghost.rotation.set(0, motorAutoBaseYaw, 0);
    motorRotationGroup.rotation.set(0, 0, 0);
    applySocketDepth(ghost, socket, 0.05);
    return;
  }

  if (placementMode === "support") {
    const targets = stressConnectorMarkers;
    if (!canPlaceSupportBridge()) {
      if (hoveredTriangleMarker) {
        hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
        hoveredTriangleMarker.scale.setScalar(1.5);
        hoveredTriangleMarker = null;
      }
      const groundPlane = new THREE.Plane(
        new THREE.Vector3(0, 1, 0),
        -baseFrameYLevel,
      );
      const target = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(groundPlane, target)) {
        ghost.position.set(target.x, baseFrameYLevel, target.z);
        ghost.rotation.set(0, 0, 0);
      }
      return;
    }
    const hit = raycaster.intersectObjects(targets)[0];
    if (
      hoveredTriangleMarker &&
      hoveredTriangleMarker !== hit?.object &&
      hoveredTriangleMarker !== supportFirstMarker
    ) {
      hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
      hoveredTriangleMarker.scale.setScalar(1.5);
      hoveredTriangleMarker = null;
    }
    if (!hit) {
      const groundPlane = new THREE.Plane(
        new THREE.Vector3(0, 1, 0),
        -baseFrameYLevel,
      );
      const target = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(groundPlane, target)) {
        ghost.position.set(target.x, baseFrameYLevel, target.z);
        ghost.rotation.set(0, 0, 0);
      }
      return;
    }
    const rawSocket = hit.object.userData.socket;
    rawSocket.updateMatrixWorld(true);
    if (
      hit.object !== hoveredTriangleMarker &&
      hit.object !== supportFirstMarker
    ) {
      hoveredTriangleMarker = hit.object;
      hoveredTriangleMarker.material = MAT_TRI_HOVER;
      hoveredTriangleMarker.scale.setScalar(2.0);
    }
    const previewPair = resolveBestSupportSocketPair(rawSocket);
    if (previewPair) {
      const { posA, posB } = previewPair;
      ghost.position.set(0, 0, 0);
      ghost.rotation.set(0, 0, 0);
      ghost.scale.set(1, 1, 1);
      ghost.updateMatrixWorld(true);
      applyTwoPointSupportSnap(
        ghost,
        ghost,
        posA,
        posB,
        0,
        previewPair.socketA,
      );
    } else {
      const pos = new THREE.Vector3();
      rawSocket.getWorldPosition(pos);
      ghost.position.copy(pos);
      ghost.rotation.set(0, 0, 0);
    }
    return;
  }

  const targets = triangleSocketMarkers;
  const hit = raycaster.intersectObjects(targets)[0];
  if (hoveredTriangleMarker && hoveredTriangleMarker !== hit?.object) {
    hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
    hoveredTriangleMarker.scale.setScalar(1.5);
    hoveredTriangleMarker = null;
    updateShortcutBar();
  }
  if (!hit) {
    const groundPlane = new THREE.Plane(
      new THREE.Vector3(0, 1, 0),
      -baseFrameYLevel,
    );
    const target = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(groundPlane, target)) {
      ghost.position.set(target.x, baseFrameYLevel, target.z);
      ghost.rotation.set(
        0,
        triangleAutoBaseYaw + triangleManualRotSteps * Math.PI,
        0,
      );
    }
    return;
  }
  const socket = hit.object.userData.socket;
  socket.updateMatrixWorld(true);
  if (hit.object !== hoveredTriangleMarker) {
    const incomingUUID = socket.uuid,
      isNewSocket = incomingUUID !== lastHoveredTriangleSocketUUID;
    hoveredTriangleMarker = hit.object;
    hoveredTriangleMarker.material = MAT_TRI_HOVER;
    hoveredTriangleMarker.scale.setScalar(2.0);
    lastHoveredTriangleSocketUUID = incomingUUID;
    if (isNewSocket) triangleAutoBaseYaw = computeTriangleAutoYaw(socket);
    updateShortcutBar();
  }
  const socketWorldPos = new THREE.Vector3();
  socket.getWorldPosition(socketWorldPos);
  const finalYaw = triangleAutoBaseYaw + triangleManualRotSteps * Math.PI;
  ghost.rotation.set(0, finalYaw, 0);
  ghost.position.set(0, 0, 0);
  ghost.scale.set(1, 1, 1);
  ghost.updateMatrixWorld(true);
  let _triConn = null;
  ghost.traverse((o) => {
    if (o.name === "SOCKET_FRAME_CONNECTOR") _triConn = o;
  });
  if (_triConn) {
    const _cWP = new THREE.Vector3();
    _triConn.getWorldPosition(_cWP);
    ghost.position.x += socketWorldPos.x - _cWP.x;
    ghost.position.y = socketWorldPos.y + TRIANGLE_FRAME_Y_OFFSET;
    ghost.position.z += socketWorldPos.z - _cWP.z;
  } else {
    ghost.position.copy(socketWorldPos);
    ghost.position.y = socketWorldPos.y + TRIANGLE_FRAME_Y_OFFSET;
  }
}

/* =========================================================
   CLICK HANDLER
   ========================================================= */

function onClick(e) {
  if (isFinalized) return;
  updateMouse(e);
  raycaster.setFromCamera(mouse, camera);

  if (!placementMode) {
    const hits = raycaster.intersectObjects(scene.children, true);
    for (const h of hits) {
      if (
        [
          ...frameMarkers,
          ...motorMarkers,
          ...triangleMarkers,
          ...frameOnSupportMarkers,
          ...wheelMarkers,
        ].includes(h.object)
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
    const nearestSupport = findNearestMarkerOnScreen(frameOnSupportMarkers);
    if (nearestSupport) {
      const socket = nearestSupport.userData.socket;
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
    let frameHitObj = raycaster.intersectObjects(frameMarkers)[0];
    if (!frameHitObj) {
      const nearest = findNearestMarkerOnScreen(frameMarkers);
      if (nearest) frameHitObj = { object: nearest };
    }
    if (!frameHitObj) {
      clearGhost();
      return;
    }
    const socket = frameHitObj.object.userData.socket;
    if (usedSockets.has(socket.uuid)) return;
    placeFrame(socket);
    restartPlacementMode("frame");
    checkQueuedIntent();
    return;
  }

  if (placementMode === "support") {
    if (!canPlaceSupportBridge()) {
      showHudMessage(
        "⚠ Need 2 Triangular Frames on separate mounts to place a bridge",
      );
      return;
    }
    let hit = raycaster.intersectObjects(stressConnectorMarkers)[0];
    if (!hit) {
      const nearest = findNearestMarkerOnScreen(stressConnectorMarkers);
      if (nearest) hit = { object: nearest };
    }
    if (!hit) {
      clearGhost();
      return;
    }
    const rawSocket = hit.object.userData.socket;
    if (usedSockets.has(rawSocket.uuid)) return;
    const pair = resolveBestSupportSocketPair(rawSocket);
    if (!pair) {
      showHudMessage(
        "⚠ Could not find a matching socket on a second Triangle Frame",
      );
      return;
    }
    const { socketA, posA, socketB, posB } = pair;
    const dx = Math.abs(posB.x - posA.x),
      dz = Math.abs(posB.z - posA.z);
    const major = Math.max(dx, dz),
      minor = Math.min(dx, dz);
    if (major > 0.1 && minor > 0.3 && minor / major > 0.3) {
      showPopup(
        "Support Bridges must run along a straight axis (X or Z).\n\nThe two Triangle Frame connectors are diagonal to each other. Only triangle frames facing each other directly can be bridged.",
      );
      return;
    }
    if (usedSockets.has(socketA.uuid) || usedSockets.has(socketB.uuid)) {
      showHudMessage("⚠ One of those sockets is already used");
      return;
    }
    let mountA = socketA.parent;
    while (mountA && !mountA.userData?.isMount) mountA = mountA.parent;
    let mountB = socketB.parent;
    while (mountB && !mountB.userData?.isMount) mountB = mountB.parent;
    const existingBridge = getAllMounts().some((m) => {
      if (m.userData.type !== "support_frame") return false;
      const sA = m.userData.socket,
        sB = m.userData.socketB;
      if (!sA) return false;
      let mA = sA.parent;
      while (mA && !mA.userData?.isMount) mA = mA.parent;
      let mB = sB?.parent;
      while (mB && !mB.userData?.isMount) mB = mB.parent;
      return (
        (mA === mountA && mB === mountB) || (mA === mountB && mB === mountA)
      );
    });
    if (existingBridge) {
      showPopup(
        "A Support Bridge already connects these two Triangle Frames.\n\nOnly one bridge is allowed per triangle pair.",
      );
      return;
    }
    if (hoveredTriangleMarker) {
      hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
      hoveredTriangleMarker.scale.setScalar(1.5);
      hoveredTriangleMarker = null;
    }
    placeSupportBridgeFromPair(socketA, posA, socketB, posB, 0, socketA);
    restartPlacementMode("support");
    checkQueuedIntent();
    return;
  }

  if (placementMode === "wheel") {
    let hit = raycaster.intersectObjects(wheelMarkers)[0];
    if (!hit) {
      const nearest = findNearestMarkerOnScreen(wheelMarkers);
      if (nearest) hit = { object: nearest };
    }
    if (!hit) {
      clearGhost();
      return;
    }
    const socket = hit.object.userData.socket;
    if (usedSockets.has(socket.uuid)) return;
    placeWheel(socket);
    rebuildSocketMarkers();
    updateWheelButtonState();
    updateSupportButtonState();
    applySocketHighlights();
    if (wheelMarkers.length === 0) {
      showHudMessage("All wheel sockets occupied — exiting placement");
      clearGhost();
    } else restartPlacementMode("wheel");
    checkQueuedIntent();
    return;
  }

  if (placementMode === "motor") {
    let hit = raycaster.intersectObjects(motorMarkers)[0];
    if (!hit) {
      const nearest = findNearestMarkerOnScreen(motorMarkers);
      if (nearest) hit = { object: nearest };
    }
    if (!hit) {
      clearGhost();
      return;
    }
    const socket = hit.object.userData.socket;
    if (usedSockets.has(socket.uuid)) return;
    placeMotor(socket, computeMotorAutoYaw(socket), 0);
    rebuildSocketMarkers();
    updateWheelButtonState();
    updateSupportButtonState();
    applySocketHighlights();
    if (motorMarkers.length === 0) {
      showHudMessage("All motor sockets occupied — exiting placement");
      clearGhost();
    } else restartPlacementMode("motor");
    checkQueuedIntent();
    return;
  }

  if (placementMode === "triangle") {
    let hit = raycaster.intersectObjects(triangleSocketMarkers)[0];
    if (!hit) {
      const nearest = findNearestMarkerOnScreen(triangleSocketMarkers);
      if (nearest) hit = { object: nearest };
    }
    if (!hit) {
      clearGhost();
      return;
    }
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
  updateWeightDisplay();
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
    if (snapFound || !o.name) return;
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
    let closestUuid = null,
      closestDist = Infinity;
    mount.traverse((o) => {
      if (
        !o.name ||
        !o.name.toUpperCase().startsWith("SOCKET_FRAME") ||
        o.name.toUpperCase().startsWith("SOCKET_FRAME_SUPPORT")
      )
        return;
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
  updateWeightDisplay();
}

function placeMotor(socket, autoBaseYaw = 0, manualSteps = 0) {
  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "motor" };
  socket.updateMatrixWorld(true);
  const socketPos = new THREE.Vector3();
  socket.getWorldPosition(socketPos);
  mount.position.copy(socketPos);
  mount.rotation.set(0, autoBaseYaw + manualSteps * (Math.PI / 2), 0);
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
  updateWeightDisplay();
}

function placeWheel(socket) {
  if (!wheelTemplate) return;
  const wheel = wheelTemplate.clone(true);
  makeSolid(wheel);
  socket.updateMatrixWorld(true);
  const socketPos = new THREE.Vector3(),
    socketQuat = new THREE.Quaternion();
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
    mount.position.copy(socketPos);
    mount.add(wheel);
    scene.add(mount);
  }
  usedSockets.add(socket.uuid);
  addToInventory("wheel");
  pushUndo(mount, [socket.uuid], "wheel");
  updateWeightDisplay();
  rebuildSocketMarkers();
  updateWheelButtonState();
  updateSupportButtonState();
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
  updateWeightDisplay();
}

function placeFrameOnSupport(socket, rotationSteps) {
  socket.updateMatrixWorld(true);
  const posSupA = new THREE.Vector3();
  socket.getWorldPosition(posSupA);
  let parentMount = socket.parent;
  while (parentMount && !parentMount.userData?.isMount)
    parentMount = parentMount.parent;
  let siblingSocket = null,
    posSupB = null;
  if (parentMount) {
    parentMount.updateMatrixWorld(true);
    let bestDist = -1;
    parentMount.traverse((o) => {
      if (!o.name?.startsWith("SOCKET_FRAME_SUPPORT") || o.uuid === socket.uuid)
        return;
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
    if (o.name.toUpperCase().startsWith("SOCKET_FRAME_SUPPORT")) {
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
  let bestError = Infinity,
    bestAngle = 0,
    bestSnapConn = rectConnectors[0];
  for (const snapConn of rectConnectors) {
    for (const angle of candidateAngles) {
      const cos = Math.cos(angle),
        sin = Math.sin(angle);
      const rsX = cos * snapConn.x + sin * snapConn.z,
        rsZ = -sin * snapConn.x + cos * snapConn.z;
      const mX = posSupA.x - rsX,
        mZ = posSupA.z - rsZ;
      let error = 0;
      if (posSupB) {
        let minDist = Infinity;
        for (const c2 of rectConnectors) {
          if (c2 === snapConn) continue;
          const c2wX = mX + cos * c2.x + sin * c2.z,
            c2wZ = mZ + (-sin * c2.x + cos * c2.z);
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
  const rsX = cos * bestSnapConn.x + sin * bestSnapConn.z,
    rsZ = -sin * bestSnapConn.x + cos * bestSnapConn.z;
  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "frame" };
  mount.rotation.set(0, finalAngle, 0);
  mount.position.set(
    posSupA.x - rsX,
    posSupA.y - bestSnapConn.y + FRAME_ON_SUPPORT_Y_OFFSET,
    posSupA.z - rsZ,
  );
  mount.add(frame);
  scene.add(mount);
  mount.updateMatrixWorld(true);
  usedSockets.add(socket.uuid);
  if (siblingSocket) usedSockets.add(siblingSocket.uuid);
  addToInventory("frame");
  const fosUuids = [socket.uuid];
  if (siblingSocket) fosUuids.push(siblingSocket.uuid);
  pushUndo(mount, fosUuids, "frame");
  updateWeightDisplay();
}

function placeSupportBridgeFromPair(
  socketA,
  posA,
  socketB,
  posB,
  manualSteps = 0,
  sourceSocket,
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
  applyTwoPointSupportSnap(mount, support, posA, posB, manualSteps, socketA);
  usedSockets.add(socketA.uuid);
  if (socketB) usedSockets.add(socketB.uuid);
  addToInventory("support_frame");
  pushUndo(
    mount,
    socketB ? [socketA.uuid, socketB.uuid] : [socketA.uuid],
    "support_frame",
  );
  updateWeightDisplay();
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
  if (hoveredMesh && hoveredMesh !== selectedMesh)
    restoreMeshEmissive(hoveredMesh, hoveredOrigEm);
  hoveredMesh = mesh;
  hoveredMount = mount;
  if (hoveredMesh) {
    if (hoveredMesh === selectedMesh) hoveredOrigEm.copy(selectedOrigEm);
    else hoveredOrigEm = setMeshEmissive(hoveredMesh, 0x001a2e);
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
      setMeshEmissive(selectedMesh, 0x001a2e);
    } else restoreMeshEmissive(selectedMesh, selectedOrigEm);
    selectedMesh = null;
  }
  selectedMount = mount;
  selectedMesh = mesh;
  if (selectedMesh) {
    if (selectedMesh === hoveredMesh) selectedOrigEm = hoveredOrigEm.clone();
    else selectedOrigEm = setMeshEmissive(selectedMesh, 0x3d0020);
    if (selectedMesh?.material?.emissive)
      selectedMesh.material.emissive.set(0x3d0020);
  }
}

/* =========================================================
   UNDO / REDO
   ========================================================= */

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  if (undoBtn) {
    const canUndo = undoStack.length > 0 && !isFinalized;
    undoBtn.disabled = !canUndo;
    undoBtn.style.opacity = canUndo ? "1" : "0.35";
    undoBtn.style.pointerEvents = canUndo ? "auto" : "none";
  }
  if (redoBtn) {
    const canRedo = redoStack.length > 0 && !isFinalized;
    redoBtn.disabled = !canRedo;
    redoBtn.style.opacity = canRedo ? "1" : "0.35";
    redoBtn.style.pointerEvents = canRedo ? "auto" : "none";
  }
}

function performUndo() {
  if (undoStack.length === 0) {
    showHudMessage("NOTHING TO UNDO");
    return;
  }
  const entry = undoStack.pop();
  const { mount, socketUuids, type, action } = entry;

  if (action === "delete") {
    // Undo a delete → re-add the mount
    scene.add(mount);
    socketUuids.forEach((uuid) => usedSockets.add(uuid));
    addToInventory(type);
  } else {
    // Undo a place → remove the mount
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
    hoveredMotorMarker = null;
    hoveredTriangleMarker = null;
    scene.remove(mount);
    removeFromInventory(type);
  }

  redoStack.push(entry);
  rebuildSocketMarkers();
  updateWheelButtonState();
  updateSupportButtonState();
  applySocketHighlights();
  updateWeightDisplay();
  updateUndoRedoButtons();
  showHudMessage("UNDO ✓");
}

function performRedo() {
  if (redoStack.length === 0) {
    showHudMessage("NOTHING TO REDO");
    return;
  }
  const entry = redoStack.pop();
  const { mount, socketUuids, type, action } = entry;

  if (action === "delete") {
    // Redo a delete → remove the mount again
    if (selectedMount === mount) {
      restoreMeshEmissive(selectedMesh, selectedOrigEm);
      selectedMesh = null;
      selectedMount = null;
    }
    socketUuids.forEach((uuid) => usedSockets.delete(uuid));
    scene.remove(mount);
    removeFromInventory(type);
  } else {
    // Redo a place → add the mount back
    scene.add(mount);
    socketUuids.forEach((uuid) => usedSockets.add(uuid));
    addToInventory(type);
  }

  undoStack.push(entry);
  rebuildSocketMarkers();
  updateWheelButtonState();
  updateSupportButtonState();
  applySocketHighlights();
  updateWeightDisplay();
  updateUndoRedoButtons();
  showHudMessage("REDO ✓");
}

/* =========================================================
   KEYBOARD HANDLER
   ========================================================= */

function onKeyDown(e) {
  if (e.key === "F5") {
    e.preventDefault();
    e.stopPropagation();
    showHudMessage("USE CTRL+R OR BROWSER REFRESH TO RELOAD");
    return;
  }
  if (isFinalized) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    performUndo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    performRedo();
    return;
  }
  if (e.key === "Escape") {
    if (placementMode === "support" && supportFirstSocket) {
      supportFirstSocket = null;
      if (supportFirstMarker) {
        supportFirstMarker.material = MAT_TRI_ACTIVE;
        supportFirstMarker.scale.setScalar(1.5);
        supportFirstMarker = null;
      }
      showHudMessage("SELECTION CLEARED — click a connector to start again");
      return;
    }
    if (placementMode) clearGhost();
    else if (selectedMount) {
      restoreMeshEmissive(selectedMesh, selectedOrigEm);
      selectedMesh = null;
      selectedMount = null;
    }
    return;
  }
  if (
    (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
    placementMode &&
    placementMode !== "motor"
  ) {
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    flashArrowKey(e.key === "ArrowRight" ? "right" : "left");
    if (placementMode === "triangle" && ghost) {
      triangleManualRotSteps = (triangleManualRotSteps + 1) % 2;
      showHudMessage(
        `Triangle manual offset: +${triangleManualRotSteps * 180}°`,
      );
      updateShortcutBar();
      updateRotationDisplay();
      ghost.rotation.set(
        0,
        triangleAutoBaseYaw + triangleManualRotSteps * Math.PI,
        0,
      );
    }
    if (placementMode === "frame") {
      frameOnSupportRotationSteps += dir;
      const deg = (((frameOnSupportRotationSteps % 4) + 4) % 4) * 90;
      showHudMessage(`Frame rotation on support: ${deg}°`);
      updateShortcutBar();
      if (
        ghost &&
        frameHoverType === "support" &&
        currentHoveredSupportSocket
      ) {
        const snap = computeFrameOnSupportSnap(
          currentHoveredSupportSocket,
          frameOnSupportRotationSteps,
        );
        ghost.position.copy(snap.position);
        ghost.rotation.set(0, snap.rotation, 0);
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
  if ((e.key === "Delete" || e.key === "Backspace") && selectedMount) {
    if (selectedMount.userData?.isBase) {
      showHudMessage("⚠ BASE FRAME CANNOT BE DELETED");
      return;
    }
    const result = checkDeletionAllowed(selectedMount);
    if (!result.ok) showDependencyBlockedPopup(selectedMount, result);
    else executeDelete(selectedMount);
  }
}

/* =========================================================
   COLOR LEGEND
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
  toggleBtn?.addEventListener("click", () =>
    legend.classList.toggle("collapsed"),
  );
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

let idleTimer = null,
  idleArrowsShown = false;
const IDLE_DELAY_MS = 3000;
function initIdleArrows() {}
function hideIdleArrows() {
  if (!idleArrowsShown) return;
  const container = document.getElementById("idle-arrows");
  if (container) {
    container.querySelectorAll(".idle-arrow").forEach((a) => {
      const btn = document.getElementById(a.dataset.btnId);
      if (btn) btn.style.boxShadow = "";
    });
    container.innerHTML = "";
  }
  idleArrowsShown = false;
}

/* =========================================================
   CONTEXT MENU
   ========================================================= */

const PART_GLYPHS = {
  frame: "▬",
  motor: "⬡",
  triangle_frame: "▲",
  support_frame: "╬",
  wheel: "◉",
};
let ctxMenuEl = null,
  ctxTargetMount = null;

function buildContextMenu(mount, screenX, screenY) {
  destroyContextMenu();
  ctxTargetMount = mount;
  const type = mount.userData.type ?? "frame";
  const label = PART_LABELS()[type] ?? type.replace(/_/g, " ");
  const glyph = PART_GLYPHS[type] ?? "◈";
  const cost = getPrice(type);
  const delResult = checkDeletionAllowed(mount);
  const depCount = delResult.ok ? 0 : delResult.dependents.length;

  const menu = document.createElement("div");
  menu.id = "ctx-menu";
  const header = document.createElement("div");
  header.className = "ctx-header";
  header.innerHTML = `<span class="ctx-header-glyph">${glyph}</span><div><div class="ctx-header-name">${label}</div><div class="ctx-header-type">₹${cost.toLocaleString()} · ${type.replace(/_/g, " ")}</div></div>`;
  menu.appendChild(header);
  const items = document.createElement("div");
  items.className = "ctx-items";
  items.appendChild(
    makeCtxItem({
      icon: "◎",
      label: "Focus Camera",
      hint: "Frame this part in view",
      onClick: () => {
        destroyContextMenu();
        frameObject(mount);
        showHudMessage(`FOCUSED: ${label.toUpperCase()}`);
      },
    }),
  );
  const isSelected = selectedMount === mount;
  items.appendChild(
    makeCtxItem({
      icon: isSelected ? "◈" : "◇",
      label: isSelected ? "Deselect Part" : "Select Part",
      hint: isSelected ? "Clear current selection" : "Highlight this part",
      kbd: "Click",
      onClick: () => {
        destroyContextMenu();
        let mesh = null;
        mount.traverse((o) => {
          if (!mesh && o.isMesh) mesh = o;
        });
        selectMesh(mesh, mount);
      },
    }),
  );
  items.appendChild(makeSep());
  const isBase = mount.userData?.isBase ?? false;
  const deleteItem = makeCtxItem({
    icon: "✕",
    label: isBase
      ? "Base Frame (Permanent)"
      : depCount > 0
        ? `Delete All (${depCount + 1} parts)`
        : "Delete Part",
    hint: isBase
      ? "The base frame cannot be removed"
      : depCount > 0
        ? `Will also remove ${depCount} dependent part${depCount !== 1 ? "s" : ""}`
        : undefined,
    kbd: isBase ? undefined : "Del",
    danger: !isBase,
    disabled: isBase,
    onClick: () => {
      destroyContextMenu();
      if (isBase) {
        showHudMessage("⚠ BASE FRAME CANNOT BE DELETED");
        return;
      }
      if (depCount > 0) showDependencyBlockedPopup(mount, delResult);
      else executeDelete(mount);
    },
  });
  if (depCount > 0) {
    const badge = document.createElement("div");
    badge.className = "ctx-cascade-badge";
    badge.innerHTML = `⚠ ${depCount} dependent part${depCount !== 1 ? "s" : ""} will also be removed`;
    deleteItem.querySelector(".ctx-item-body").appendChild(badge);
  }
  items.appendChild(deleteItem);
  menu.appendChild(items);
  document.body.appendChild(menu);
  ctxMenuEl = menu;

  const mw = menu.offsetWidth || 220,
    mh = menu.offsetHeight || 180,
    vw = window.innerWidth,
    vh = window.innerHeight;
  let x = screenX + 4,
    y = screenY + 4;
  if (x + mw > vw - 8) x = screenX - mw - 4;
  if (y + mh > vh - 8) y = screenY - mh - 4;
  x = Math.max(8, x);
  y = Math.max(8, y);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  setTimeout(() => {
    document.addEventListener("mousedown", onCtxOutsideClick, { once: true });
    document.addEventListener("keydown", onCtxKeyDown, { capture: true });
  }, 0);
}

function makeCtxItem({ icon, label, hint, kbd, danger, disabled, onClick }) {
  const item = document.createElement("div");
  item.className =
    "ctx-item" +
    (danger ? " ctx-danger" : "") +
    (disabled ? " ctx-disabled" : "");
  item.innerHTML = `<span class="ctx-item-icon">${icon}</span><span class="ctx-item-body"><span class="ctx-item-label">${label}</span>${hint ? `<span class="ctx-item-hint">${hint}</span>` : ""}</span>${kbd ? `<span class="ctx-item-kbd">${kbd}</span>` : ""}`;
  if (!disabled) item.addEventListener("click", onClick);
  return item;
}

function makeSep() {
  const sep = document.createElement("div");
  sep.className = "ctx-sep";
  return sep;
}
function destroyContextMenu() {
  if (ctxMenuEl) {
    ctxMenuEl.remove();
    ctxMenuEl = null;
  }
  ctxTargetMount = null;
  document.removeEventListener("mousedown", onCtxOutsideClick);
  document.removeEventListener("keydown", onCtxKeyDown, { capture: true });
}
function onCtxOutsideClick(e) {
  if (ctxMenuEl && !ctxMenuEl.contains(e.target)) destroyContextMenu();
}
function onCtxKeyDown(e) {
  if (e.key === "Escape") destroyContextMenu();
}

function onContextMenu(e) {
  e.preventDefault();
  if (placementMode || isFinalized) return;
  updateMouse(e);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  for (const h of hits) {
    if (
      [
        ...frameMarkers,
        ...motorMarkers,
        ...triangleMarkers,
        ...frameOnSupportMarkers,
        ...wheelMarkers,
      ].includes(h.object)
    )
      continue;
    const { mount } = resolveMeshAndMount(h.object);
    if (mount) {
      let mesh = null;
      mount.traverse((o) => {
        if (!mesh && o.isMesh) mesh = o;
      });
      selectMesh(mesh, mount);
      buildContextMenu(mount, e.clientX, e.clientY);
      return;
    }
  }
  destroyContextMenu();
}

function executeDelete(mount) {
  if (mount.userData?.isBase) {
    showHudMessage("⚠ BASE FRAME CANNOT BE DELETED");
    return;
  }
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

  // Collect ALL socket UUIDs for this mount
  const allSocketUuids = new Set();
  if (socket?.uuid) allSocketUuids.add(socket.uuid);
  if (socketB?.uuid) allSocketUuids.add(socketB.uuid);
  for (const entry of undoStack) {
    if (entry.mount === mount)
      entry.socketUuids.forEach((uuid) => allSocketUuids.add(uuid));
  }

  // Release sockets
  allSocketUuids.forEach((uuid) => usedSockets.delete(uuid));

  // Remove this mount's existing place entries from undoStack
  const kept = undoStack.filter((e) => e.mount !== mount);
  undoStack.length = 0;
  kept.forEach((e) => undoStack.push(e));

  // Push DELETE action so it can be undone
  undoStack.push({
    mount,
    socketUuids: [...allSocketUuids],
    type,
    action: "delete",
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;

  scene.remove(mount);
  removeFromInventory(type);
  rebuildSocketMarkers();
  updateWheelButtonState();
  updateSupportButtonState();
  applySocketHighlights();
  updateWeightDisplay();
  updateUndoRedoButtons();
  showHudMessage(`DELETED: ${(PART_LABELS()[type] ?? type).toUpperCase()}`);
}
/* =========================================================
   RENDER LOOP
   ========================================================= */

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  if (placementMode) {
    const t = Date.now() * 0.003,
      pulse = 1.3 + Math.sin(t) * 0.3;
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
  renderMinimap();
  renderComponentPreview();
}

/* =========================================================
   WEIGHT SECTION
   ========================================================= */

function initWeightSection() {
  if (!document.getElementById("weight-section-styles")) {
    const s = document.createElement("style");
    s.id = "weight-section-styles";
    s.textContent = `
      #weight-section{border-top:1px solid rgba(208,88,24,0.18);flex-shrink:0}
      #weight-section-header{display:flex;align-items:center;justify-content:space-between;padding:9px 14px 8px 16px;cursor:pointer;user-select:none;transition:background 0.12s}
      #weight-section-header:hover{background:rgba(208,88,24,0.05)}
      #weight-section-title{font-family:'Orbitron',sans-serif;font-size:8px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#d05818;display:flex;align-items:center;gap:7px}
      #weight-total-badge{font-family:'Orbitron',sans-serif;font-size:11px;font-weight:700;color:#d8e8f4;letter-spacing:0.06em}
    #weight-chevron{font-size:20px;color:#d05818;transition:transform 0.2s ease,color 0.12s;font-family:'Share Tech Mono',monospace;margin-left:8px}
      #weight-section-header:hover #weight-chevron{color:#d05818}
      #weight-body{overflow:hidden;transition:max-height 0.25s ease,opacity 0.2s ease;max-height:300px;opacity:1}
      #weight-body.collapsed{max-height:0;opacity:0}
      #weight-rows{padding:4px 12px 10px;display:flex;flex-direction:column;gap:3px}
      .weight-row{display:flex;align-items:center;justify-content:space-between;padding:5px 10px;background:#1a2636;border:1px solid #263848;border-left:2px solid rgba(208,88,24,0.5);clip-path:polygon(0 0,calc(100% - 5px) 0,100% 5px,100% 100%,0 100%);font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:0.04em}
      .weight-row-label{color:#6a8098;text-transform:uppercase;font-size:9px;letter-spacing:0.08em;display:flex;align-items:center;gap:6px}
      .weight-row-qty{font-size:8px;color:#384858;background:#111820;border:1px solid #2a3848;padding:1px 5px;letter-spacing:0.06em}
      .weight-row-val{color:#8aacbf;font-size:10px;letter-spacing:0.06em}
      .weight-row-unit{color:#384858;font-size:8px;margin-left:2px}
      #weight-total-row{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;margin:0 12px 10px;background:rgba(208,88,24,0.06);border:1px solid rgba(208,88,24,0.25);border-left:3px solid #d05818}
      #weight-total-label{font-family:'Orbitron',sans-serif;font-size:8px;font-weight:700;letter-spacing:0.18em;color:#6a8098;text-transform:uppercase}
      #weight-total-value{font-family:'Orbitron',sans-serif;font-size:14px;font-weight:700;color:#d8e8f4;letter-spacing:0.06em}
      #weight-total-value span{font-size:9px;color:#384858;margin-left:3px}
      @keyframes weightIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
      #weight-section{animation:weightIn 0.35s ease 0.3s both}
    `;
    document.head.appendChild(s);
  }

  const section = document.createElement("div");
  section.id = "weight-section";
  const header = document.createElement("div");
  header.id = "weight-section-header";
  header.innerHTML = `<div id="weight-section-title"><span style="color:#384858;font-size:11px">⊕</span>WEIGHT</div><div style="display:flex;align-items:center;gap:0"><div id="weight-total-badge">0 g</div><div id="weight-chevron">▾</div></div>`;
  header.addEventListener("click", () => {
    const body = document.getElementById("weight-body"),
      chev = document.getElementById("weight-chevron");
    const collapsed = body.classList.toggle("collapsed");
    chev.style.transform = collapsed ? "rotate(-90deg)" : "rotate(0deg)";
    chev.style.color = "#d05818";
  });
  section.appendChild(header);
  const body = document.createElement("div");
  body.id = "weight-body";
  const rows = document.createElement("div");
  rows.id = "weight-rows";
  body.appendChild(rows);
  const totalRow = document.createElement("div");
  totalRow.id = "weight-total-row";
  totalRow.innerHTML = `<div id="weight-total-label">TOTAL WEIGHT</div><div id="weight-total-value">0 <span>g</span></div>`;
  body.appendChild(totalRow);
  section.appendChild(body);
  const placeholder = document.getElementById("weight-section-placeholder");
  if (placeholder) {
    placeholder.replaceWith(section);
  } else {
    const basketFooter = document.querySelector(".basket-footer");
    if (basketFooter?.parentElement)
      basketFooter.parentElement.insertBefore(section, basketFooter);
    else {
      const rp = document.querySelector(".panel-right");
      if (rp) rp.appendChild(section);
    }
  }
  updateWeightDisplay();
}

const PART_GLYPHS_W = {
  frame: "▬",
  motor: "⬡",
  triangle_frame: "▲",
  support_frame: "╬",
  wheel: "◉",
};

function updateWeightDisplay() {
  const rowsEl = document.getElementById("weight-rows");
  const totalVal = document.getElementById("weight-total-value");
  const badge = document.getElementById("weight-total-badge");
  if (!rowsEl) return;

  const counts = {};
  scene.traverse((o) => {
    if (!o.userData?.isMount) return;
    const t = o.userData.type ?? "unknown";
    counts[t] = (counts[t] ?? 0) + 1;
  });

  rowsEl.innerHTML = "";
  let totalGrams = 0;

  for (const type of [
    "frame",
    "motor",
    "triangle_frame",
    "support_frame",
    "wheel",
  ]) {
    const qty = counts[type] ?? 0;
    if (qty === 0) continue;
    const unitG = PART_WEIGHTS[type] ?? 0;
    const totalG = unitG * qty;
    totalGrams += totalG;
    const label = PART_LABELS()[type] ?? type.replace(/_/g, " ");
    const color = BASKET_BTN_COLORS[type] ?? "rgba(208,88,24,0.65)";

    const totalDisp =
      totalG >= 1000 ? `${(totalG / 1000).toFixed(2)} kg` : `${totalG} g`;
    const unitDisp =
      unitG >= 1000 ? `${(unitG / 1000).toFixed(2)}kg ea` : `${unitG}g ea`;

    const row = document.createElement("div");
    row.dataset.partType = type;
    Object.assign(row.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "7px 10px",
      background: "#1e2836",
      border: "1px solid #2e4058",
      borderLeft: `3px solid ${color}`,
      marginBottom: "3px",
    });

    row.innerHTML = `
      <span style="font-family:'Oswald',sans-serif;font-size:13px;font-weight:400;letter-spacing:0.06em;color:#e8f4ff;display:flex;align-items:center;gap:6px;">
        <span style="font-size:11px;color:#8aacbf;background:#111820;border:1px solid #2a3848;padding:1px 5px;letter-spacing:0.06em;font-family:'Oswald',sans-serif;">${qty}×</span>
        ${label}
      </span>
      <span style="text-align:right;flex-shrink:0;margin-left:8px;">
        <span style="font-family:'Oswald',sans-serif;font-size:14px;font-weight:700;letter-spacing:0.06em;color:#d8eef8;display:block;">${totalDisp}</span>
        <span style="font-family:'Oswald',sans-serif;font-size:10px;font-weight:300;letter-spacing:0.08em;color:#6a8098;display:block;">${unitDisp}</span>
      </span>
    `;
    rowsEl.appendChild(row);
  }

  if (Object.keys(counts).length === 0) {
    rowsEl.innerHTML = `<div style="font-family:'Oswald',sans-serif;font-size:11px;font-weight:300;color:#2a3848;text-align:center;padding:8px 0;letter-spacing:0.1em;text-transform:uppercase;">No parts placed</div>`;
  }

  const displayG =
    totalGrams >= 1000
      ? `${(totalGrams / 1000).toFixed(2)} kg`
      : `${totalGrams} g`;

  if (totalVal)
    totalVal.innerHTML =
      totalGrams >= 1000
        ? `${(totalGrams / 1000).toFixed(2)} <span>kg</span>`
        : `${totalGrams} <span>g</span>`;
  if (badge) badge.textContent = displayG;
}

/* =========================================================
   TOOLTIP
   ========================================================= */

function showTooltip(mount, x, y) {
  if (!tooltipEl || !mount) return;
  const type = mount.userData?.type ?? "frame";
  const REQUIRES = {
    motor: "Requires: Rectangular Frame socket",
    wheel: "Requires: Motor Housing socket",
    triangle_frame: "Requires: Frame triangle socket",
    support_frame: "Requires: 2× Triangle Frames",
  };
  tooltipEl.innerHTML = buildTooltipHTML(type, REQUIRES[type] ?? null);
  tooltipEl.style.display = "block";
  const TW = tooltipEl.offsetWidth || 200;
  const TH = tooltipEl.offsetHeight || 80;
  const px = x + 16 + TW > window.innerWidth ? x - TW - 10 : x + 16;
  const py = y + 16 + TH > window.innerHeight ? y - TH - 10 : y + 16;
  tooltipEl.style.left = `${px}px`;
  tooltipEl.style.top = `${py}px`;
}
function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = "none";
}

/* =========================================================
   MINIMAP
   ========================================================= */

let minimapEl = null,
  minimapCanvas = null,
  minimapCtx = null;
const MINIMAP_SIZE = 240;
let minimapOrthoCamera = null,
  minimapRenderer = null,
  minimapCollapsed = false;

function initMinimap() {
  if (!document.getElementById("minimap-styles")) {
    const s = document.createElement("style");
    s.id = "minimap-styles";
    s.textContent = `
      #minimap-section{margin:0;border-top:1px solid rgba(208,88,24,0.25);background:transparent;flex-shrink:0}
      #minimap-section-header{display:flex;align-items:center;justify-content:space-between;padding:8px 14px 7px;cursor:pointer;user-select:none;transition:background 0.12s}
      #minimap-section-header:hover{background:rgba(208,88,24,0.06)}
      #minimap-section-title{font-family:'Orbitron',sans-serif;font-size:8px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#d05818;display:flex;align-items:center;gap:7px}
      #minimap-section-title span{color:#384858;font-size:11px}
      #minimap-chevron{font-size:9px;color:#384858;transition:transform 0.2s ease,color 0.12s;font-family:'Share Tech Mono',monospace}
      #minimap-section-header:hover #minimap-chevron{color:#d05818}
      #minimap-body{overflow:hidden;transition:max-height 0.3s ease,opacity 0.25s ease;max-height:320px;opacity:1}
      #minimap-body.collapsed{max-height:0;opacity:0}
      #minimap-canvas-wrap{position:relative;width:${MINIMAP_SIZE}px;height:${MINIMAP_SIZE}px;margin:0 auto 0;cursor:crosshair;border:1px solid rgba(208,88,24,0.5);border-top:none;overflow:hidden;background:#0a1420;display:block;box-shadow:inset 0 0 20px rgba(0,0,0,0.5)}
      #minimap-canvas-wrap canvas{display:block;position:absolute;top:0;left:0}
      #minimap-dims-bar{width:${MINIMAP_SIZE}px;margin:0 auto;padding:5px 10px;background:#0a1420;border:1px solid rgba(208,88,24,0.3);border-top:1px solid rgba(208,88,24,0.15);display:flex;justify-content:space-between;align-items:center;gap:6px}
      #minimap-dims-bar span{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.1em;color:#8aacbf;text-transform:uppercase}
    #minimap-dims-bar .dim-val{color:#ffffff;font-weight:700;font-family:'Orbitron',sans-serif;font-size:11px}
      #minimap-hint{text-align:center;font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:0.12em;color:#4a6878;padding:5px 14px 8px;text-transform:uppercase}
      @keyframes minimapIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      #minimap-section{animation:minimapIn 0.35s ease 0.5s both}
    `;
    document.head.appendChild(s);
  }

  minimapOrthoCamera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  minimapOrthoCamera.position.set(0, 30, 0);
  minimapOrthoCamera.lookAt(0, 0, 0);
  minimapOrthoCamera.up.set(0, 0, -1);
  minimapRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  minimapRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  minimapRenderer.setSize(MINIMAP_SIZE, MINIMAP_SIZE);
  minimapRenderer.setClearColor(0x0a1420, 1);

  const undoBtn = document.getElementById("undoBtn");
  let insertAfter = null;
  if (undoBtn) {
    let el = undoBtn.parentElement;
    while (
      el &&
      el.parentElement &&
      !el.parentElement.classList.contains("panel") &&
      !el.parentElement.id?.includes("left") &&
      !el.parentElement.id?.includes("sidebar") &&
      el.parentElement.tagName !== "ASIDE" &&
      el !== document.body
    )
      el = el.parentElement;
    insertAfter = el;
  }

  const section = document.createElement("div");
  section.id = "minimap-section";
  const sectionHeader = document.createElement("div");
  sectionHeader.id = "minimap-section-header";
  sectionHeader.innerHTML = `<div id="minimap-section-title"><span>◈</span> OVERVIEW</div><div id="minimap-chevron">▾</div>`;
  sectionHeader.addEventListener("click", toggleMinimap);
  section.appendChild(sectionHeader);

  const body = document.createElement("div");
  body.id = "minimap-body";
  const canvasWrap = document.createElement("div");
  canvasWrap.id = "minimap-canvas-wrap";
  minimapRenderer.domElement.style.width = MINIMAP_SIZE + "px";
  minimapRenderer.domElement.style.height = MINIMAP_SIZE + "px";
  canvasWrap.appendChild(minimapRenderer.domElement);
  minimapCanvas = document.createElement("canvas");
  minimapCanvas.width = MINIMAP_SIZE;
  minimapCanvas.height = MINIMAP_SIZE;
  minimapCanvas.style.pointerEvents = "none";
  minimapCtx = minimapCanvas.getContext("2d");
  canvasWrap.appendChild(minimapCanvas);
  canvasWrap.addEventListener("click", onMinimapClick);
  body.appendChild(canvasWrap);
  const dimsBar = document.createElement("div");
  dimsBar.id = "minimap-dims-bar";
  dimsBar.innerHTML = `<span>W <span class="dim-val" id="mm-dim-w">—</span></span><span style="color:#2a3848">·</span><span>D <span class="dim-val" id="mm-dim-d">—</span></span><span style="color:#2a3848">·</span><span>H <span class="dim-val" id="mm-dim-h">—</span></span>`;
  body.appendChild(dimsBar);
  const hint = document.createElement("div");
  hint.id = "minimap-hint";
  hint.textContent = "Top view · Click to snap camera";
  body.appendChild(hint);
  section.appendChild(body);

  if (insertAfter?.parentElement)
    insertAfter.parentElement.insertBefore(section, insertAfter.nextSibling);
  else {
    const leftPanel =
      document.querySelector(".left-panel") ||
      document.querySelector(".sidebar-left") ||
      document.querySelector("aside") ||
      document.querySelector(".panel");
    if (leftPanel) leftPanel.appendChild(section);
    else document.body.appendChild(section);
  }
  minimapEl = section;
}

function toggleMinimap() {
  minimapCollapsed = !minimapCollapsed;
  const body = document.getElementById("minimap-body"),
    chevron = document.getElementById("minimap-chevron");
  if (body) body.classList.toggle("collapsed", minimapCollapsed);
  if (chevron) {
    chevron.style.transform = minimapCollapsed
      ? "rotate(-90deg)"
      : "rotate(0deg)";
    chevron.style.color = minimapCollapsed ? "#d05818" : "#384858";
  }
}

function onMinimapClick(e) {
  if (!minimapRenderer || !minimapOrthoCamera) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / MINIMAP_SIZE,
    ny = (e.clientY - rect.top) / MINIMAP_SIZE;
  const left = minimapOrthoCamera.left,
    right = minimapOrthoCamera.right,
    top = minimapOrthoCamera.top,
    bot = minimapOrthoCamera.bottom;
  const worldX = left + nx * (right - left),
    worldZ = top + ny * (bot - top);
  const camToTarget = new THREE.Vector3().subVectors(
    camera.position,
    controls.target,
  );
  const newTarget = new THREE.Vector3(worldX, controls.target.y, worldZ);
  const newPos = new THREE.Vector3().addVectors(newTarget, camToTarget);
  const startPos = camera.position.clone(),
    startTarget = controls.target.clone();
  const duration = 450,
    startTime = performance.now();
  function anim(now) {
    const t = Math.min((now - startTime) / duration, 1),
      ease = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(startPos, newPos, ease);
    controls.target.lerpVectors(startTarget, newTarget, ease);
    controls.update();
    if (t < 1) requestAnimationFrame(anim);
  }
  requestAnimationFrame(anim);
}

function updateMinimapCamera() {
  const box = new THREE.Box3();
  scene.traverse((o) => {
    if (o.userData?.isMount) box.union(new THREE.Box3().setFromObject(o));
  });
  let cx = 0,
    cz = 0,
    halfW = 4,
    halfH = 4;
  if (!box.isEmpty()) {
    const center = box.getCenter(new THREE.Vector3()),
      size = box.getSize(new THREE.Vector3());
    cx = center.x;
    cz = center.z;
    const padding = 1.5;
    halfW = Math.max(size.x / 2 + padding, 3);
    halfH = Math.max(size.z / 2 + padding, 3);
    const half = Math.max(halfW, halfH);
    halfW = halfH = half;
  }
  minimapOrthoCamera._worldLeft = cx - halfW;
  minimapOrthoCamera._worldRight = cx + halfW;
  minimapOrthoCamera._worldZMin = cz - halfH;
  minimapOrthoCamera._worldZMax = cz + halfH;

  minimapOrthoCamera.left = -halfW;
  minimapOrthoCamera.right = halfW;
  minimapOrthoCamera.top = halfH;
  minimapOrthoCamera.bottom = -halfH;

  minimapOrthoCamera.position.set(cx, 30, cz);
  minimapOrthoCamera.lookAt(cx, 0, cz);
  minimapOrthoCamera.updateProjectionMatrix();
}

function drawMinimapOverlay() {
  if (!minimapCtx) return;
  const ctx = minimapCtx,
    SIZE = MINIMAP_SIZE,
    cam = minimapOrthoCamera;
  ctx.clearRect(0, 0, SIZE, SIZE);
  const toUV = (wx, wz) => [
    ((wx - cam._worldLeft) / (cam._worldRight - cam._worldLeft)) * SIZE,
    ((wz - cam._worldZMin) / (cam._worldZMax - cam._worldZMin)) * SIZE,
  ];

  // ── Brighter grid ──────────────────────────────────────────────────
  const step = (cam._worldRight - cam._worldLeft) / 8;
  ctx.save();
  ctx.strokeStyle = "rgba(80,120,170,0.28)";
  ctx.lineWidth = 0.5;
  for (let wx = cam._worldLeft; wx <= cam._worldRight; wx += step) {
    const [sx] = toUV(wx, cam._worldZMin);
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, SIZE);
    ctx.stroke();
  }
  for (let wz = cam._worldZMin; wz <= cam._worldZMax; wz += step) {
    const [, sy] = toUV(cam._worldLeft, wz);
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(SIZE, sy);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(100,150,200,0.18)";
  ctx.lineWidth = 1;
  for (let wx = cam._worldLeft; wx <= cam._worldRight; wx += step * 4) {
    const [sx] = toUV(wx, cam._worldZMin);
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, SIZE);
    ctx.stroke();
  }
  for (let wz = cam._worldZMin; wz <= cam._worldZMax; wz += step * 4) {
    const [, sy] = toUV(cam._worldLeft, wz);
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(SIZE, sy);
    ctx.stroke();
  }
  ctx.restore();

  // ── Build bounding box of all placed parts ─────────────────────────
  const bbox = new THREE.Box3();
  scene.traverse((o) => {
    if (o.userData?.isMount) bbox.union(new THREE.Box3().setFromObject(o));
  });

  if (!bbox.isEmpty()) {
    const bmin = bbox.min,
      bmax = bbox.max;
    const [x0, y0] = toUV(bmin.x, bmin.z);
    const [x1, y1] = toUV(bmax.x, bmax.z);
    const bw = x1 - x0,
      bh = y1 - y0;

    // ── Bounding box fill + stroke ───────────────────────────────────
    ctx.save();
    ctx.fillStyle = "rgba(208,88,24,0.07)";
    ctx.fillRect(x0, y0, bw, bh);
    ctx.strokeStyle = "rgba(208,88,24,0.6)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0, y0, bw, bh);
    ctx.setLineDash([]);
    ctx.restore();

    // ── Corner ticks ────────────────────────────────────────────────
    const tk = 6;
    ctx.save();
    ctx.strokeStyle = "rgba(208,120,24,0.9)";
    ctx.lineWidth = 1.5;
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ].forEach(([cx, cy], i) => {
      const dx = i === 0 || i === 3 ? 1 : -1,
        dy = i === 0 || i === 1 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + dx * tk, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy + dy * tk);
      ctx.stroke();
    });
    ctx.restore();

    // ── Dimension arrows (width along bottom, depth along right) ────
    const MARGIN = 18,
      AH = 7,
      FONT = "bold 8px 'Orbitron',sans-serif";
    const worldW = bmax.x - bmin.x,
      worldD = bmax.z - bmin.z,
      worldH = bmax.y - bmin.y;
    const wStr = (worldW * WORLD_TO_CM).toFixed(1) + "cm",
      dStr = (worldD * WORLD_TO_CM).toFixed(1) + "cm";

    ctx.save();
    ctx.font = FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Width arrow — below the bounding box
    const arrowY = Math.min(y1 + MARGIN, SIZE - 10);
    if (arrowY < SIZE - 4) {
      ctx.strokeStyle = "rgba(100,180,220,0.9)";
      ctx.fillStyle = "rgba(100,180,220,0.9)";
      ctx.lineWidth = 1;
      // line
      ctx.beginPath();
      ctx.moveTo(x0, arrowY);
      ctx.lineTo(x1, arrowY);
      ctx.stroke();
      // arrowheads
      [
        [x0, 1],
        [x1, -1],
      ].forEach(([ax, dir]) => {
        ctx.beginPath();
        ctx.moveTo(ax, arrowY);
        ctx.lineTo(ax + dir * AH, arrowY - 3);
        ctx.lineTo(ax + dir * AH, arrowY + 3);
        ctx.closePath();
        ctx.fill();
      });
      // tick caps
      ctx.strokeStyle = "rgba(100,180,220,0.6)";
      [x0, x1].forEach((ax) => {
        ctx.beginPath();
        ctx.moveTo(ax, arrowY - 4);
        ctx.lineTo(ax, arrowY + 4);
        ctx.stroke();
      });
      // label
      const lx = (x0 + x1) / 2;
      ctx.fillStyle = "rgba(8,16,28,0.92)";
      const wtw = ctx.measureText(wStr).width;
      ctx.fillRect(lx - wtw / 2 - 5, arrowY - 9, wtw + 10, 18);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(wStr, lx, arrowY);
    }

    // Depth arrow — right of the bounding box
    const arrowX = Math.min(x1 + MARGIN, SIZE - 10);
    if (arrowX < SIZE - 4) {
      ctx.strokeStyle = "rgba(180,220,100,0.9)";
      ctx.fillStyle = "rgba(180,220,100,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(arrowX, y0);
      ctx.lineTo(arrowX, y1);
      ctx.stroke();
      [
        [y0, 1],
        [y1, -1],
      ].forEach(([ay, dir]) => {
        ctx.beginPath();
        ctx.moveTo(arrowX, ay);
        ctx.lineTo(arrowX - 3, ay + dir * AH);
        ctx.lineTo(arrowX + 3, ay + dir * AH);
        ctx.closePath();
        ctx.fill();
      });
      ctx.strokeStyle = "rgba(180,220,100,0.6)";
      [y0, y1].forEach((ay) => {
        ctx.beginPath();
        ctx.moveTo(arrowX - 4, ay);
        ctx.lineTo(arrowX + 4, ay);
        ctx.stroke();
      });
      const ly = (y0 + y1) / 2;
      ctx.save();
      ctx.translate(arrowX, ly);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "rgba(8,16,28,0.92)";
      const dtw = ctx.measureText(dStr).width;
      ctx.fillRect(-dtw / 2 - 5, -9, dtw + 10, 18);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(dStr, 0, 0);
      ctx.restore();
    }
    ctx.restore();

    // ── Update dims bar ──────────────────────────────────────────────
    const wEl = document.getElementById("mm-dim-w");
    const dEl = document.getElementById("mm-dim-d");
    const hEl = document.getElementById("mm-dim-h");
    if (wEl) wEl.textContent = (worldW * WORLD_TO_CM).toFixed(1) + "cm";
    if (dEl) dEl.textContent = (worldD * WORLD_TO_CM).toFixed(1) + "cm";
    if (hEl) hEl.textContent = (worldH * WORLD_TO_CM).toFixed(1) + "cm";
  }

  // ── Selected mount ring ──────────────────────────────────────────
  scene.traverse((mount) => {
    if (!mount.userData?.isMount || mount !== selectedMount) return;
    const [px, py] = toUV(mount.position.x, mount.position.z);
    ctx.save();
    ctx.strokeStyle = "rgba(220,80,0,0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, py, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  });

  drawCompass(ctx, SIZE);
}

function getFrustumFootprint() {
  const corners2D = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const result = [],
    ray = new THREE.Ray();
  for (const [nx, ny] of corners2D) {
    const ndc = new THREE.Vector3(nx, ny, 0.5);
    ndc.unproject(camera);
    ray.origin.copy(camera.position);
    ray.direction.subVectors(ndc, camera.position).normalize();
    const hit = new THREE.Vector3();
    if (ray.intersectPlane(groundPlane, hit)) result.push([hit.x, hit.z]);
  }
  return result.length === 4 ? result : [];
}

function drawCompass(ctx, SIZE) {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  dir.y = 0;
  if (dir.lengthSq() < 0.001) return;
  dir.normalize();
  const cx = SIZE - 22,
    cy = 22,
    r = 14;
  ctx.save();
  ctx.fillStyle = "rgba(10,16,26,0.75)";
  ctx.strokeStyle = "rgba(208,88,24,0.5)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(140,170,200,0.6)";
  ctx.font = "bold 7px 'Orbitron', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", cx, cy - r + 5);
  const angle = Math.atan2(dir.x, dir.z);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = "#e87030";
  ctx.beginPath();
  ctx.moveTo(0, -(r - 3));
  ctx.lineTo(3.5, 3);
  ctx.lineTo(0, 1);
  ctx.lineTo(-3.5, 3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(140,170,200,0.45)";
  ctx.beginPath();
  ctx.moveTo(0, r - 3);
  ctx.lineTo(2.5, -2);
  ctx.lineTo(0, 0);
  ctx.lineTo(-2.5, -2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

let _minimapFrameSkip = 0;

function renderMinimap() {
  if (!minimapRenderer || !minimapOrthoCamera || minimapCollapsed) return;
  _minimapFrameSkip++;
  if (_minimapFrameSkip % 2 !== 0) return;
  const hiddenObjects = [];
  scene.traverse((o) => {
    if (!o.visible) return;
    const isMarker = [
      ...frameMarkers,
      ...motorMarkers,
      ...triangleMarkers,
      ...frameOnSupportMarkers,
      ...wheelMarkers,
    ].includes(o);
    if (
      isMarker ||
      (ghost && isDescendantOf(o, ghost)) ||
      o === sceneGridMajor ||
      o === sceneGridMinor ||
      o === sceneGround
    ) {
      o.visible = false;
      hiddenObjects.push(o);
    }
  });
  updateMinimapCamera();
  const savedBg = scene.background ? scene.background.clone() : null,
    savedFog = scene.fog;
  scene.background = new THREE.Color(0x0a1420);
  scene.fog = null;
  minimapRenderer.render(scene, minimapOrthoCamera);
  scene.background = savedBg ?? new THREE.Color(0x8aaec8);
  scene.fog = savedFog;
  hiddenObjects.forEach((o) => {
    o.visible = true;
  });
  drawMinimapOverlay();
}

/* =========================================================
   COMPONENT PREVIEW — 3D ghost inset top-left of viewport
   ========================================================= */

let _cpRenderer = null;
let _cpScene = null;
let _cpCamera = null;
let _cpModel = null;
let _cpEl = null;
let _cpLabel = null;
let _cpSubLabel = null;
let _cpActive = false;
let _cpRotY = 0;

const PREVIEW_SIZE = 150; // px

const COMPONENT_PREVIEW_INFO = {
  frame: {
    label: "Rectangular Frame",
    sub: "Structural Base",
    color: "#797979",
    glyph: "▬",
  },
  motor: {
    label: "Motor Housing",
    sub: "Drive Unit",
    color: "#f9b100",
    glyph: "⬡",
  },
  triangle_frame: {
    label: "Triangular Frame",
    sub: "Angular Brace",
    color: "#ada7ab",
    glyph: "▲",
  },
  support_frame: {
    label: "Stress Bridge",
    sub: "Cross-Bridge Span",
    color: "#ff770e",
    glyph: "╬",
  },
  wheel: {
    label: "Wheel",
    sub: "Motor-Driven Wheel",
    color: "#36454f",
    glyph: "◉",
  },
};

function initComponentPreview() {
  if (!document.getElementById("cp-styles")) {
    const s = document.createElement("style");
    s.id = "cp-styles";
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&display=swap');
      #comp-preview-wrap {
        position: absolute;
        top: 18px;
        left: 18px;
        width: 180px;
        background: rgba(6,11,20,0.97);
        border: 1.5px solid rgba(208,88,24,0.5);
        border-left: 3px solid #d05818;
        clip-path: polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,0 100%);
        box-shadow: 0 8px 32px rgba(0,0,0,0.8), 0 0 0 1px rgba(208,88,24,0.15);
        backdrop-filter: blur(6px);
        z-index: 900;
        pointer-events: none;
        opacity: 0;
        transform: translateY(-10px);
        transition: opacity 0.28s ease, transform 0.28s ease;
        overflow: hidden;
      }
      #comp-preview-wrap.cp-visible {
        opacity: 1;
        transform: translateY(0);
      }
      #comp-preview-header {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 8px 10px 7px;
        border-bottom: 1px solid rgba(208,88,24,0.25);
        background: rgba(208,88,24,0.09);
      }
      #comp-preview-glyph {
        font-size: 15px;
        line-height: 1;
        flex-shrink: 0;
        filter: drop-shadow(0 0 5px currentColor);
      }
      #comp-preview-name {
        font-family: 'Oswald', sans-serif;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #ffffff;
        line-height: 1.2;
      }
      #comp-preview-sub {
        font-family: 'Oswald', sans-serif;
        font-size: 10px;
        font-weight: 400;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #7a9ab8;
        margin-top: 2px;
      }
      #comp-preview-canvas-wrap {
        width: 180px;
        height: 120px;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #1e2d3d 0%, #243447 50%, #1a2838 100%);
      }
      #comp-preview-canvas-wrap canvas {
        display: block;
      }
      #comp-preview-weight-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 5px 10px;
        border-top: 1px solid rgba(255,255,255,0.07);
        border-bottom: 1px solid rgba(208,88,24,0.18);
        background: rgba(0,0,0,0.3);
      }
      #comp-preview-weight-label {
        font-family: 'Oswald', sans-serif;
        font-size: 8px;
        font-weight: 500;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #7a9ab8;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      #comp-preview-weight-value {
        font-family: 'Oswald', sans-serif;
        font-size: 14px;
        font-weight: 600;
        letter-spacing: 0.06em;
        color: #e8f4ff;
      }
      #comp-preview-weight-unit {
        font-size: 9px;
        color: #5a7888;
        margin-left: 2px;
        font-family: 'Oswald', sans-serif;
        font-weight: 400;
        letter-spacing: 0.1em;
      }
      #comp-preview-footer {
        padding: 5px 10px 6px;
        display: flex;
        align-items: center;
        gap: 6px;
        background: rgba(0,0,0,0.2);
      }
      #comp-preview-dot {
        width: 5px; height: 5px; border-radius: 50%;
        flex-shrink: 0;
        animation: cpPulse 1.4s ease-in-out infinite;
      }
      @keyframes cpPulse {
        0%,100% { opacity: 1; transform: scale(1); }
        50%      { opacity: 0.4; transform: scale(0.65); }
      }
      #comp-preview-status {
        font-family: 'Oswald', sans-serif;
        font-size: 8px;
        font-weight: 400;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #8aacbf;
      }
      #comp-preview-accent-line {
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        background: linear-gradient(90deg, #d05818, rgba(208,88,24,0.15), transparent);
      }
    `;
    document.head.appendChild(s);
  }

  const viewport =
    document.getElementById("app")?.parentElement ?? document.body;
  const wrap = document.createElement("div");
  wrap.id = "comp-preview-wrap";

  const accentLine = document.createElement("div");
  accentLine.id = "comp-preview-accent-line";
  wrap.appendChild(accentLine);

  const header = document.createElement("div");
  header.id = "comp-preview-header";

  const glyph = document.createElement("div");
  glyph.id = "comp-preview-glyph";

  const textGroup = document.createElement("div");
  const name = document.createElement("div");
  name.id = "comp-preview-name";
  const sub = document.createElement("div");
  sub.id = "comp-preview-sub";
  textGroup.appendChild(name);
  textGroup.appendChild(sub);

  header.appendChild(glyph);
  header.appendChild(textGroup);
  wrap.appendChild(header);

  const canvasWrap = document.createElement("div");
  canvasWrap.id = "comp-preview-canvas-wrap";
  wrap.appendChild(canvasWrap);

  const weightRow = document.createElement("div");
  weightRow.id = "comp-preview-weight-row";
  const weightLabel = document.createElement("div");
  weightLabel.id = "comp-preview-weight-label";
  weightLabel.innerHTML = `<span style="opacity:0.5">⊕</span> WEIGHT`;
  const weightRight = document.createElement("div");
  const weightValue = document.createElement("span");
  weightValue.id = "comp-preview-weight-value";
  const weightUnit = document.createElement("span");
  weightUnit.id = "comp-preview-weight-unit";
  weightUnit.textContent = "g";
  weightRight.appendChild(weightValue);
  weightRight.appendChild(weightUnit);
  weightRow.appendChild(weightLabel);
  weightRow.appendChild(weightRight);
  wrap.appendChild(weightRow);

  const footer = document.createElement("div");
  footer.id = "comp-preview-footer";
  const dot = document.createElement("div");
  dot.id = "comp-preview-dot";
  const status = document.createElement("div");
  status.id = "comp-preview-status";
  status.textContent = "Selected Component";
  footer.appendChild(dot);
  footer.appendChild(status);
  wrap.appendChild(footer);

  viewport.style.position = "relative";
  viewport.appendChild(wrap);

  _cpEl = wrap;
  _cpLabel = name;
  _cpSubLabel = sub;

  _cpRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  _cpRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _cpRenderer.setSize(180, 120);
  _cpRenderer.setClearColor(0x1e2d3d, 1);
  _cpRenderer.outputColorSpace = THREE.SRGBColorSpace;
  _cpRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  _cpRenderer.toneMappingExposure = 2.4;
  canvasWrap.appendChild(_cpRenderer.domElement);

  _cpScene = new THREE.Scene();
  _cpScene.background = new THREE.Color(0x1e2d3d);
  _cpCamera = new THREE.PerspectiveCamera(38, 150 / 100, 0.01, 100);
  _cpCamera.position.set(0, 0, 4);

  _cpScene.add(new THREE.AmbientLight(0xffffff, 1.4));

  const keyL = new THREE.DirectionalLight(0xffffff, 4.0);
  keyL.position.set(4, 5, 6);
  _cpScene.add(keyL);

  const fillL = new THREE.DirectionalLight(0xd0e8ff, 2.2);
  fillL.position.set(-5, 3, 4);
  _cpScene.add(fillL);

  const rimL = new THREE.DirectionalLight(0xffd0a0, 2.0);
  rimL.position.set(-3, 6, -5);
  _cpScene.add(rimL);

  const bottomL = new THREE.DirectionalLight(0xffffff, 1.2);
  bottomL.position.set(0, -4, 3);
  _cpScene.add(bottomL);
}
function showComponentPreview(type, template) {
  if (!_cpEl || !_cpScene || !_cpRenderer) return;
  const info = COMPONENT_PREVIEW_INFO[type] ?? {
    label: type,
    sub: "",
    color: "#d05818",
    glyph: "◈",
  };

  // Update header text & accent color
  _cpLabel.textContent = info.label;
  _cpSubLabel.textContent = info.sub;
  const glyphEl = document.getElementById("comp-preview-glyph");
  if (glyphEl) {
    glyphEl.textContent = info.glyph;
    glyphEl.style.color = info.color;
  }
  const dot = document.getElementById("comp-preview-dot");
  if (dot) dot.style.background = info.color;
  const accentLine = document.getElementById("comp-preview-accent-line");
  if (accentLine)
    accentLine.style.background = `linear-gradient(90deg, ${info.color}, rgba(208,88,24,0.1), transparent)`;
  if (_cpEl) {
    _cpEl.style.borderLeftColor = info.color;
  }

  // Update weight
  const wg = PART_WEIGHTS[type] ?? 0;
  const weightValEl = document.getElementById("comp-preview-weight-value");
  const weightUnitEl = document.getElementById("comp-preview-weight-unit");
  if (weightValEl && weightUnitEl) {
    if (wg >= 1000) {
      weightValEl.textContent = (wg / 1000).toFixed(2);
      weightUnitEl.textContent = " kg";
    } else {
      weightValEl.textContent = wg;
      weightUnitEl.textContent = " g";
    }
    weightValEl.style.color = info.color;
  }

  // Remove old model from preview scene
  if (_cpModel) {
    _cpScene.remove(_cpModel);
    _cpModel = null;
  }

  // Clone & solidify for preview
  const clone = template.clone(true);
  clone.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((mat) => {
      if (!mat) return;
      mat = mat.clone();
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
      o.material = mat;
    });
  });

  // Auto-fit model into the preview camera view
  const box = new THREE.Box3().setFromObject(clone);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = (_cpCamera.fov * Math.PI) / 180;
  const dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.6;

  clone.position.sub(center); // center the model
  _cpModel = new THREE.Group();
  _cpModel.add(clone);
  _cpScene.add(_cpModel);

  _cpCamera.position.set(dist * 0.5, dist * 0.28, dist * 0.75);
  _cpCamera.lookAt(0, 0, 0);

  _cpRotY = 0;
  _cpActive = true;
  _cpEl.classList.add("cp-visible");
}

function hideComponentPreview() {
  _cpActive = false;
  if (_cpEl) _cpEl.classList.remove("cp-visible");
}

function renderComponentPreview() {
  if (!_cpActive || !_cpRenderer || !_cpScene || !_cpCamera) return;
  _cpRotY += 0.008;
  if (_cpModel) _cpModel.rotation.y = _cpRotY;
  _cpRenderer.render(_cpScene, _cpCamera);
}
/* =========================================================
   RAZORPAY PAYMENT
   ========================================================= */

async function loadRazorpayScript() {
  if (window.Razorpay) return;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Failed to load Razorpay script"));
    document.head.appendChild(script);
  });
}

async function initiateRazorpayPayment({
  savedOrder,
  orderRef,
  totalCost,
  totalParts,
  customerName,
  customerPhone,
  addrLines,
}) {
  await loadRazorpayScript();

  const amountNum = parseFloat(String(totalCost).replace(/[^0-9.]/g, "")) || 0;

  showHudMessage("CONNECTING TO PAYMENT GATEWAY...");

  let razorpayOrderId;
  let razorpayKey;
  try {
    const rzpRes = await fetch("/api/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: amountNum,
        currency: "INR",
        receipt: orderRef,
      }),
    });
    const fnData = await rzpRes.json();
    if (!rzpRes.ok) throw new Error(fnData?.error ?? "Razorpay API error");
    if (!fnData?.id) throw new Error("No order ID returned from Razorpay");

    razorpayOrderId = fnData.id;
    razorpayKey = fnData.key_id;
    showHudMessage("GATEWAY CONNECTED ✓");
  } catch (err) {
    showHudMessage("⚠ Payment init failed: " + err.message.slice(0, 60));
    throw err;
  }

  return new Promise((resolve, reject) => {
    const options = {
      key: razorpayKey,
      amount: Math.round(amountNum * 100),
      currency: "INR",
      name: "Robot Configurator",
      description: `MK-1 Build · ${orderRef}`,
      order_id: razorpayOrderId,
      prefill: {
        name: customerName,
        contact: "+91" + customerPhone,
      },
      notes: {
        order_ref: orderRef,
        db_order_id: String(savedOrder.id),
      },
      theme: {
        color: "#d05818",
      },
      modal: {
        backdropclose: false,
        escape: false,
        confirm_close: true,
        ondismiss: async () => {
          showHudMessage("⚠ Payment cancelled");
          await supabase.from("orders").delete().eq("id", savedOrder.id);
          reject(new Error("Payment dismissed by user"));
        },
      },

      handler: async function (response) {
        showHudMessage("PAYMENT RECEIVED — CONFIRMING...");
        console.log("[RAZORPAY] Payment response:", response);

        try {
          const { error: updateErr } = await supabase
            .from("orders")
            .update({
              status: "paid",
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            })
            .eq("id", savedOrder.id);
          if (updateErr)
            console.error("[RAZORPAY] DB update error:", updateErr);
          else console.log("[RAZORPAY] DB updated successfully");
        } catch (dbErr) {
          console.error("[RAZORPAY] DB update failed:", dbErr);
        }

        showHudMessage("GENERATING DESIGN REPORT...");
        await uploadPrintReport(savedOrder.id, orderRef);

        showHudMessage("PAYMENT SUCCESSFUL ✓");

        showOrderConfirmOverlay(
          addrLines,
          orderRef,
          totalCost,
          totalParts,
          response,
          savedOrder,
        );

        resolve(response);
      },
    };

    const rzp = new window.Razorpay(options);

    rzp.on("payment.failed", async (response) => {
      const errDesc = response?.error?.description ?? "Payment failed";
      showHudMessage("⚠ " + errDesc);
      await supabase.from("orders").delete().eq("id", savedOrder.id);
      reject(new Error(errDesc));
    });

    rzp.open();
  });
}
