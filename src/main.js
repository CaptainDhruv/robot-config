/* =========================================================
   ROBOT CONFIGURATOR – MAIN.JS
   FULL RECONSTRUCTED VERSION
   (ALL FEATURES + HORIZONTAL PLACEMENT FIXES + FRAME-ON-SUPPORT)
   FIX v2: Single-mesh hover/selection — only the exact mesh
           under the cursor is highlighted, nothing else.
   UPDATE v3: Robotic fonts + Camera Angle Presets + Multi-angle Print
   UPDATE v5: Color legend + animated idle arrows
   FIX v6: Frame placement — correctly extends outward from sockets
            instead of overlapping. Ghost preview matches final position.
   ========================================================= */

import * as THREE from "three";
import { scene } from "./core/scene.js";
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
      background: "rgba(8,12,6,0.96)",
      border: "1.5px solid #6ab040",
      color: "#a0d878",
      fontFamily: "'Share Tech Mono', monospace",
      fontSize: "11px",
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      padding: "10px 22px 10px 16px",
      clipPath: "polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,0 100%)",
      zIndex: "99997",
      boxShadow: "0 0 20px rgba(106,176,64,0.25)",
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
      `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin:0 2px;background:${i < countPlaced(queuedIntent.requiredType) ? "#6ab040" : "#2a3820"};box-shadow:${i < countPlaced(queuedIntent.requiredType) ? "0 0 5px #6ab040" : "none"}"></span>`,
  ).join("");

  el.innerHTML =
    `<span style="color:#6ab040;font-size:13px">⟳</span>` +
    `<span>QUEUED: <strong style="color:#d8e4b8">${queuedIntent.label}</strong></span>` +
    `<span style="color:#4a5c38">·</span>` +
    `<span>Place <strong style="color:#f0b040">${needed}</strong> more ${queuedIntent.requiredType.replace("_", " ")}${needed !== 1 ? "s" : ""}</span>` +
    `<span style="margin-left:4px">${dots}</span>` +
    `<button id="chain-cancel" style="margin-left:10px;background:none;border:1px solid #4a5c38;color:#4a5c38;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.1em;padding:2px 8px;cursor:pointer;transition:all 0.15s" onmouseover="this.style.color='#ff6060';this.style.borderColor='#ff6060'" onmouseout="this.style.color='#4a5c38';this.style.borderColor='#4a5c38'">✕ CANCEL</button>`;

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
    color: "#4a8cd4",
    steps: [
      {
        label: "LOCATE SOCKET",
        text: "Look for <strong style='color:#ff2200'>red glowing dots</strong> on your rectangular frame — these are the SOCKET_FRAME attachment points where motors can be mounted.",
      },
      {
        label: "HOVER",
        text: "Move your cursor over any red socket dot. The ghost preview of the motor will snap to that socket automatically.",
      },
      {
        label: "ROTATE (OPTIONAL)",
        text: "Press <kbd>R</kbd> to rotate the motor 90° before placing. Each press rotates it another quarter turn.",
      },
      {
        label: "CLICK TO PLACE",
        text: "Click on the socket to confirm placement. The motor will lock into position. Repeat for additional motors.",
      },
    ],
    tip: "Motors require a Rectangular Frame to be placed first. Each frame socket accepts one motor.",
  },
  frame: {
    icon: "▭",
    title: "RECTANGULAR FRAME",
    color: "#c84030",
    steps: [
      {
        label: "LOCATE SOCKET",
        text: "Green glowing dots appear on existing frames — these are SOCKET_FRAME connection points where new frames can extend the structure.",
      },
      {
        label: "HOVER",
        text: "Move your cursor over any <strong style='color:#00ff44'>green socket dot</strong>. The frame ghost will preview its position snapped to that point.",
      },
      {
        label: "CLICK TO PLACE",
        text: "Click the socket dot to place the frame. It will align automatically, connecting its opposite socket to the one you clicked.",
      },
      {
        label: "EXTEND",
        text: "Continue adding frames to build larger structures. Each placed frame exposes new sockets for further expansion.",
      },
    ],
    tip: "The base frame is always placed at startup. Additional frames connect at SOCKET_FRAME_A/B/C/D points on existing frames.",
  },
  triangle: {
    icon: "△",
    title: "TRIANGULAR FRAME",
    color: "#d48030",
    steps: [
      {
        label: "LOCATE SOCKET",
        text: "Look for <strong style='color:#44ddff'>cyan/teal glowing dots</strong> — these are SOCKET_TRIANGLE connection points on your rectangular frames.",
      },
      {
        label: "HOVER",
        text: "Move your cursor over any teal socket dot. A ghost triangular frame will preview at that position.",
      },
      {
        label: "ROTATE (OPTIONAL)",
        text: "Press <kbd>R</kbd> to rotate the triangle 90° for different orientations. Use this to align it correctly with your structure.",
      },
      {
        label: "CLICK TO PLACE",
        text: "Click the socket dot to place the triangle. It snaps via its SOCKET_FRAME_CONNECTOR point. Place at least 2 triangles before adding Support Frames.",
      },
    ],
    tip: "Triangular frames are structural braces. You need at least 2 placed before you can add a Support Frame.",
  },
  support: {
    icon: "⊞",
    title: "SUPPORT FRAME",
    color: "#6ab040",
    steps: [
      {
        label: "PREREQUISITE",
        text: "You need <strong>at least 2 Triangular Frames</strong> placed before adding a Support Frame. Check your requisition panel to confirm.",
      },
      {
        label: "FIRST CLICK",
        text: "Click any <strong style='color:#44ddff'>teal socket dot</strong> on one of your triangular frames — this sets the first anchor point of the support bridge.",
      },
      {
        label: "SECOND CLICK",
        text: "Click a <strong style='color:#44ddff'>teal socket dot</strong> on a second triangular frame. The support frame will automatically bridge between the two selected points.",
      },
      {
        label: "AUTO-ALIGN",
        text: "The support frame calculates the optimal rotation and position to span between both anchor sockets. No manual rotation needed.",
      },
    ],
    tip: "Support frames bridge two triangular frames. The system finds the best angle automatically. Use SOCKET_STRESS_CONNECTOR sockets on triangles for best results.",
  },
  frameOnSupport: {
    icon: "⇅",
    title: "ATTACH TO SUPPORT",
    color: "#9060c8",
    steps: [
      {
        label: "PREREQUISITE",
        text: "You need <strong>at least 2 Support Frames</strong> placed before attaching a rectangular frame to them.",
      },
      {
        label: "LOCATE SOCKET",
        text: "Look for <strong style='color:#cc44ff'>purple glowing dots</strong> — these are SOCKET_FRAME_SUPPORT points on your support frames.",
      },
      {
        label: "HOVER TO PREVIEW",
        text: "Move your cursor over any <strong style='color:#cc44ff'>purple socket dot</strong>. A ghost frame previews its exact placement position.",
      },
      {
        label: "ROTATE (OPTIONAL)",
        text: "Press <kbd>R</kbd> to rotate the frame in 90° increments. The HUD shows current rotation angle. Adjust until the frame aligns correctly.",
      },
      {
        label: "CLICK TO PLACE",
        text: "Click the purple socket dot to confirm. The frame snaps its SOCKET_FRAME_SUPPORT connector to that socket and auto-aligns to span both support frames.",
      },
    ],
    tip: "Press R multiple times to try all 4 rotation angles (0°, 90°, 180°, 270°) and find the best fit between your support frames.",
  },
  wheel: {
    icon: "◎",
    title: "ADD WHEEL",
    color: "#00bcd4",
    steps: [
      {
        label: "PREREQUISITE",
        text: "You need at least <strong>1 Motor Housing</strong> placed on your frame before wheels can be attached.",
      },
      {
        label: "LOCATE SOCKET",
        text: "Look for <strong style='color:#ff9900'>orange glowing dots</strong> — these are WHEEL_SOCKET points on your placed motor housings.",
      },
      {
        label: "HOVER TO PREVIEW",
        text: "Move your cursor over any <strong style='color:#ff9900'>orange socket dot</strong>. The wheel ghost will snap and preview its mounted position.",
      },
      {
        label: "CLICK TO PLACE",
        text: "Click the orange socket dot to snap the wheel into place. It aligns automatically using the MOTOR_CONNECTOR point. Each socket accepts one wheel.",
      },
    ],
    tip: "Each motor housing has multiple WHEEL_SOCKET points. Once a socket is used it disappears. Wheels cannot be moved after placement — delete and re-place if needed.",
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

  html += `<div class="inst-esc-hint">Press <kbd>Esc</kbd> to cancel placement</div>`;

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

let supportFirstSocket = null;
let frameOnSupportFirstSocket = null;

/* =========================================================
   PLACEMENT TUNING OFFSETS
   ========================================================= */

const FRAME_ON_SUPPORT_Y_OFFSET = -0.1;
const TRIANGLE_FRAME_Y_OFFSET = -0.01;

/* =========================================================
   RAYCAST
   ========================================================= */

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

/* =========================================================
   SOCKET MARKERS
   ========================================================= */

const socketGeo = new THREE.SphereGeometry(0.04, 12, 12);
const frameMat = new THREE.MeshBasicMaterial({ color: 0x00aa00 });
const motorMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
const supportFrameSocketMat = new THREE.MeshBasicMaterial({ color: 0xaa00ff });
const wheelSocketMat = new THREE.MeshBasicMaterial({ color: 0xff8800 });

let frameMarkers = [];
let motorMarkers = [];
let triangleMarkers = [];
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
   FRAME SOCKET HELPERS
   =========================================================
   computeFrameSnapPosition() is the SINGLE source of truth
   for where a new rectangular frame mount should be placed
   when the user clicks/hovers a SOCKET_FRAME marker.

   Strategy (works regardless of GLB internal structure):
   1. Clone the frame template into a temporary off-screen group
      at position (0,0,0) with no rotation.
   2. Force a world-matrix update so all child sockets have
      correct world positions.
   3. Collect all SOCKET_FRAME_X sockets from the clone
      (excluding SOCKET_FRAME_SUPPORT).
   4. The clicked socket is at a known world position (socketWorldPos).
      We want the new frame positioned so that one of ITS sockets
      lands exactly at socketWorldPos.
      - Preferred: use the socket whose name suffix is the
        OPPOSITE of the clicked socket (A↔C, B↔D).
      - Fallback: use whichever socket is geometrically farthest
        from the frame centroid (most likely to be on the far edge).
   5. mountPos = socketWorldPos − snapSocketLocalOffset
      This makes (mountPos + snapSocketLocalOffset) == socketWorldPos.
   6. Remove the temp clone from the scene.

   Returns { mountPos: THREE.Vector3 }
   ========================================================= */

const OPPOSITE_SOCKET_SUFFIX = { A: "C", B: "D", C: "A", D: "B" };

function computeFrameSnapPosition(clickedSocket) {
  scene.updateMatrixWorld(true);
  clickedSocket.updateMatrixWorld(true);

  const socketWorldPos = new THREE.Vector3();
  clickedSocket.getWorldPosition(socketWorldPos);

  // --- 1. Spawn a temporary clone at world origin to read socket offsets ---
  const tempGroup = new THREE.Group();
  tempGroup.position.set(0, 0, 0);
  tempGroup.rotation.set(0, 0, 0);
  tempGroup.scale.set(1, 1, 1);

  const tempFrame = frameTemplate.clone(true);
  tempFrame.position.set(0, 0, 0);
  tempFrame.rotation.set(0, 0, 0);
  tempFrame.scale.set(1, 1, 1);
  tempGroup.add(tempFrame);

  // Add to scene briefly so updateMatrixWorld() works correctly
  scene.add(tempGroup);
  scene.updateMatrixWorld(true);

  // --- 2. Collect all SOCKET_FRAME sockets from the clone ---
  const clickedSuffix = clickedSocket.name
    .replace(/^SOCKET_FRAME_/i, "")
    .toUpperCase();
  const preferredSuffix = OPPOSITE_SOCKET_SUFFIX[clickedSuffix] ?? null;

  const sockets = []; // { name, suffix, worldPos, localOffset }
  tempGroup.traverse((o) => {
    if (!o.name) return;
    if (!o.name.startsWith("SOCKET_FRAME")) return;
    if (o.name.startsWith("SOCKET_FRAME_SUPPORT")) return;

    const suffix = o.name.replace(/^SOCKET_FRAME_/i, "").toUpperCase();
    o.updateMatrixWorld(true);
    const wp = new THREE.Vector3();
    o.getWorldPosition(wp);
    // Since tempGroup is at world origin, world pos == local offset
    sockets.push({ name: o.name, suffix, localOffset: wp.clone() });
  });

  // --- 3. Remove temp clone ---
  scene.remove(tempGroup);

  // --- 4. Pick the best snap socket ---
  let snapSocket = null;

  // First try: opposite suffix
  if (preferredSuffix) {
    snapSocket = sockets.find((s) => s.suffix === preferredSuffix) ?? null;
  }

  // Fallback: pick the socket with greatest distance from frame centroid
  // (i.e. the one most "outward" on the opposite side)
  if (!snapSocket && sockets.length > 0) {
    // Compute centroid of all sockets
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

  if (!snapSocket) {
    // Ultimate fallback: place at socket world position
    return {
      mountPos: new THREE.Vector3(
        socketWorldPos.x,
        baseFrameYLevel,
        socketWorldPos.z,
      ),
    };
  }

  // --- 5. Compute mount position ---
  // mountPos + snapSocket.localOffset = socketWorldPos
  // → mountPos = socketWorldPos - snapSocket.localOffset
  const mountPos = new THREE.Vector3(
    socketWorldPos.x - snapSocket.localOffset.x,
    baseFrameYLevel,
    socketWorldPos.z - snapSocket.localOffset.z,
  );

  return { mountPos };
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
  renderer.setClearColor(0x0a0d08, 1);

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
  scene.background = new THREE.Color(0x0a0d08);
  scene.fog = new THREE.FogExp2(0x0a0d08, 0.042);

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

  const gridMajor = new THREE.GridHelper(60, 60, 0x1e3018, 0x162410);
  gridMajor.position.y = gridY;
  gridMajor.material.transparent = true;
  gridMajor.material.opacity = 0.65;
  scene.add(gridMajor);

  const gridMinor = new THREE.GridHelper(60, 240, 0x0e1a0a, 0x0e1a0a);
  gridMinor.position.y = gridY - 0.001;
  gridMinor.material.transparent = true;
  gridMinor.material.opacity = 0.4;
  scene.add(gridMinor);

  const groundGeo = new THREE.PlaneGeometry(60, 60);
  const groundMat = new THREE.MeshBasicMaterial({
    color: 0x080c06,
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
  bind(
    "addFrameToSupport",
    () => !isFinalized && startFrameOnSupportPlacement(),
  );
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
    background: "rgba(10,13,8,0.93)",
    border: "1px solid #d4922a",
    color: "#f0b040",
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: "12px",
    letterSpacing: "0.08em",
    padding: "8px 14px",
    clipPath: "polygon(0 0,calc(100% - 7px) 0,100% 7px,100% 100%,0 100%)",
    boxShadow: "0 0 14px rgba(212,146,42,0.25)",
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

    const mainShot = screenshots["perspective"];
    const otherAngles = [
      "front",
      "back",
      "top",
      "bottom",
      "left",
      "right",
      "iso",
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
    .status-draft  { color: #92400e; border-color: #b45309; background: #fffbeb; }
    .main-view-wrap { width: 100%; border: 2px solid #222; margin-bottom: 14px; background: #0a0d08; overflow: hidden; position: relative; }
    .main-view-wrap img { width: 100%; display: block; max-height: 320px; object-fit: contain; }
    .main-view-label { position: absolute; top: 8px; left: 12px; font-family: 'Orbitron', sans-serif; font-size: 9px; font-weight: 700; letter-spacing: 0.2em; color: #d4922a; background: rgba(0,0,0,0.65); padding: 3px 8px; }
    .section-title { font-family: 'Orbitron', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.2em; color: #111; text-transform: uppercase; border-left: 4px solid #d4922a; padding-left: 10px; margin-bottom: 10px; }
    .angles-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 18px; }
    .angle-card { border: 1.5px solid #222; background: #0a0d08; overflow: hidden; position: relative; }
    .angle-label { font-family: 'Orbitron', sans-serif; font-size: 7px; font-weight: 700; letter-spacing: 0.18em; color: #d4922a; background: rgba(0,0,0,0.75); padding: 3px 6px; position: absolute; top: 0; left: 0; z-index: 1; }
    .angle-card img { width: 100%; display: block; max-height: 130px; object-fit: contain; }
    .tables-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .table-card { border: 1.5px solid #222; }
    .table-card-header { background: #1a1a1a; color: #d4922a; font-family: 'Orbitron', sans-serif; font-size: 9px; font-weight: 700; letter-spacing: 0.18em; padding: 6px 12px; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    td { padding: 6px 12px; border-bottom: 1px solid #e5e5e5; font-family: 'Rajdhani', sans-serif; letter-spacing: 0.03em; }
    td:last-child { text-align: right; font-family: 'Share Tech Mono', monospace; font-weight: 700; }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) td { background: #fafafa; }
    .total-bar { display: flex; justify-content: space-between; align-items: center; border: 2px solid #1a1a1a; padding: 10px 20px; margin-bottom: 16px; background: #f8f8f0; }
    .total-label { font-family: 'Orbitron', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.1em; color: #111; }
    .total-value { font-family: 'Orbitron', sans-serif; font-size: 22px; font-weight: 900; color: #b45309; letter-spacing: 0.06em; }
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
    <div class="main-view-label">◈ PERSPECTIVE VIEW</div>
    <img src="${mainShot}" alt="Perspective View"/>
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
    { key: "ESC", action: "Cancel" },
    { key: "CTRL+Z", action: "Undo" },
  ],
  motor: [
    { key: "CLICK", action: "Place motor" },
    { key: "R", action: "Rotate 90°" },
    { key: "ESC", action: "Cancel" },
  ],
  triangle: [
    { key: "CLICK", action: "Place triangle" },
    { key: "R", action: "Rotate 90°" },
    { key: "ESC", action: "Cancel" },
  ],
  support: [
    { key: "CLICK ×1", action: "Set anchor A" },
    { key: "CLICK ×2", action: "Set anchor B & place" },
    { key: "ESC", action: "Cancel" },
  ],
  frameOnSupport: [
    { key: "CLICK", action: "Place frame" },
    { key: "R", action: `Rotate (${0}°)` },
    { key: "ESC", action: "Cancel" },
  ],
  wheel: [
    { key: "CLICK", action: "Snap wheel" },
    { key: "ESC", action: "Cancel" },
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
    background: "rgba(8,12,6,0.94)",
    borderTop: "1px solid rgba(212,146,42,0.2)",
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
      .sb-sep { width:1px; height:16px; background:rgba(212,146,42,0.15); flex-shrink:0; margin:0; }
      .sb-item { display:flex; align-items:center; gap:6px; padding:0 14px; height:100%; animation:sbItemIn 0.18s ease both; cursor:default; flex-shrink:0; transition: background 0.15s; }
      .sb-item:hover { background:rgba(212,146,42,0.06); }
      .sb-key { font-family:'Orbitron',sans-serif; font-size:9px; font-weight:700; letter-spacing:0.08em; color:#d4922a; background:rgba(212,146,42,0.12); border:1px solid rgba(212,146,42,0.3); padding:2px 6px; white-space:nowrap; line-height:1.4; }
      .sb-action { font-family:'Share Tech Mono',monospace; font-size:9.5px; letter-spacing:0.06em; color:#6a7e54; text-transform:uppercase; white-space:nowrap; }
      .sb-mode-label { font-family:'Orbitron',sans-serif; font-size:8px; font-weight:700; letter-spacing:0.18em; padding:0 16px; text-transform:uppercase; flex-shrink:0; white-space:nowrap; }
      .sb-chain-label { font-family:'Share Tech Mono',monospace; font-size:9px; letter-spacing:0.1em; color:#6ab040; padding:0 12px; flex-shrink:0; white-space:nowrap; display:flex; align-items:center; gap:6px; }
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
    idle: { color: "#4a5c38", label: "BROWSE" },
    frame: { color: "#c84030", label: "FRAME" },
    motor: { color: "#4a8cd4", label: "MOTOR" },
    triangle: { color: "#d48030", label: "TRIANGLE" },
    support: { color: "#6ab040", label: "SUPPORT" },
    frameOnSupport: { color: "#9060c8", label: "ATTACH" },
    wheel: { color: "#00bcd4", label: "WHEEL" },
  };

  const mc = modeColors[mode] || modeColors.idle;
  const modeLabel = document.createElement("div");
  modeLabel.className = "sb-mode-label";
  modeLabel.style.color = mc.color;
  modeLabel.style.borderRight = `1px solid rgba(212,146,42,0.15)`;
  modeLabel.textContent = mc.label;
  shortcutBarEl.appendChild(modeLabel);

  if (queuedIntent) {
    const chainEl = document.createElement("div");
    chainEl.className = "sb-chain-label";
    const placed = countPlaced(queuedIntent.requiredType);
    const need = queuedIntent.requiredCount - placed;
    chainEl.innerHTML =
      `<span style="color:#6ab040">⟳</span>` +
      `<span>QUEUED: ${queuedIntent.label} — ${need} more needed</span>`;
    chainEl.style.borderRight = "1px solid rgba(212,146,42,0.15)";
    shortcutBarEl.appendChild(chainEl);
  }

  const defs = SHORTCUT_DEFS[mode] || SHORTCUT_DEFS.idle;

  const patchedDefs = defs.map((d) => {
    if (mode === "frameOnSupport" && d.key === "R") {
      return {
        key: "R",
        action: `Rotate (${(frameOnSupportRotationSteps % 4) * 90}°)`,
      };
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
    background: "rgba(10,13,8,0.92)",
    border: "1px solid #d4922a",
    color: "#f0b040",
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: "12px",
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    padding: "10px 28px",
    clipPath: "polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,0 100%)",
    zIndex: "99999",
    boxShadow: "0 0 18px rgba(212,146,42,0.3)",
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
    background: "rgba(0,0,0,0.65)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "999999",
  });

  const box = document.createElement("div");
  Object.assign(box.style, {
    background: "#0d1209",
    border: "2px solid #d4922a",
    padding: "32px 40px",
    maxWidth: "460px",
    width: "90%",
    fontFamily: "'Share Tech Mono', monospace",
    color: "#f0b040",
    textAlign: "center",
    clipPath: "polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%)",
    boxShadow: "0 0 40px rgba(212,146,42,0.25)",
    position: "relative",
  });

  const title = document.createElement("div");
  title.textContent = "⚠  BUILD RULE VIOLATION";
  Object.assign(title.style, {
    fontSize: "10px",
    letterSpacing: "0.2em",
    color: "#d4922a",
    marginBottom: "16px",
    fontWeight: "700",
    fontFamily: "'Orbitron', sans-serif",
  });

  const msg = document.createElement("div");
  msg.textContent = message;
  Object.assign(msg.style, {
    fontSize: "13px",
    lineHeight: "1.6",
    color: "#e8d5a0",
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
      background: primary ? "#d4922a" : "transparent",
      border: "1.5px solid #d4922a",
      color: primary ? "#0d1209" : "#d4922a",
      fontFamily: "'Orbitron', sans-serif",
      fontSize: "10px",
      letterSpacing: "0.2em",
      padding: "8px 22px",
      cursor: "pointer",
      textTransform: "uppercase",
      transition: "background 0.15s, color 0.15s",
    });
    b.onmouseover = () => {
      b.style.background = "#d4922a";
      b.style.color = "#0d1209";
    };
    b.onmouseout = () => {
      b.style.background = primary ? "#d4922a" : "transparent";
      b.style.color = primary ? "#0d1209" : "#d4922a";
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
      color: "#7a6a40",
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
      o.material.opacity = 0.35;
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
  supportFirstSocket = null;
  frameOnSupportFirstSocket = null;
  frameOnSupportRotationSteps = 0;

  setHoverMesh(null, null);
  hideTooltip();

  frameOnSupportMarkers.forEach((m) => {
    m.material = supportFrameSocketMat;
  });

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
    ...triangleMarkers,
    ...frameOnSupportMarkers,
    ...wheelMarkers,
  ].forEach((m) => scene.remove(m));

  frameMarkers = [];
  motorMarkers = [];
  triangleMarkers = [];
  frameOnSupportMarkers = [];
  wheelMarkers = [];

  scene.updateMatrixWorld(true);

  scene.traverse((o) => {
    if (!o.name || usedSockets.has(o.uuid)) return;

    if (o.name.startsWith("SOCKET_FRAME_SUPPORT")) {
      addMarker(o, frameOnSupportMarkers, supportFrameSocketMat);
      return;
    }

    if (o.name.startsWith("SOCKET_FRAME")) addMarker(o, frameMarkers, frameMat);
    if (o.name.startsWith("SOCKET_MOTOR")) addMarker(o, motorMarkers, motorMat);
    if (o.name.startsWith("WHEEL_SOCKET"))
      addMarker(o, wheelMarkers, wheelSocketMat);

    if (
      o.name.startsWith("SOCKET_TRIANGLE") ||
      o.name.startsWith("SOCKET_STRESS_CONNECTOR")
    )
      addMarker(o, triangleMarkers, frameMat);
  });
}

const MAT_FRAME_ACTIVE = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
const MAT_FRAME_DIM = new THREE.MeshBasicMaterial({
  color: 0x004411,
  transparent: true,
  opacity: 0.18,
});
const MAT_MOTOR_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xff2200 });
const MAT_MOTOR_DIM = new THREE.MeshBasicMaterial({
  color: 0x330a00,
  transparent: true,
  opacity: 0.18,
});
const MAT_SUPPORT_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xcc44ff });
const MAT_SUPPORT_DIM = new THREE.MeshBasicMaterial({
  color: 0x220033,
  transparent: true,
  opacity: 0.18,
});
const MAT_WHEEL_ACTIVE = new THREE.MeshBasicMaterial({ color: 0xff9900 });
const MAT_WHEEL_DIM = new THREE.MeshBasicMaterial({
  color: 0x331f00,
  transparent: true,
  opacity: 0.18,
});
const MAT_TRI_ACTIVE = new THREE.MeshBasicMaterial({ color: 0x44ddff });
const MAT_TRI_DIM = new THREE.MeshBasicMaterial({
  color: 0x001f33,
  transparent: true,
  opacity: 0.18,
});

function addMarker(socket, list, mat) {
  const m = new THREE.Mesh(socketGeo, mat);
  socket.getWorldPosition(m.position);
  m.userData.socket = socket;
  list.push(m);
  scene.add(m);
}

function applySocketHighlights() {
  const mode = placementMode;

  const frameActive = mode === "frame";
  frameMarkers.forEach((m) => {
    m.material = frameActive ? MAT_FRAME_ACTIVE : MAT_FRAME_DIM;
    m.scale.setScalar(frameActive ? 1.5 : 0.7);
    m.visible = true;
  });

  const motorActive = mode === "motor";
  motorMarkers.forEach((m) => {
    m.material = motorActive ? MAT_MOTOR_ACTIVE : MAT_MOTOR_DIM;
    m.scale.setScalar(motorActive ? 1.5 : 0.7);
    m.visible = true;
  });

  const triActive = mode === "triangle" || mode === "support";
  triangleMarkers.forEach((m) => {
    m.material = triActive ? MAT_TRI_ACTIVE : MAT_TRI_DIM;
    m.scale.setScalar(triActive ? 1.5 : 0.7);
    m.visible = true;
  });

  const supportActive = mode === "frameOnSupport";
  frameOnSupportMarkers.forEach((m) => {
    m.material = supportActive ? MAT_SUPPORT_ACTIVE : MAT_SUPPORT_DIM;
    m.scale.setScalar(supportActive ? 1.6 : 0.7);
    m.visible = true;
  });

  const wheelActive = mode === "wheel";
  wheelMarkers.forEach((m) => {
    m.material = wheelActive ? MAT_WHEEL_ACTIVE : MAT_WHEEL_DIM;
    m.scale.setScalar(wheelActive ? 1.5 : 0.7);
    m.visible = true;
  });

  if (!mode) {
    frameMarkers.forEach((m) => {
      m.material = MAT_FRAME_DIM;
      m.scale.setScalar(0.7);
    });
    motorMarkers.forEach((m) => {
      m.material = MAT_MOTOR_DIM;
      m.scale.setScalar(0.7);
    });
    triangleMarkers.forEach((m) => {
      m.material = MAT_TRI_DIM;
      m.scale.setScalar(0.7);
    });
    frameOnSupportMarkers.forEach((m) => {
      m.material = MAT_SUPPORT_DIM;
      m.scale.setScalar(0.7);
    });
    wheelMarkers.forEach((m) => {
      m.material = MAT_WHEEL_DIM;
      m.scale.setScalar(0.7);
    });
  }
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
  const _ab = document.getElementById("addFrame");
  if (_ab) _ab.classList.add("active-mode");
  clearGhost();
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
   FRAME-ON-SUPPORT PLACEMENT MODE
   ========================================================= */

let frameOnSupportRotationSteps = 0;

function startFrameOnSupportPlacement() {
  hideIdleArrows();
  clearTimeout(idleTimer);
  if (countPlaced("support_frame") < 1) {
    setQueuedIntent({
      mode: "frameOnSupport",
      label: "Attach to Support",
      requiredType: "support_frame",
      requiredCount: 2,
      intendedFn: startFrameOnSupportPlacement,
    });
    showHudMessage("Need 2 Support Frames → starting prerequisites");
    startSupportPlacement();
    return;
  }
  if (countPlaced("support_frame") < 2) {
    setQueuedIntent({
      mode: "frameOnSupport",
      label: "Attach to Support",
      requiredType: "support_frame",
      requiredCount: 2,
      intendedFn: startFrameOnSupportPlacement,
    });
    showHudMessage("Place 1 more Support Frame → Attach auto-activates");
    startSupportPlacement();
    return;
  }
  document
    .querySelectorAll(".btn.active-mode")
    .forEach((b) => b.classList.remove("active-mode"));
  const _ab = document.getElementById("addFrameToSupport");
  if (_ab) _ab.classList.add("active-mode");
  clearGhost();
  frameOnSupportRotationSteps = 0;
  placementMode = "frameOnSupport";
  applySocketHighlights();
  updateShortcutBar();
  updateLegendHighlight();
  showInstructionPanel("frameOnSupport");
  ghost = frameTemplate.clone(true);
  makeGhost(ghost);
  scene.add(ghost);
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

  if (placementMode === "frameOnSupport") {
    const hit = raycaster.intersectObjects(frameOnSupportMarkers)[0];
    if (!hit) return;
    const socket = hit.object.userData.socket;
    socket.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    socket.getWorldPosition(pos);
    ghost.position.set(pos.x, pos.y + FRAME_ON_SUPPORT_Y_OFFSET, pos.z);
    ghost.rotation.set(0, frameOnSupportRotationSteps * (Math.PI / 2), 0);
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

  // ── FRAME GHOST PREVIEW ──────────────────────────────────────────────────
  if (placementMode === "frame") {
    if (frameMarkers.length === 0) {
      // No sockets yet — follow ground plane
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

    const hit = raycaster.intersectObjects(frameMarkers)[0];
    if (!hit) return;
    const socket = hit.object.userData.socket;

    // Use the same function as placement so ghost exactly matches final position
    const { mountPos } = computeFrameSnapPosition(socket);
    ghost.position.copy(mountPos);
    ghost.rotation.set(0, 0, 0);
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  const targets = placementMode === "motor" ? motorMarkers : triangleMarkers; // triangle / support

  const hit = raycaster.intersectObjects(targets)[0];
  if (!hit) return;

  const socket = hit.object.userData.socket;
  socket.updateMatrixWorld(true);

  const rot = ghost.quaternion.clone();
  ghost.matrix.copy(socket.matrixWorld);
  ghost.matrix.decompose(ghost.position, ghost.quaternion, ghost.scale);
  ghost.quaternion.multiply(rot);

  if (placementMode === "motor") applySocketDepth(ghost, socket, 0.05);
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

  if (placementMode === "frameOnSupport") {
    const hit = raycaster.intersectObjects(frameOnSupportMarkers)[0];
    if (!hit) return;
    const socket = hit.object.userData.socket;
    placeFrameOnSupport(socket, frameOnSupportRotationSteps);
    clearGhost();
    rebuildSocketMarkers();
    applySocketHighlights();
    checkQueuedIntent();
    return;
  }

  if (placementMode === "support") {
    const hit = raycaster.intersectObjects(triangleMarkers)[0];
    if (!hit) return;

    const socket = hit.object.userData.socket;

    if (!supportFirstSocket) {
      supportFirstSocket = socket;
      showHudMessage("First anchor set — now click a second triangle socket");
      return;
    }

    if (supportFirstSocket !== socket) {
      placeSupportBridge(supportFirstSocket, socket);
      clearGhost();
      rebuildSocketMarkers();
      applySocketHighlights();
      checkQueuedIntent();
      return;
    }
  }

  if (placementMode === "wheel") {
    const hit = raycaster.intersectObjects(wheelMarkers)[0];
    if (!hit) return;
    const socket = hit.object.userData.socket;
    if (usedSockets.has(socket.uuid)) return;
    placeWheel(socket);
    clearGhost();
    rebuildSocketMarkers();
    applySocketHighlights();
    checkQueuedIntent();
    return;
  }

  if (placementMode === "frame") {
    if (frameMarkers.length === 0) {
      placeFrameAtPosition(ghost.position.x, ghost.position.z);
      clearGhost();
      rebuildSocketMarkers();
      applySocketHighlights();
      checkQueuedIntent();
      return;
    }

    const hit = raycaster.intersectObjects(frameMarkers)[0];
    if (!hit) return;
    const socket = hit.object.userData.socket;
    if (usedSockets.has(socket.uuid)) return;
    placeFrame(socket);
    clearGhost();
    rebuildSocketMarkers();
    applySocketHighlights();
    checkQueuedIntent();
    return;
  }

  if (placementMode === "motor") {
    const hit = raycaster.intersectObjects(motorMarkers)[0];
    if (!hit) return;
    const socket = hit.object.userData.socket;
    if (usedSockets.has(socket.uuid)) return;
    placeMotor(socket);
    clearGhost();
    rebuildSocketMarkers();
    applySocketHighlights();
    checkQueuedIntent();
    return;
  }

  if (placementMode === "triangle") {
    const hit = raycaster.intersectObjects(triangleMarkers)[0];
    if (!hit) return;
    const socket = hit.object.userData.socket;
    if (usedSockets.has(socket.uuid)) return;
    placeTriangle(socket);
    clearGhost();
    rebuildSocketMarkers();
    applySocketHighlights();
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

/* =========================================================
   PLACE FRAME — FIXED
   =========================================================
   Uses computeFrameSnapPosition() so the new frame's
   opposite socket aligns exactly to the clicked socket,
   extending the structure outward with no overlap.
   ========================================================= */
function placeFrame(socket) {
  if (usedSockets.has(socket.uuid)) return;

  const { mountPos } = computeFrameSnapPosition(socket);

  const frame = frameTemplate.clone(true);
  makeSolid(frame);

  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "frame" };
  mount.rotation.set(0, 0, 0);
  mount.position.copy(mountPos);
  mount.add(frame);
  scene.add(mount);

  // Force matrix update so new frame's sockets are correct for next rebuild
  scene.updateMatrixWorld(true);

  usedSockets.add(socket.uuid);
  addToInventory("frame");
  pushUndo(mount, [socket.uuid], "frame");
}

function placeMotor(socket) {
  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "motor" };

  socket.updateMatrixWorld(true);

  const socketPos = new THREE.Vector3();
  const socketQuat = new THREE.Quaternion();
  socket.getWorldPosition(socketPos);
  socket.getWorldQuaternion(socketQuat);

  mount.position.copy(socketPos);
  mount.quaternion.copy(socketQuat);

  applySocketDepth(mount, socket, 0.05);

  makeSolid(motorRotationGroup);
  mount.add(motorRotationGroup);

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

function placeTriangle(socket) {
  const triangle = triangleTemplate.clone(true);
  makeSolid(triangle);

  let connector = null;
  triangle.traverse((o) => {
    if (o.name === "SOCKET_FRAME_CONNECTOR") connector = o;
  });

  socket.updateMatrixWorld(true);

  const socketPos = new THREE.Vector3();
  const socketQuat = new THREE.Quaternion();
  socket.getWorldPosition(socketPos);
  socket.getWorldQuaternion(socketQuat);

  const euler = new THREE.Euler().setFromQuaternion(socketQuat, "XYZ");

  let userRotationY = 0;
  if (ghost) {
    const ghostEuler = new THREE.Euler().setFromQuaternion(
      ghost.quaternion,
      "XYZ",
    );
    userRotationY = ghostEuler.y;
  }

  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "triangle_frame" };

  mount.rotation.set(0, euler.y + userRotationY, 0);

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
      rectConnectors.push({ name: o.name, x: wp.x, z: wp.z });
    }
  });

  const targetY = posSupA.y + FRAME_ON_SUPPORT_Y_OFFSET;

  if (rectConnectors.length === 0) {
    const mount = new THREE.Group();
    mount.userData = { isMount: true, socket, type: "frame" };
    mount.rotation.set(0, rotationSteps * (Math.PI / 2), 0);
    mount.position.set(posSupA.x, targetY, posSupA.z);
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
  const finalMountZ = posSupA.z - rsZ;

  const mount = new THREE.Group();
  mount.userData = { isMount: true, socket, type: "frame" };
  mount.rotation.set(0, finalAngle, 0);
  mount.position.set(finalMountX, targetY, finalMountZ);
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
   SUPPORT FRAME BRIDGE
   ========================================================= */

function placeSupportBridge(triangleA, triangleB) {
  const support = supportTemplate.clone(true);
  makeSolid(support);

  triangleA.updateMatrixWorld(true);
  triangleB.updateMatrixWorld(true);

  const posA = new THREE.Vector3();
  const posB = new THREE.Vector3();
  triangleA.getWorldPosition(posA);
  triangleB.getWorldPosition(posB);

  let supportSocketA = null;
  let supportSocketB = null;

  support.traverse((o) => {
    if (!o.name) return;
    const n = o.name.toUpperCase();
    if (n.includes("STRESS_SUPPORT")) {
      if (!supportSocketA && (n.endsWith("_R") || n.endsWith("R")))
        supportSocketA = o;
      if (!supportSocketB && (n.endsWith("_L") || n.endsWith("L")))
        supportSocketB = o;
    }
  });

  const mount = new THREE.Group();
  mount.userData = {
    isMount: true,
    socket: triangleA,
    socketB: triangleB,
    type: "support_frame",
  };

  if (supportSocketA && supportSocketB) {
    support.position.set(0, 0, 0);
    support.rotation.set(0, 0, 0);
    support.updateMatrixWorld(true);

    const localR = new THREE.Vector3();
    const localL = new THREE.Vector3();
    supportSocketA.getWorldPosition(localR);
    supportSocketB.getWorldPosition(localL);

    const dx = posB.x - posA.x;
    const dz = posB.z - posA.z;
    const baseAngle = Math.atan2(dx, dz);

    function applyAngleAndMeasure(testAngle, anchorLocal, targetPos) {
      const c = Math.cos(testAngle);
      const s = Math.sin(testAngle);
      const wx = targetPos.x - (c * anchorLocal.x + s * anchorLocal.z);
      const wz = targetPos.z - (-s * anchorLocal.x + c * anchorLocal.z);
      const otherLocal = anchorLocal === localR ? localL : localR;
      const owx = wx + c * otherLocal.x + s * otherLocal.z;
      const owz = wz + (-s * otherLocal.x + c * otherLocal.z);
      const otherTarget = anchorLocal === localR ? posB : posA;
      return Math.hypot(owx - otherTarget.x, owz - otherTarget.z);
    }

    const candidates = [
      { angle: baseAngle, snapLocal: localR },
      { angle: baseAngle + Math.PI, snapLocal: localR },
      { angle: baseAngle, snapLocal: localL },
      { angle: baseAngle + Math.PI, snapLocal: localL },
    ];

    let best = null;
    let bestErr = Infinity;
    for (const c of candidates) {
      const err = applyAngleAndMeasure(c.angle, c.snapLocal, posA);
      if (err < bestErr) {
        bestErr = err;
        best = c;
      }
    }

    const angle = best.angle;
    const snapLocal = best.snapLocal;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const rotatedSnapX = cosA * snapLocal.x + sinA * snapLocal.z;
    const rotatedSnapZ = -sinA * snapLocal.x + cosA * snapLocal.z;

    mount.position.set(posA.x - rotatedSnapX, posA.y, posA.z - rotatedSnapZ);
    mount.rotation.set(0, angle, 0);

    support.position.set(0, 0, 0);
    support.rotation.set(0, 0, 0);
    mount.add(support);
    scene.add(mount);
  } else {
    const midpoint = new THREE.Vector3(
      (posA.x + posB.x) / 2,
      (posA.y + posB.y) / 2,
      (posA.z + posB.z) / 2,
    );
    const dx = posB.x - posA.x;
    const dz = posB.z - posA.z;
    const angle = Math.atan2(dx, dz);

    mount.position.copy(midpoint);
    mount.rotation.set(0, angle, 0);
    support.position.set(0, 0, 0);
    support.rotation.set(0, 0, 0);
    mount.add(support);
    scene.add(mount);
  }

  usedSockets.add(triangleA.uuid);
  usedSockets.add(triangleB.uuid);
  addToInventory("support_frame");
  pushUndo(mount, [triangleA.uuid, triangleB.uuid], "support_frame");
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
      hoveredOrigEm = setMeshEmissive(hoveredMesh, 0x1a3a1a);
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
      setMeshEmissive(selectedMesh, 0x1a3a1a);
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
      selectedOrigEm = setMeshEmissive(selectedMesh, 0x3a3a00);
    }
    if (selectedMesh?.material?.emissive) {
      selectedMesh.material.emissive.set(0x3a3a00);
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

function onKeyDown(e) {
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

  if (e.key.toLowerCase() === "r") {
    if (placementMode === "motor") motorRotationGroup?.rotateY(Math.PI / 2);
    if (placementMode === "triangle" && ghost) ghost.rotateY(Math.PI / 2);
    if (placementMode === "support" && ghost) ghost.rotateY(Math.PI / 2);
    if (placementMode === "frameOnSupport") {
      frameOnSupportRotationSteps++;
      showHudMessage(
        `Frame rotation: ${(frameOnSupportRotationSteps % 4) * 90}°`,
      );
      updateShortcutBar();
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
  frame: "green",
  motor: "red",
  triangle: "cyan",
  support: "cyan",
  frameOnSupport: "purple",
  wheel: "orange",
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

  const relevantColor = placementMode ? LEGEND_MODE_MAP[placementMode] : null;

  if (!relevantColor) {
    legend.classList.remove("mode-active");
    legend
      .querySelectorAll(".legend-item")
      .forEach((el) => el.classList.remove("legend-relevant"));
    return;
  }

  legend.classList.add("mode-active");
  legend.querySelectorAll(".legend-item").forEach((el) => {
    const dot = el.querySelector(".legend-dot");
    if (!dot) return;
    const strong = el.querySelector("strong");
    const colorWord = strong?.textContent?.trim().toUpperCase();
    const colorMap = {
      GREEN: "green",
      RED: "red",
      CYAN: "cyan",
      PURPLE: "purple",
      ORANGE: "orange",
    };
    el.classList.toggle(
      "legend-relevant",
      colorMap[colorWord] === relevantColor,
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
    "0 0 18px rgba(212,146,42,0.45), inset 0 0 12px rgba(212,146,42,0.08)";

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
          ? frameMarkers
          : placementMode === "triangle"
            ? triangleMarkers
            : placementMode === "support"
              ? triangleMarkers
              : placementMode === "frameOnSupport"
                ? frameOnSupportMarkers
                : placementMode === "wheel"
                  ? wheelMarkers
                  : [];

    activeList.forEach((m) => m.scale.setScalar(pulse));
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

  tooltipEl.innerHTML =
    `<span style="color:#d4922a;font-weight:700;letter-spacing:0.15em;font-family:'Orbitron',sans-serif;font-size:10px">${label.toUpperCase()}</span><br>` +
    `<span style="color:#a89060">Unit cost: </span><span style="color:#f0d080">${costStr}</span>`;

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
