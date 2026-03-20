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
// ── Tracks the UUID of the last triangle socket hovered so that returning to
//    the same socket after briefly leaving does NOT reset the manual rotation.
let lastHoveredTriangleSocketUUID = null;

// ── Support auto-orientation state (1-click placement) ───────────────────────
let supportManualRotSteps = 0;
// ── Two-click support bridge state ───────────────────────────────────────────
// After the user clicks the first socket, it is stored here until they click
// the second socket on a different triangle mount.
let supportFirstSocket = null;
let supportFirstMarker = null; // the marker mesh that got locked
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
const redoStack = [];
const MAX_UNDO = 50;

function pushUndo(mount, socketUuids, type) {
  undoStack.push({ mount, socketUuids: [...socketUuids], type });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  // Any new action clears the redo history
  redoStack.length = 0;
  updateUndoRedoButtons();
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

  // ── Switch to clean white background, hide floor ──────────────────────────
  const savedBg = scene.background ? scene.background.clone() : null;
  const savedFog = scene.fog;
  scene.background = new THREE.Color(0xffffff);
  scene.fog = null;
  renderer.setClearColor(0xffffff, 1);
  if (sceneGridMajor) sceneGridMajor.visible = false;
  if (sceneGridMinor) sceneGridMinor.visible = false;
  if (sceneGround) sceneGround.visible = false;
  // ─────────────────────────────────────────────────────────────────────────

  renderer.render(scene, camera);
  const dataURL = renderer.domElement.toDataURL("image/png");

  // ── Restore scene state ───────────────────────────────────────────────────
  scene.background = savedBg ?? new THREE.Color(0x8aaec8);
  scene.fog = savedFog;
  renderer.setClearColor(0x8aaec8, 1);
  if (sceneGridMajor) sceneGridMajor.visible = true;
  if (sceneGridMinor) sceneGridMinor.visible = true;
  if (sceneGround) sceneGround.visible = true;
  // ─────────────────────────────────────────────────────────────────────────

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

/* =========================================================
   SOCKET MARKERS — LARGER SIZE + WIDER PROXIMITY
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

// ── Scene floor objects — stored so captureFromAngle can hide them ────────────
let sceneGridMajor = null;
let sceneGridMinor = null;
let sceneGround = null;
// ─────────────────────────────────────────────────────────────────────────────

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

  hoveredMotorMarker = null;
  hoveredTriangleMarker = null;

  rebuildSocketMarkers();
  updateWheelButtonState();
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

  frameTemplate = await loadGLB("/assets/models/rectangle_frame.glb");
  motorTemplate = await loadGLB("/assets/models/motor_housing.glb");
  triangleTemplate = await loadGLB("/assets/models/triangle_frame.glb");

  // Boost triangle material — GLB defaults can appear washed-out
  triangleTemplate.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((mat) => {
      if (!mat) return;
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
      // Increase perceived darkness/saturation so it reads clearly in the scene
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
  updateWheelButtonState();
  updateUndoRedoButtons();
  applySocketHighlights();

  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("click", onClick);
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
  bind("editBtn", onEdit);
  bind("proceedPaymentBtn", onProceedToPayment);
  bind("printDesignBtn", printDesign);
  bind("undoBtn", () => !isFinalized && performUndo());
  bind("redoBtn", () => !isFinalized && performRedo());

  const rotLeftBtn = document.getElementById("rotLeftBtn");
  const rotRightBtn = document.getElementById("rotRightBtn");

  // Also wire the new keyboard-style arrow key buttons
  const arrowLeft = document.getElementById("arrowKeyLeft");
  const arrowRight = document.getElementById("arrowKeyRight");

  function fireArrow(dir) {
    // Simulate the key logic inline so on-screen clicks behave identically
    // NOTE: motor rotation intentionally excluded — motor uses auto-orient only
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
    if (placementMode === "support" && ghost) {
      supportManualRotSteps += dir;
      const totalDeg = (((supportManualRotSteps % 4) + 4) % 4) * 90;
      showHudMessage(`Support manual offset: +${totalDeg}°`);
      updateShortcutBar();
      if (hoveredTriangleMarker) {
        const rawSocket = hoveredTriangleMarker.userData.socket;
        rawSocket.updateMatrixWorld(true);
        const pair = resolveBestSupportSocketPair(rawSocket);
        if (!pair) return;
        ghost.position.set(0, 0, 0);
        ghost.rotation.set(0, 0, 0);
        ghost.scale.set(1, 1, 1);
        ghost.updateMatrixWorld(true);
        applyTwoPointSupportSnap(
          ghost,
          ghost,
          pair.posA,
          pair.posB,
          supportManualRotSteps,
          rawSocket,
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
   FRAME-ON-SUPPORT GHOST REFRESH HELPER
   ─────────────────────────────────────────────────────────
   Called when frameOnSupportRotationSteps changes while the
   ghost is already hovering a support socket, so the preview
   updates immediately without waiting for the next mousemove.
   ========================================================= */

// Stores the last support socket the ghost snapped to, so we can re-snap
// when the user changes rotation steps via arrow keys.

/* =========================================================
   FINALIZE / EDIT
   ========================================================= */

function onFinalize() {
  if (isFinalized) return;
  isFinalized = true;
  clearGhost();
  document.getElementById("paymentSection")?.classList.remove("hidden");
  const btn = document.getElementById("finalizeBtn");
  if (btn) {
    btn.innerHTML = `<div class="btn-inner">
      <span class="btn-icon">◈</span>
      <span class="btn-action-label">Edit Design</span>
    </div>`;
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener("click", onEdit);
  }
}

function onEdit() {
  if (!isFinalized) return;
  isFinalized = false;
  document.getElementById("paymentSection")?.classList.add("hidden");
  const btn = document.getElementById("finalizeBtn");
  if (btn) {
    btn.innerHTML = `<div class="btn-inner">
      <span class="btn-icon">◼</span>
      <span class="btn-action-label">Finalize Design</span>
    </div>`;
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener("click", onFinalize);
  }
}

function onProceedToPayment() {
  const existing = document.getElementById("payment-confirm-popup");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "payment-confirm-popup";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    background: "rgba(0,0,0,0.82)",
    zIndex: "9999999",
    pointerEvents: "all",
  });

  const box = document.createElement("div");
  Object.assign(box.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    zIndex: "10000000",
    background: "#18202e",
    border: "2px solid #d05818",
    padding: "36px 44px",
    maxWidth: "480px",
    width: "92%",
    fontFamily: "'Share Tech Mono', monospace",
    color: "#c8d8e4",
    textAlign: "center",
    clipPath: "polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,0 100%)",
    boxShadow: "0 0 50px rgba(208,88,24,0.25), 0 20px 60px rgba(0,0,0,0.6)",
  });

  const topLine = document.createElement("div");
  Object.assign(topLine.style, {
    position: "absolute",
    top: "0",
    left: "0",
    right: "0",
    height: "2px",
    background: "linear-gradient(90deg, transparent, #d05818, transparent)",
  });
  box.appendChild(topLine);

  const badge = document.createElement("div");
  badge.textContent = "⚠  PAYMENT CONFIRMATION";
  Object.assign(badge.style, {
    fontSize: "9px",
    letterSpacing: "0.24em",
    color: "#d05818",
    marginBottom: "20px",
    fontWeight: "700",
    fontFamily: "'Orbitron', sans-serif",
  });

  const title = document.createElement("div");
  title.textContent = "Proceeding to Payment";
  Object.assign(title.style, {
    fontSize: "16px",
    fontFamily: "'Orbitron', sans-serif",
    fontWeight: "700",
    color: "#d8e8f4",
    letterSpacing: "0.1em",
    marginBottom: "14px",
  });

  const msg = document.createElement("div");
  msg.textContent =
    "Are you sure your design is final? Once you proceed, you will be taken to payment and the build cannot be modified.";
  Object.assign(msg.style, {
    fontSize: "12px",
    lineHeight: "1.7",
    color: "#6a8098",
    marginBottom: "28px",
    letterSpacing: "0.04em",
  });

  const counts = {};
  scene.traverse((o) => {
    if (!o.userData?.isMount) return;
    const t = o.userData.type ?? "unknown";
    counts[t] = (counts[t] ?? 0) + 1;
  });
  const totalParts = Object.values(counts).reduce((a, b) => a + b, 0);
  const totalCost = document.getElementById("totalPrice")?.textContent ?? "0";

  const summary = document.createElement("div");
  Object.assign(summary.style, {
    background: "rgba(208,88,24,0.07)",
    border: "1px solid rgba(208,88,24,0.22)",
    padding: "12px 18px",
    marginBottom: "26px",
    display: "flex",
    justifyContent: "space-around",
    gap: "16px",
  });

  const makeStatBlock = (label, value) => {
    const block = document.createElement("div");
    Object.assign(block.style, { textAlign: "center" });
    const valEl = document.createElement("div");
    valEl.textContent = value;
    Object.assign(valEl.style, {
      fontFamily: "'Orbitron', sans-serif",
      fontSize: "18px",
      fontWeight: "700",
      color: "#d05818",
      letterSpacing: "0.06em",
      lineHeight: "1",
    });
    const lblEl = document.createElement("div");
    lblEl.textContent = label;
    Object.assign(lblEl.style, {
      fontSize: "8px",
      letterSpacing: "0.15em",
      color: "#384858",
      marginTop: "4px",
      textTransform: "uppercase",
    });
    block.appendChild(valEl);
    block.appendChild(lblEl);
    return block;
  };

  summary.appendChild(makeStatBlock("PARTS", totalParts));
  const divider = document.createElement("div");
  Object.assign(divider.style, {
    width: "1px",
    background: "rgba(208,88,24,0.2)",
    flexShrink: "0",
  });
  summary.appendChild(divider);
  summary.appendChild(makeStatBlock("TOTAL COST", "₹" + totalCost));

  const btnRow = document.createElement("div");
  Object.assign(btnRow.style, {
    display: "flex",
    gap: "12px",
    justifyContent: "center",
  });

  function makeBtn(label, primary) {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      background: primary ? "#d05818" : "transparent",
      border: "2px solid #d05818",
      color: primary ? "#0e1018" : "#d05818",
      fontFamily: "'Orbitron', sans-serif",
      fontSize: "9px",
      letterSpacing: "0.2em",
      padding: "11px 26px",
      cursor: "pointer",
      textTransform: "uppercase",
      transition: "all 0.15s",
      boxShadow: primary ? "4px 4px 0 #5a2008" : "none",
    });
    b.onmouseover = () => {
      b.style.background = "#d05818";
      b.style.color = "#0e1018";
      b.style.boxShadow = "4px 4px 0 #5a2008";
    };
    b.onmouseout = () => {
      b.style.background = primary ? "#d05818" : "transparent";
      b.style.color = primary ? "#0e1018" : "#d05818";
      b.style.boxShadow = primary ? "4px 4px 0 #5a2008" : "none";
    };
    return b;
  }

  const cancelBtn = makeBtn("GO BACK", false);
  cancelBtn.onclick = () => overlay.remove();

  const confirmBtn = makeBtn("YES, PROCEED", true);
  confirmBtn.onclick = () => {
    overlay.remove();
    showAddressOverlay();
  };

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(confirmBtn);

  box.appendChild(badge);
  box.appendChild(title);
  box.appendChild(msg);
  box.appendChild(summary);
  box.appendChild(btnRow);
  overlay.appendChild(box);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}

/* =========================================================
   ADDRESS OVERLAY — shown in-page, no navigation
   ========================================================= */

function showAddressOverlay() {
  const existing = document.getElementById("addr-overlay");
  if (existing) existing.remove();

  // ── Collect order data ────────────────────────────────────────────────────
  const counts = {};
  scene.traverse((o) => {
    if (!o.userData?.isMount) return;
    const t = o.userData.type ?? "unknown";
    counts[t] = (counts[t] ?? 0) + 1;
  });
  const totalCost = document.getElementById("totalPrice")?.textContent ?? "0";
  const totalParts = Object.values(counts).reduce((a, b) => a + b, 0);
  const orderRef = "MK1-" + Date.now().toString(36).toUpperCase().slice(-8);

  // ── All Indian states ─────────────────────────────────────────────────────
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

  // ── Inject styles once ────────────────────────────────────────────────────
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
      .addr-input::placeholder { color:#2a3848; }
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
        color:#6a8098; font-size:14px; pointer-events:none;
      }
      .addr-select option { background:#18202e; color:#d8e8f4; }
      .addr-label {
        font-family:'Orbitron',sans-serif; font-size:7.5px; font-weight:700;
        letter-spacing:0.22em; text-transform:uppercase; color:#6a8098;
        display:block; margin-bottom:6px;
      }
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
      .addr-btn-cancel { background:transparent; border-color:#2a3848; color:#6a8098; box-shadow:3px 3px 0 #0e1420; }
      .addr-btn-cancel:hover { background:#1e2838; border-color:#6a8098; color:#d8e8f4; box-shadow:5px 5px 0 #0e1420; transform:translate(-2px,-2px); }
      .addr-btn-submit { background:transparent; border-color:#d05818; color:#d05818; box-shadow:4px 4px 0 #5a2008; }
      .addr-btn-submit:hover { background:#d05818; color:#0e1018; box-shadow:6px 6px 0 #5a2008; transform:translate(-2px,-2px); }
      @media(max-width:540px){
        .addr-row-2,.addr-row-211{ grid-template-columns:1fr; }
      }
    `;
    document.head.appendChild(s);
  }

  // ── Backdrop ──────────────────────────────────────────────────────────────
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

  // ── Card ─────────────────────────────────────────────────────────────────
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

  // accent line
  const al = document.createElement("div");
  Object.assign(al.style, {
    height: "2px",
    background:
      "linear-gradient(90deg,#d05818,rgba(208,88,24,0.1),transparent)",
  });
  card.appendChild(al);

  // ── Order summary strip ───────────────────────────────────────────────────
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

  // ── Form ─────────────────────────────────────────────────────────────────
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

  // ── Field helpers ─────────────────────────────────────────────────────────
  const mkField = (labelTxt, placeholder, required = true, type = "text") => {
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
    inp.autocomplete = "off";
    inp.addEventListener("input", () => inp.classList.remove("addr-err"));
    wrap.appendChild(lbl);
    wrap.appendChild(inp);
    return { wrap, inp };
  };

  const mkSelect = (labelTxt, options, required = true) => {
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
    return { wrap, inp: sel };
  };

  const mkRow = (cls, ...fields) => {
    const r = document.createElement("div");
    r.className = `addr-row ${cls}`;
    fields.forEach((f) => r.appendChild(f.wrap));
    return r;
  };

  // ── Fields ────────────────────────────────────────────────────────────────
  const fLine1 = mkField("Address Line 1", "House / Flat No., Building Name");
  const fLine2 = mkField("Address Line 2", "Street, Area, Landmark", false);
  const fLine3 = mkField("Address Line 3", "Locality / Neighbourhood", false);
  const fCity = mkField("City", "e.g. Bengaluru");
  const fState = mkSelect("State", INDIAN_STATES);
  const fPin = mkField("PIN Code", "560001");
  const fPhone = mkField("Phone Number", "+91 98765 43210", true, "tel");

  body.appendChild(mkRow("addr-row-1", fLine1));
  body.appendChild(mkRow("addr-row-1", fLine2));
  body.appendChild(mkRow("addr-row-1", fLine3));
  body.appendChild(mkRow("addr-row-211", fCity, fState, fPin));
  body.appendChild(mkRow("addr-row-1", fPhone));

  // divider
  const divider = document.createElement("div");
  Object.assign(divider.style, {
    height: "1px",
    background: "rgba(255,255,255,0.05)",
    margin: "18px 0 16px",
  });
  body.appendChild(divider);

  // button row
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
  cancelBtn2.className = "addr-btn addr-btn-cancel";
  cancelBtn2.textContent = "CANCEL";
  cancelBtn2.onclick = () => backdrop.remove();

  const submitBtn = document.createElement("button");
  submitBtn.className = "addr-btn addr-btn-submit";
  submitBtn.innerHTML = `<span>▶</span> PROCEED TO PAYMENT`;
  submitBtn.onclick = () => {
    // Validate required fields
    const requiredFields = [fLine1, fCity, fState, fPin, fPhone];
    let valid = true;
    requiredFields.forEach((f) => {
      if (!f.inp.value.trim()) {
        f.inp.classList.add("addr-err");
        valid = false;
      }
    });
    // PIN: 6 digits
    if (fPin.inp.value.trim() && !/^\d{6}$/.test(fPin.inp.value.trim())) {
      fPin.inp.classList.add("addr-err");
      valid = false;
    }
    // Phone: at least 10 digits
    if (
      fPhone.inp.value.trim() &&
      fPhone.inp.value.replace(/\D/g, "").length < 10
    ) {
      fPhone.inp.classList.add("addr-err");
      valid = false;
    }
    if (!valid) {
      showHudMessage("⚠ Please fill in all required fields correctly");
      return;
    }

    const addrLines = [
      fLine1.inp.value.trim(),
      fLine2.inp.value.trim(),
      fLine3.inp.value.trim(),
      `${fCity.inp.value.trim()}, ${fState.inp.value.trim()} — ${fPin.inp.value.trim()}`,
      fPhone.inp.value.trim(),
    ].filter(Boolean);

    backdrop.remove();
    showOrderConfirmOverlay(addrLines, orderRef, totalCost, totalParts);
  };

  btnGroup.appendChild(cancelBtn2);
  btnGroup.appendChild(submitBtn);
  btnRow.appendChild(note);
  btnRow.appendChild(btnGroup);
  body.appendChild(btnRow);

  card.appendChild(body);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  setTimeout(() => fLine1.inp.focus(), 120);
}

/* =========================================================
   ORDER CONFIRMATION OVERLAY
   ========================================================= */

function showOrderConfirmOverlay(addrLines, orderRef, totalCost, totalParts) {
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
  refEl.textContent = `ORDER REF: ${orderRef}`;
  Object.assign(refEl.style, {
    fontFamily: "'Orbitron',sans-serif",
    fontSize: "9px",
    fontWeight: "700",
    letterSpacing: "0.2em",
    color: "#384858",
    marginBottom: "24px",
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "addr-btn addr-btn-submit";
  closeBtn.style.margin = "0 auto";
  closeBtn.style.justifyContent = "center";
  closeBtn.textContent = "CLOSE";
  closeBtn.onclick = () => backdrop.remove();

  card.appendChild(icon);
  card.appendChild(title);
  card.appendChild(sub);
  card.appendChild(addrBox);
  card.appendChild(refEl);
  card.appendChild(closeBtn);

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
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

// ── CHANGE: removed "← →" entry from motor shortcuts (motor is auto-orient only)
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
    chainEl.innerHTML =
      `<span style="color:#cc2200">⟳</span>` +
      `<span>QUEUED: ${queuedIntent.label} — ${need} more needed</span>`;
    chainEl.style.borderRight = "1px solid rgba(204,34,0,0.15)";
    shortcutBarEl.appendChild(chainEl);
  }

  const defs = SHORTCUT_DEFS[mode] || SHORTCUT_DEFS.idle;

  // ── CHANGE: motor arrow patching removed since motor has no arrow shortcut
  const patchedDefs = defs.map((d) => {
    if (mode === "frame" && d.key === "← →") {
      const deg = (((frameOnSupportRotationSteps % 4) + 4) % 4) * 90;
      return { key: "← →", action: `Rotate on support (${deg}°)` };
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

  // ── Help button — double downward chevron, centred in viewport ────────────
  const helpBtn = document.createElement("button");
  helpBtn.id = "help-toggle-btn";
  helpBtn.title = "Show shortcuts";
  helpBtn.innerHTML = `<span style="display:flex;flex-direction:column;align-items:center;gap:0px;line-height:0.75;pointer-events:none"><span style="transform:rotate(90deg);display:block;font-size:13px;font-weight:900">❯</span><span style="transform:rotate(90deg);display:block;font-size:13px;font-weight:900">❯</span></span>`;
  Object.assign(helpBtn.style, {
    position: "fixed",
    bottom: "10px",
    left: "auto",
    right: "auto",
    transform: "none",
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
  helpBtn.addEventListener("mouseover", () => {
    if (!shortcutBarVisible) {
      helpBtn.style.background = "rgba(208,88,24,0.2)";
      helpBtn.style.borderColor = "rgba(208,88,24,0.9)";
    }
  });
  helpBtn.addEventListener("mouseout", () => {
    if (!shortcutBarVisible) {
      helpBtn.style.background = "rgba(12,18,28,0.95)";
      helpBtn.style.borderColor = "rgba(208,88,24,0.6)";
    }
  });
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
      @keyframes sbItemIn {
        from { opacity:0; transform:translateY(4px); }
        to   { opacity:1; transform:translateY(0); }
      }
      .sb-sep { width:1px; height:18px; background:rgba(208,88,24,0.2); flex-shrink:0; margin:0; }
      .sb-item { display:flex; align-items:center; gap:7px; padding:0 16px; height:100%; animation:sbItemIn 0.18s ease both; cursor:default; flex-shrink:0; transition:background 0.15s; }
      .sb-item:hover { background:rgba(208,88,24,0.07); }
      .sb-key { font-family:'Orbitron',sans-serif; font-size:10px; font-weight:700; letter-spacing:0.1em; color:#e87030; background:rgba(208,88,24,0.15); border:1.5px solid rgba(208,88,24,0.5); padding:3px 8px; white-space:nowrap; line-height:1.4; }
      .sb-action { font-family:'Share Tech Mono',monospace; font-size:11px; letter-spacing:0.08em; color:#8aacbf; text-transform:uppercase; white-space:nowrap; }
      .sb-mode-label { font-family:'Orbitron',sans-serif; font-size:10px; font-weight:700; letter-spacing:0.2em; padding:0 18px; text-transform:uppercase; flex-shrink:0; white-space:nowrap; border-right:1px solid rgba(208,88,24,0.25); height:100%; display:flex; align-items:center; }
      .sb-chain-label { font-family:'Share Tech Mono',monospace; font-size:10px; letter-spacing:0.1em; color:#e87030; padding:0 14px; flex-shrink:0; white-space:nowrap; display:flex; align-items:center; gap:7px; border-right:1px solid rgba(208,88,24,0.2); }
      #help-toggle-btn.help-btn-active { background:rgba(208,88,24,0.25) !important; border-color:#d05818 !important; box-shadow:0 3px 0 rgba(0,0,0,0.6), 0 0 12px rgba(208,88,24,0.3) !important; }
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
  destroyContextMenu();
  document
    .querySelectorAll(".btn.active-mode")
    .forEach((b) => b.classList.remove("active-mode"));
  if (ghost) scene.remove(ghost);
  ghost = null;
  motorRotationGroup = null;
  placementMode = null;
  // ── CURSOR: remove placement-mode class when exiting any placement mode ──
  document.body.classList.remove("placement-mode");
  applySocketHighlights();
  frameOnSupportRotationSteps = 0;
  frameHoverType = "frame";

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

  motorAutoBaseYaw = 0;
  motorManualRotSteps = 0;

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

  // ── Hide the support axis guide line when leaving support mode ────────────
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
   ─────────────────────────────────────────────────────────
   When a click misses a socket marker by raycasting, this
   helper finds the nearest visible marker within thresholdPx
   screen pixels and returns it, so near-misses still place
   a part instead of exiting placement mode.
   ========================================================= */

function findNearestMarkerOnScreen(markers, thresholdPx) {
  thresholdPx = thresholdPx !== undefined ? thresholdPx : 40;
  const canvas = renderer.domElement;
  const rect = canvas.getBoundingClientRect();
  // Convert NDC mouse coords back to canvas pixels
  const mouseScreenX = ((mouse.x + 1) / 2) * rect.width;
  const mouseScreenY = ((1 - mouse.y) / 2) * rect.height;

  let best = null;
  let bestDist = thresholdPx;

  for (const m of markers) {
    if (!m.visible) continue;
    const projected = m.position.clone().project(camera);
    // projected.z > 1 means behind the camera
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

  // If this mesh still uses a shared material (no _origMat stored), clone it
  // so emissive changes don't bleed onto every other mesh using the same material.
  if (!mesh._origMat) {
    mesh._origMat = mesh.material; // remember the shared original
    mesh.material = mesh.material.clone(); // give this mesh its own copy
  }

  const prev = mesh.material.emissive.clone();
  mesh.material.emissive.set(colorHex);
  return prev;
}

function restoreMeshEmissive(mesh, savedColor) {
  if (!mesh?.material) return;

  if (mesh._origMat) {
    // Dispose the cloned material and restore the shared one
    mesh.material.dispose();
    mesh.material = mesh._origMat;
    delete mesh._origMat;
  } else if (mesh.material.emissive) {
    mesh.material.emissive.copy(savedColor);
  }
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
      if (o.name.startsWith("SOCKET_MOTOR")) return;
      if (o.name.startsWith("WHEEL_SOCKET")) return;
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
    if (!o.name || usedSockets.has(o.uuid)) return;
    if (suppressedSockets.has(o.uuid)) return;

    if (ghost && isDescendantOf(o, ghost)) return;

    // ── DISABLED: SOCKET_FRAME_SUPPORT_B on support_frame mounts ─────────────
    if (o.name.toUpperCase() === "SOCKET_FRAME_SUPPORT_B") {
      let parentMount = o.parent;
      while (parentMount && !parentMount.userData?.isMount)
        parentMount = parentMount.parent;
      if (parentMount && parentMount.userData.type === "support_frame") return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (o.name.startsWith("SOCKET_FRAME_SUPPORT")) {
      addMarker(o, frameOnSupportMarkers, supportFrameSocketMat);
      return;
    }

    if (o.name.startsWith("SOCKET_FRAME")) addMarker(o, frameMarkers, frameMat);
    if (o.name.startsWith("SOCKET_MOTOR")) addMarker(o, motorMarkers, motorMat);
    if (o.name.startsWith("WHEEL_SOCKET"))
      addMarker(o, wheelMarkers, wheelSocketMat);

    if (o.name.startsWith("SOCKET_TRIANGLE"))
      addMarker(o, triangleSocketMarkers, frameMat);
    if (o.name.startsWith("SOCKET_STRESS_CONNECTOR"))
      addMarker(o, stressConnectorMarkers, frameMat);
  });

  triangleMarkers = [...triangleSocketMarkers, ...stressConnectorMarkers];

  // ── Refresh axis line position whenever markers are rebuilt ───────────────
  // (covers the case where a bridge is placed and sockets are consumed)
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
    if (socketA && !usedSockets.has(socketA.uuid)) {
      valid.push(marker);
    }
  }
  return valid;
}

function applySocketHighlights() {
  const mode = placementMode;

  frameMarkers.forEach((m) => {
    m.visible = false;
  });
  frameOnSupportMarkers.forEach((m) => {
    m.visible = false;
  });
  motorMarkers.forEach((m) => {
    m.visible = false;
  });
  triangleSocketMarkers.forEach((m) => {
    m.visible = false;
  });
  stressConnectorMarkers.forEach((m) => {
    m.visible = false;
  });
  wheelMarkers.forEach((m) => {
    m.visible = false;
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
  }

  if (mode === "motor") {
    motorMarkers.forEach((m) => {
      m.visible = true;
      m.material = MAT_MOTOR_ACTIVE;
      m.scale.setScalar(1.5);
    });
  }

  if (mode === "triangle") {
    triangleSocketMarkers.forEach((m) => {
      m.visible = true;
      m.material = MAT_TRI_ACTIVE;
      m.scale.setScalar(1.5);
    });
  }

  if (mode === "support") {
    const validSet = new Set(getValidStressConnectorSockets());
    stressConnectorMarkers.forEach((m) => {
      if (validSet.has(m)) {
        m.visible = true;
        m.material = MAT_TRI_ACTIVE;
        m.scale.setScalar(1.5);
      }
    });
    // Refresh axis line position after visibility changes
  }

  if (mode === "wheel") {
    wheelMarkers.forEach((m) => {
      m.visible = true;
      m.material = MAT_WHEEL_ACTIVE;
      m.scale.setScalar(1.5);
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

// ── Arrow key highlight on physical keypress ──────────────────────────────────
function flashArrowKey(direction) {
  const id = direction === "left" ? "arrowKeyLeft" : "arrowKeyRight";
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("arrow-key-pressed");
  setTimeout(() => el.classList.remove("arrow-key-pressed"), 180);
}

// ── Wheel button enable/disable state ────────────────────────────────────────
function updateWheelButtonState() {
  const btn = document.getElementById("addWheelBtn");
  if (!btn) return;

  const motorsPlaced = countPlaced("motor");
  const hasFreeSockets = wheelMarkers.length > 0;
  const shouldEnable = motorsPlaced > 0 && hasFreeSockets;

  btn.disabled = !shouldEnable;
  btn.style.opacity = shouldEnable ? "1" : "0.35";
  btn.style.pointerEvents = shouldEnable ? "auto" : "none";
  btn.title = !motorsPlaced
    ? "Place a Motor first to unlock wheels"
    : !hasFreeSockets
      ? "All wheel sockets are occupied"
      : "";
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
  // ── CURSOR: entering placement mode ──
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
  // ── CURSOR: entering placement mode ──
  document.body.classList.add("placement-mode");
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
  // ── CURSOR: entering placement mode ──
  document.body.classList.add("placement-mode");
  applySocketHighlights();
  updateShortcutBar();
  updateLegendHighlight();
  showInstructionPanel("triangle");
  ghost = triangleTemplate.clone(true);
  makeGhost(ghost);
  scene.add(ghost);
  showRotationControls("triangle");
}

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
  // ── CURSOR: entering placement mode ──
  document.body.classList.add("placement-mode");
  applySocketHighlights();
  updateShortcutBar();
  updateLegendHighlight();
  showInstructionPanel("support");
  ghost = supportTemplate.clone(true);
  makeGhost(ghost);
  scene.add(ghost);

  // ── Create and position the green axis guide line ─────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
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
    // Refresh axis line after a bridge is placed (sockets consumed, new centroid)
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
  updateWheelButtonState();
  applySocketHighlights();
  updateShortcutBar();
}

/* =========================================================
   SUPPORT FRAME — HELPERS
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

/* =========================================================
   RESOLVE BEST SUPPORT SOCKET PAIR
   ========================================================= */

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

  // Find which triangle mount the clicked socket belongs to
  let clickedMount = clickedSocket.parent;
  while (clickedMount && !clickedMount.userData?.isMount)
    clickedMount = clickedMount.parent;
  if (!clickedMount || !mountMap.has(clickedMount)) return null;

  const rectFrameA = getParentRectFrame(clickedMount);

  // Find the closest socket PAIR across the two triangle mounts —
  // one socket from each mount — so the bridge connectors land on
  // real socket positions rather than averaged centroids.
  let bestSocketA = null,
    bestSocketB = null;
  let bestPosA = null,
    bestPosB = null;
  let bestDist = Infinity;

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

/* =========================================================
   SUPPORT BRIDGE ALIGNMENT VALIDATION
   ========================================================= */

function checkSupportBridgeAlignment(pair) {
  const { posA, posB } = pair;

  const horizDist = Math.hypot(posB.x - posA.x, posB.z - posA.z);
  if (horizDist < 0.2) {
    return {
      ok: false,
      reason:
        "The two Triangular Frame connectors are too close together to " +
        "place a Support Bridge between them.",
    };
  }

  return { ok: true };
}

/* =========================================================
   SUPPORT FRAME 2-POINT SNAP
   ========================================================= */

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
    const lWorld0 = new THREE.Vector3();
    const rWorld0 = new THREE.Vector3();
    connL.getWorldPosition(lWorld0);
    connR.getWorldPosition(rWorld0);

    const connSpanX = rWorld0.x - lWorld0.x;
    const connSpanZ = rWorld0.z - lWorld0.z;
    const targetSpanX = posB.x - posA.x;
    const targetSpanZ = posB.z - posA.z;

    const fromAngle = Math.atan2(connSpanX, connSpanZ);
    const toAngle = Math.atan2(targetSpanX, targetSpanZ);
    const baseYaw = toAngle - fromAngle;

    let bestYaw = baseYaw;
    let bestConnector = connL;
    let bestError = Infinity;
    let bestFacingScore = -Infinity;

    const localExtrusionDir = new THREE.Vector3(0, 0, 1);
    if (connectorRoot) {
      const tempBox = new THREE.Box3().setFromObject(connectorRoot);
      const wCenter = tempBox.getCenter(new THREE.Vector3());
      const lCenter = connectorRoot.worldToLocal(wCenter.clone());
      lCenter.y = 0;
      if (lCenter.lengthSq() > 0.0001) {
        localExtrusionDir.copy(lCenter).normalize();
      }
    }

    let triFrontWorld = new THREE.Vector3();
    if (sourceSocket) {
      let triMount = sourceSocket.parent;
      while (triMount && !triMount.userData?.isMount)
        triMount = triMount.parent;
      if (triMount) {
        const triBox = new THREE.Box3().setFromObject(triMount);
        const triCenter = triBox.getCenter(new THREE.Vector3());
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
        const sW = new THREE.Vector3();
        const oW = new THREE.Vector3();
        snap.getWorldPosition(sW);
        other.getWorldPosition(oW);
        const dx = posA.x - sW.x;
        const dz = posA.z - sW.z;
        const err = Math.hypot(oW.x + dx - posB.x, oW.z + dz - posB.z);

        let bridgeFrontWorld = new THREE.Vector3();
        if (connectorRoot) {
          const box = new THREE.Box3().setFromObject(connectorRoot);
          const center = box.getCenter(new THREE.Vector3());
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
        } else if (Math.abs(err - bestError) <= 0.001) {
          if (facingScore > bestFacingScore) {
            bestFacingScore = facingScore;
            bestYaw = yaw;
            bestConnector = snap;
          }
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

    const lW = new THREE.Vector3();
    const rW = new THREE.Vector3();
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

  if (placementMode === "frame") {
    // ── Check for support socket hover first ─────────────────────────────────
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

    if (frameHoverType === "support") {
      frameHoverType = "frame";
    }

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
    if (!frameHit) return;

    frameHoverType = "frame";
    const socket = frameHit.object.userData.socket;
    const { mountPos } = computeFrameSnapPosition(socket);
    ghost.position.copy(mountPos);
    ghost.rotation.set(0, 0, 0);
    return;
  }

  if (placementMode === "wheel") {
    const hit = raycaster.intersectObjects(wheelMarkers)[0];
    if (!hit) return;
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

    // Motor is auto-orient only — no manual rotation steps applied
    const finalYaw = motorAutoBaseYaw;

    ghost.position.copy(socketWorldPos);
    ghost.rotation.set(0, finalYaw, 0);
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
      if (ghost) ghost.position.set(0, -9999, 0);
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
      if (ghost) ghost.position.set(0, -9999, 0);
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

    if (supportFirstSocket) {
      let hoveredMount = rawSocket.parent;
      while (hoveredMount && !hoveredMount.userData?.isMount)
        hoveredMount = hoveredMount.parent;
      let firstMount = supportFirstSocket.parent;
      while (firstMount && !firstMount.userData?.isMount)
        firstMount = firstMount.parent;

      if (hoveredMount && firstMount && hoveredMount !== firstMount) {
        const posA = new THREE.Vector3();
        const posB = new THREE.Vector3();
        supportFirstSocket.getWorldPosition(posA);
        rawSocket.getWorldPosition(posB);

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
          supportFirstSocket,
        );
        return;
      }
    }

    const pos = new THREE.Vector3();
    rawSocket.getWorldPosition(pos);
    ghost.position.copy(pos);
    ghost.rotation.set(0, 0, 0);
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

  if (!hit) return;

  const socket = hit.object.userData.socket;
  socket.updateMatrixWorld(true);

  if (hit.object !== hoveredTriangleMarker) {
    const incomingUUID = socket.uuid;
    const isNewSocket = incomingUUID !== lastHoveredTriangleSocketUUID;

    hoveredTriangleMarker = hit.object;
    hoveredTriangleMarker.material = MAT_TRI_HOVER;
    hoveredTriangleMarker.scale.setScalar(2.0);
    lastHoveredTriangleSocketUUID = incomingUUID;

    if (isNewSocket) {
      triangleAutoBaseYaw = computeTriangleAutoYaw(socket);
    }
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
   CLICK HANDLER
   =========================================================
   CHANGE: Each placement branch now falls back to
   findNearestMarkerOnScreen() before exiting placement mode,
   so clicking slightly outside a socket marker still places
   the part rather than exiting the mode.
   ========================================================= */

function onClick(e) {
  if (isFinalized) return;

  updateMouse(e);
  raycaster.setFromCamera(mouse, camera);

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

    // ── proximity fallback for support markers ────────────────────────────────
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

    // ── Try direct raycast hit, then proximity fallback ───────────────────────
    let frameHitObj = raycaster.intersectObjects(frameMarkers)[0];
    if (!frameHitObj) {
      const nearest = findNearestMarkerOnScreen(frameMarkers);
      if (nearest) frameHitObj = { object: nearest };
    }

    // No marker anywhere near click — exit placement mode
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

    // ── Try direct raycast, then proximity fallback ───────────────────────────
    let hit = raycaster.intersectObjects(stressConnectorMarkers)[0];
    if (!hit) {
      const nearest = findNearestMarkerOnScreen(stressConnectorMarkers);
      if (nearest) hit = { object: nearest };
    }

    // Click on empty space → exit placement mode
    if (!hit) {
      clearGhost();
      return;
    }

    const rawSocket = hit.object.userData.socket;
    if (usedSockets.has(rawSocket.uuid)) return;

    // ── AUTO-RESOLVE: single click places the bridge automatically ───────────
    // resolveBestSupportSocketPair picks the best matching socket on the
    // opposing triangle frame based on outward normals, so it doesn't matter
    // which specific socket the user clicks — the result is always correct.
    const pair = resolveBestSupportSocketPair(rawSocket);

    if (!pair) {
      showHudMessage(
        "⚠ Could not find a matching socket on a second Triangle Frame",
      );
      return;
    }

    const { socketA, posA, socketB, posB } = pair;

    if (usedSockets.has(socketA.uuid) || usedSockets.has(socketB.uuid)) {
      showHudMessage("⚠ One of those sockets is already used");
      return;
    }

    // Guard: only one bridge per triangle pair
    let mountA = socketA.parent;
    while (mountA && !mountA.userData?.isMount) mountA = mountA.parent;
    let mountB = socketB.parent;
    while (mountB && !mountB.userData?.isMount) mountB = mountB.parent;

    const existingBridgeBetween = getAllMounts().some((m) => {
      if (m.userData.type !== "support_frame") return false;
      const sA = m.userData.socket;
      const sB = m.userData.socketB;
      if (!sA) return false;
      let mA = sA.parent;
      while (mA && !mA.userData?.isMount) mA = mA.parent;
      let mB = sB?.parent;
      while (mB && !mB.userData?.isMount) mB = mB.parent;
      return (
        (mA === mountA && mB === mountB) || (mA === mountB && mB === mountA)
      );
    });

    if (existingBridgeBetween) {
      showPopup(
        "A Support Bridge already connects these two Triangle Frames.\n\n" +
          "Only one bridge is allowed per triangle pair.",
      );
      return;
    }

    if (hoveredTriangleMarker) {
      hoveredTriangleMarker.material = MAT_TRI_ACTIVE;
      hoveredTriangleMarker.scale.setScalar(1.5);
      hoveredTriangleMarker = null;
    }

    placeSupportBridgeFromPair(
      socketA,
      posA,
      socketB,
      posB,
      supportManualRotSteps,
      socketA,
    );
    restartPlacementMode("support");
    checkQueuedIntent();
    return;
  }

  if (placementMode === "wheel") {
    // ── Try direct raycast, then proximity fallback ───────────────────────────
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

  if (placementMode === "motor") {
    // ── Try direct raycast, then proximity fallback ───────────────────────────
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

    // Motor is auto-orient only — place using autoBaseYaw, no manual steps
    placeMotor(socket, motorAutoBaseYaw, 0);

    rebuildSocketMarkers();
    updateWheelButtonState();
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

  if (placementMode === "triangle") {
    // ── Try direct raycast, then proximity fallback ───────────────────────────
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

function placeMotor(socket, autoBaseYaw = 0, manualSteps = 0) {
  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "motor" };

  socket.updateMatrixWorld(true);

  const socketPos = new THREE.Vector3();
  socket.getWorldPosition(socketPos);

  // Motor is auto-orient only — manualSteps is always 0 at call site
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
  // ── CURSOR: entering placement mode ──
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
  updateWheelButtonState();
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

  applyTwoPointSupportSnap(mount, support, posA, posB, manualSteps, socket);

  usedSockets.add(socket.uuid);
  if (socketB) usedSockets.add(socketB.uuid);
  addToInventory("support_frame");
  pushUndo(
    mount,
    socketB ? [socket.uuid, socketB.uuid] : [socket.uuid],
    "support_frame",
  );
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
      hoveredOrigEm = setMeshEmissive(hoveredMesh, 0x001a2e);
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
      setMeshEmissive(selectedMesh, 0x001a2e);
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
      selectedOrigEm = setMeshEmissive(selectedMesh, 0x3d0020);
    }
    if (selectedMesh?.material?.emissive) {
      selectedMesh.material.emissive.set(0x3d0020);
    }
  }
}

/* =========================================================
   UNDO
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
  const { mount, socketUuids, type } = entry;

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

  if (hoveredMotorMarker) hoveredMotorMarker = null;
  if (hoveredTriangleMarker) hoveredTriangleMarker = null;

  scene.remove(mount);
  removeFromInventory(type);

  redoStack.push(entry);

  rebuildSocketMarkers();
  updateWheelButtonState();
  applySocketHighlights();
  updateUndoRedoButtons();

  showHudMessage("UNDO ✓");
}

function performRedo() {
  if (redoStack.length === 0) {
    showHudMessage("NOTHING TO REDO");
    return;
  }

  const { mount, socketUuids, type } = redoStack.pop();

  scene.add(mount);
  socketUuids.forEach((uuid) => usedSockets.add(uuid));
  addToInventory(type);

  undoStack.push({ mount, socketUuids: [...socketUuids], type });

  rebuildSocketMarkers();
  updateWheelButtonState();
  applySocketHighlights();
  updateUndoRedoButtons();

  showHudMessage("REDO ✓");
}

/* =========================================================
   KEYBOARD HANDLER
   =========================================================
   CHANGE: ArrowLeft/Right no longer affect motor rotation.
   Motor is auto-orient only. Keys still work for frame,
   triangle, and support placement modes.
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
    if (placementMode) {
      clearGhost();
    } else if (selectedMount) {
      restoreMeshEmissive(selectedMesh, selectedOrigEm);
      selectedMesh = null;
      selectedMount = null;
    }
    return;
  }

  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    // ── CHANGE: motor mode intentionally excluded — motor auto-orients only ──
    if (!placementMode || placementMode === "motor") return;
    e.preventDefault();

    const dir = e.key === "ArrowRight" ? 1 : -1;
    flashArrowKey(e.key === "ArrowRight" ? "right" : "left");

    if (placementMode === "triangle" && ghost) {
      triangleManualRotSteps = (triangleManualRotSteps + 1) % 2;
      const totalDeg = triangleManualRotSteps * 180;
      showHudMessage(`Triangle manual offset: +${totalDeg}°`);
      updateShortcutBar();
      updateRotationDisplay();
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
          rawSocket,
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

  if ((e.key === "Delete" || e.key === "Backspace") && selectedMount) {
    const mountToDelete = selectedMount;

    const result = checkDeletionAllowed(mountToDelete);

    if (!result.ok) {
      showDependencyBlockedPopup(mountToDelete, result);
      return;
    }

    executeDelete(mountToDelete);
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
  // Idle arrows disabled — no prompt shown
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
   RIGHT-CLICK CONTEXT MENU
   ========================================================= */

const PART_GLYPHS = {
  frame: "▬",
  motor: "⬡",
  triangle_frame: "▲",
  support_frame: "╬",
  wheel: "◉",
};

let ctxMenuEl = null;
let ctxTargetMount = null;

function buildContextMenu(mount, screenX, screenY) {
  destroyContextMenu();

  ctxTargetMount = mount;

  const type = mount.userData.type ?? "frame";
  const label = PART_LABELS[type] ?? type.replace(/_/g, " ");
  const glyph = PART_GLYPHS[type] ?? "◈";
  const cost = PART_COSTS[type] ?? 0;

  const delResult = checkDeletionAllowed(mount);
  const depCount = delResult.ok ? 0 : delResult.dependents.length;

  const menu = document.createElement("div");
  menu.id = "ctx-menu";

  const header = document.createElement("div");
  header.className = "ctx-header";
  header.innerHTML = `
    <span class="ctx-header-glyph">${glyph}</span>
    <div>
      <div class="ctx-header-name">${label}</div>
      <div class="ctx-header-type">₹${cost.toLocaleString()} · ${type.replace(/_/g, " ")}</div>
    </div>`;
  menu.appendChild(header);

  const items = document.createElement("div");
  items.className = "ctx-items";

  items.appendChild(
    makeCtxItem({
      icon: "◎",
      label: "Focus Camera",
      hint: "Frame this part in view",
      kbd: null,
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

  const deleteItem = makeCtxItem({
    icon: "✕",
    label: depCount > 0 ? `Delete All (${depCount + 1} parts)` : "Delete Part",
    hint:
      depCount > 0
        ? `Will also remove ${depCount} dependent part${depCount !== 1 ? "s" : ""}`
        : "Remove from build",
    kbd: "Del",
    danger: true,
    onClick: () => {
      destroyContextMenu();
      if (depCount > 0) {
        showDependencyBlockedPopup(mount, delResult);
      } else {
        executeDelete(mount);
      }
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

  const mw = menu.offsetWidth || 220;
  const mh = menu.offsetHeight || 180;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let x = screenX + 4;
  let y = screenY + 4;
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

  item.innerHTML = `
    <span class="ctx-item-icon">${icon}</span>
    <span class="ctx-item-body">
      <span class="ctx-item-label">${label}</span>
      ${hint ? `<span class="ctx-item-hint">${hint}</span>` : ""}
    </span>
    ${kbd ? `<span class="ctx-item-kbd">${kbd}</span>` : ""}`;

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
  if (ctxMenuEl && !ctxMenuEl.contains(e.target)) {
    destroyContextMenu();
  }
}

function onCtxKeyDown(e) {
  if (e.key === "Escape") {
    destroyContextMenu();
  }
}

function onContextMenu(e) {
  e.preventDefault();

  if (placementMode || isFinalized) return;

  updateMouse(e);
  raycaster.setFromCamera(mouse, camera);

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
  usedSockets.delete(socket?.uuid);
  if (socketB) usedSockets.delete(socketB.uuid);

  for (const entry of undoStack) {
    if (entry.mount === mount) {
      entry.socketUuids.forEach((uuid) => usedSockets.delete(uuid));
    }
  }

  scene.remove(mount);
  removeFromInventory(type);
  rebuildSocketMarkers();
  updateWheelButtonState();
  applySocketHighlights();
  showHudMessage(`DELETED: ${(PART_LABELS[type] ?? type).toUpperCase()}`);
}

function duplicateFrame(sourceMount) {
  const frame = frameTemplate.clone(true);
  makeSolid(frame);

  const mount = new THREE.Group();
  mount.userData = { isMount: true, type: "frame" };

  mount.position.set(
    sourceMount.position.x + 1.2,
    sourceMount.position.y,
    sourceMount.position.z,
  );
  mount.rotation.copy(sourceMount.rotation);
  mount.add(frame);
  scene.add(mount);

  addToInventory("frame");
  pushUndo(mount, [], "frame");
  rebuildSocketMarkers();
  updateWheelButtonState();
  applySocketHighlights();
  frameObject(mount);
  showHudMessage("FRAME DUPLICATED ✓");
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

  // ── Pulse the support axis guide line opacity in the render loop ──────────
  // ─────────────────────────────────────────────────────────────────────────

  renderer.render(scene, camera);
}

/* =========================================================
   HOVER HIGHLIGHT + TOOLTIP
   ========================================================= */

function showTooltip(_m, _x, _y) {}

function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = "none";
}
