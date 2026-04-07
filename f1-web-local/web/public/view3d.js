/**
 * Three.js track + cars: default `simplify_car.stl`, or `/models/{team_slug}.glb` for
 * slugs in `TEAM_MODEL_ASSET_SLUGS` only (see `teamNameToSlug` + session `driver_teams`).
 * Orbit: drag, scroll zoom, right-drag pan.
 * World matches 2D telemetry: XZ plane, same rotation as circuit_rotation about bounds center.
 * Driver POV: `models/steering_wheel.glb` on the camera; hub telemetry is HTML (`driver-view-hud`).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  CSS2DObject,
  CSS2DRenderer,
} from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Skips ngrok browser warning on tunneled asset/API responses. */
const _NGROK_FETCH_INIT = { headers: { 'ngrok-skip-browser-warning': 'true' } };

/** Extra degrees on top of FastF1 `circuit_rotation` — must match app.js CIRCUIT_ROTATION_OFFSET_DEG. */
const CIRCUIT_ROTATION_OFFSET_DEG = 180;

/** Start/finish segment from payload, or from centerline start (same logic as 2D `app.js`). */
function finishLineFromTrack(track) {
  if (track.finish_line?.start && track.finish_line?.end) return track.finish_line;
  const cx = track.centerline?.x;
  const cy = track.centerline?.y;
  if (!cx || !cy || cx.length < 2) return null;
  const x0 = cx[0];
  const y0 = cy[0];
  const x1 = cx[1];
  const y1 = cy[1];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const half = 100;
  return {
    start: { x: x0 + nx * half, y: y0 + ny * half },
    end: { x: x0 - nx * half, y: y0 - ny * half },
  };
}

/** If the mesh faces the wrong way vs telemetry motion, try ±Math.PI/2 steps. */
const CAR_STL_YAW_OFFSET = 0;
/** Set to 0 if the STL is already Y-up (e.g. Blender export). CAD exports are often Z-up. */
const CAR_STL_ROTATE_X = -Math.PI / 2;
/**
 * Team GLB orientation (glTF is usually Y-up, car on XZ — do **not** reuse `CAR_STL_ROTATE_X`
 * unless the file is Z-up CAD like the STL). Wrong X = car looks “rolled” along its length.
 * Try Y ±π/2 if length is along X instead of Z; Z for plan-view yaw.
 */
const CAR_TEAM_MODEL_ROTATE_X = 0;
const CAR_TEAM_MODEL_ROTATE_Y = 0;
const CAR_TEAM_MODEL_ROTATE_Z = 0;
/**
 * Extra factor after fitting team GLBs inside the STL unit AABB. Values below 1 shrink all team
 * cars vs the default mesh (same runtime `carCubeSize` for both).
 */
const CAR_TEAM_MODEL_SCALE_MULTIPLIER = 0.85;

/**
 * Try page-root URL first (FastAPI static, Vite public/, Live Server).
 * Avoid import.meta URL when it is blob: (bundled dev servers) — fetch cannot load from it.
 */
function carStlFetchUrls() {
  const urls = [];
  if (typeof window !== 'undefined' && window.location?.origin) {
    urls.push(new URL('/simplify_car.stl', window.location.origin).href);
  }
  try {
    const meta = import.meta.url;
    if (meta && !String(meta).startsWith('blob:')) {
      const u = new URL('simplify_car.stl', meta).href;
      if (!urls.includes(u)) urls.push(u);
    }
  } catch {
    /* ignore */
  }
  return urls;
}

/** e.g. "McLaren" → "mclaren", "Red Bull Racing" → "red_bull_racing" → `models/red_bull_racing.glb`. */
function teamNameToSlug(teamName) {
  if (!teamName || typeof teamName !== 'string') return null;
  const s = teamName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s.length === 0 ? null : s;
}

/**
 * `teamNameToSlug(TeamName)` variants from other seasons → canonical slug in `TEAM_MODEL_ASSET_SLUGS`.
 * e.g. FastF1 "Alfa Romeo Racing" → `alfa_romeo_racing` → same GLB as `alfa_romeo`.
 * 2025+: "Racing Bulls" / "Visa Cash App RB" → `racing_bulls` / `visa_cash_app_rb` → `rb.glb`.
 */
const TEAM_MODEL_SLUG_ALIASES = {
  alfa_romeo_racing: 'alfa_romeo',
  racing_bulls: 'rb',
  visa_cash_app_rb: 'rb',
};

/**
 * Slugs with a local `frontend/models/{slug}.glb` (add the file, then the slug here).
 * All other teams use the default simplify_car.stl mesh.
 */
const TEAM_MODEL_ASSET_SLUGS = new Set([
  'mclaren',
  'red_bull_racing',
  'ferrari',
  'mercedes',
  'aston_martin',
  'alpine',
  'williams',
  'haas_f1_team',
  'kick_sauber',
  'rb',
  'alfa_romeo',
  'alphatauri',
  'renault',
  'racing_point',
  'toro_rosso',
]);

/**
 * When the GLB filename differs from the FastF1 slug (e.g. `haas.glb` for team `haas_f1_team`).
 */
const TEAM_MODEL_GLB_FILENAME = {
  haas_f1_team: 'haas',
  /** File on disk is PascalCase (`AlphaTauri.glb`). */
  alphatauri: 'AlphaTauri',
};

function resolveTeamModelSlug(rawSlug) {
  if (!rawSlug) return null;
  const canonical = TEAM_MODEL_SLUG_ALIASES[rawSlug] ?? rawSlug;
  return TEAM_MODEL_ASSET_SLUGS.has(canonical) ? canonical : null;
}

function teamModelGlbBasename(slug) {
  return TEAM_MODEL_GLB_FILENAME[slug] ?? slug;
}

/**
 * Per-team model orientation + scale overrides.
 *
 * HOW TO ADD A NEW TEAM CAR
 * --------------------------
 * 1. Export `<team_slug>.glb` into `frontend/models/`. The slug is `teamNameToSlug(TeamName)`:
 *    e.g. "Ferrari" → ferrari.glb, "Aston Martin" → aston_martin.glb. If the file name must differ,
 *    add `TEAM_MODEL_GLB_FILENAME` (e.g. Haas → `haas.glb`).
 *
 * 2. Add the slug to TEAM_MODEL_ASSET_SLUGS below.
 *
 * 3. Add an entry to TEAM_MODEL_CONFIG below. To find the right rotation:
 *    - Open the GLB in https://gltf.report or Blender and note which axis
 *      the car's NOSE points along.
 *    - The goal is: nose → world -Z (matches the STL pipeline).
 *    - Common cases:
 *        Nose along +Y (standing upright): x: Math.PI / 2
 *        Nose along -Y:                    x: -Math.PI / 2
 *        Nose along +X (lying sideways):   y: Math.PI / 2
 *        Nose along -X:                    y: -Math.PI / 2
 *        Nose already along -Z (glTF std): x: 0, y: 0, z: 0  (no rotation needed)
 *        Nose along +Z (facing backwards): y: Math.PI  (180° yaw flip)
 *    - If the car appears correct but drives backwards, add y: Math.PI.
 *    - If the car is rolled on its side, tweak x ±Math.PI/2.
 *
 *    scaleMul defaults to CAR_TEAM_MODEL_SCALE_MULTIPLIER (0.85) if omitted.
 *    Only set it if one specific model needs to be bigger or smaller than the rest.
 *
 *    liftY (optional): extra upward offset in units of carCubeSize after grounding (e.g. 0.06).
 *    Use when a GLB’s lowest point is still slightly below the asphalt after normalization.
 */
const TEAM_MODEL_CONFIG = {
  // Nose along +Y in model space → rotateX(+PI/2) → nose faces -Z (world forward)
  mclaren: { x: 0, y: 0, z: 0 },
  // Nose along +X in model space → rotateY(+PI/2) → nose faces -Z (world forward)
  red_bull_racing: { x: 0, y: Math.PI / 2, z: 0 },
  ferrari: { x: 0, y: 0, z: 0 },
  mercedes: { x: 0, y: 0, z: 0 },
  aston_martin: { x: 0, y: 0, z: 0 },
  alpine: { x: 0, y: 0, z: 0 },
  williams: { x: 0, y: 0, z: 0 },
  haas_f1_team: { x: 0, y: 0, z: 0 },
  kick_sauber: { x: 0, y: 0, z: 0 },
  rb: { x: 0, y: 0, z: 0 },
  alfa_romeo: { x: 0, y: 0, z: 0 },
  alphatauri: { x: 0, y: 0, z: 0 },
  renault: { x: 0, y: 0, z: 0 },
  racing_point: { x: 0, y: 0, z: 0 },
  toro_rosso: { x: 0, y: 0, z: 0 },
};

/**
 * Extra yaw (rad) added to path heading so some GLB noses match telemetry forward. (Baked `y` in
 * TEAM_MODEL_CONFIG is overwritten each frame — see `updateHeadingFromMotion`.) RB / Alfa Romeo
 * models ship facing −telemetry; use Math.PI. Tune per slug if a new car is wrong.
 */
const TEAM_MESH_HEADING_EXTRA_YAW = {
  rb: Math.PI,
  alfa_romeo: Math.PI,
};

function teamMeshHeadingExtraYaw(slug) {
  if (!slug || typeof slug !== 'string') return 0;
  return Object.prototype.hasOwnProperty.call(TEAM_MESH_HEADING_EXTRA_YAW, slug)
    ? TEAM_MESH_HEADING_EXTRA_YAW[slug]
    : 0;
}

/** Back-compat alias used inside prepareCarGroupTemplate. */
const TEAM_MODEL_ORIENTATION = TEAM_MODEL_CONFIG;

/** Base path for GLTFLoader.parse (textures / relative buffers). */
function teamModelUrlBase(url) {
  const i = url.lastIndexOf('/');
  return i === -1 ? '' : url.slice(0, i + 1);
}

function teamModelUrlsForSlug(slug) {
  const names = [`${teamModelGlbBasename(slug)}.glb`];
  const out = [];
  const push = (url, type) => {
    if (!out.some((o) => o.url === url)) out.push({ url, type });
  };
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : '';
  const httpOrigin =
    Boolean(origin) &&
    (origin.startsWith('http://') || origin.startsWith('https://'));
  if (httpOrigin) {
    for (const n of names) {
      push(new URL(`/models/${n}`, origin).href, 'glb');
    }
  } else {
    try {
      const meta = import.meta.url;
      if (meta && !String(meta).startsWith('blob:')) {
        for (const n of names) {
          push(new URL(`./models/${n}`, meta).href, 'glb');
        }
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Match 2D map dots (`app.js` normalizeHex + default `#ffffff`). */
function normalizeHex(hex) {
  if (!hex || typeof hex !== 'string') return '#ffffff';
  let h = hex.replace('#', '').trim();
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6 || !/^[0-9a-fA-F]+$/.test(h)) return '#ffffff';
  return `#${h}`;
}

/**
 * @param {HTMLElement} wrapEl
 * @returns {object}
 */
export function createTrackView3D(wrapEl) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    /** Lets us use a small `camera.near` for cockpit geometry without ruining depth for the full circuit. */
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  if ('outputColorSpace' in renderer) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  const el = renderer.domElement;
  el.className = 'track-view-3d-canvas';
  el.setAttribute(
    'aria-label',
    '3D track view — scroll to zoom, left drag to orbit, right drag to pan',
  );
  wrapEl.appendChild(el);

  const labelRenderer = new CSS2DRenderer();
  const lrEl = labelRenderer.domElement;
  lrEl.className = 'track-view-3d-labels';
  wrapEl.appendChild(lrEl);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050508);

  const DEFAULT_CAMERA_FOV = 48;
  /** Narrower FOV reads more like a helmet / cockpit opening than a broadcast camera. */
  const DRIVER_POV_CAMERA_FOV = 54;
  /** Near < 1 so cockpit geometry (steering wheel ~1 m) is not clipped by the frustum. */
  const camera = new THREE.PerspectiveCamera(DEFAULT_CAMERA_FOV, 1, 0.05, 2e7);
  /**
   * Driver POV: `models/steering_wheel.glb` parented to camera (fixed in view).
   * Tweak STEERING_WHEEL_* if the asset’s orientation/size differs.
   */
  const steeringWheelPivot = new THREE.Group();
  steeringWheelPivot.name = 'SteeringWheelPivot';
  steeringWheelPivot.visible = false;
  steeringWheelPivot.frustumCulled = false;
  /** Extra light — cockpit wheel may get little sun; keeps PBR meshes visible. */
  const steeringWheelLight = new THREE.PointLight(0xffffff, 2.2, 12, 1.2);
  steeringWheelLight.position.set(0, 0.15, -0.15);
  steeringWheelPivot.add(steeringWheelLight);
  /**
   * Wheel must live under `scene`, not `camera`. Meshes parented to PerspectiveCamera
   * are often not drawn reliably; we sync transform from the camera each frame instead.
   */
  scene.add(steeringWheelPivot);
  const _steerLocalOff = new THREE.Vector3();
  /** Car yaw samples for inferring turn rate → wheel + HUD rotation (no steering angle in API). */
  let steerWheelYawPrev = 0;
  /** @type {number | null} */
  let steerWheelYawPrevTime = null;
  let steerWheelDeflectRad = 0;
  /** @type {Promise<void> | null} */
  let steeringWheelLoadPromise = null;
  /** @type {THREE.Object3D | null} */
  let steeringWheelModel = null;
  /** Uniform scale from bounding-box fit (`targetSize / maxDim`); multiplied by `STEERING_WHEEL_USER_SCALE`. */
  let steeringWheelModelFitScale = 1;
  /** Extra scale on the GLB after fit (no UI — edit here). */
  const STEERING_WHEEL_USER_SCALE = 4;

  /**
   * Bump when you change default pos* below so old saved JSON does not keep hiding
   * those edits (see initSteeringWheelTuneFromStorage).
   */
  const STEERING_WHEEL_TUNE_DEFAULTS_REV = 2;
  const STEERING_WHEEL_TUNE_STORAGE_KEY = 'f1-steering-wheel-tune-v3';

  /** Fixed model orientation (edit here if the GLB faces the wrong way). */
  const STEERING_WHEEL_ROT_X = -Math.PI * (3 / 2);
  const STEERING_WHEEL_ROT_Y = 0;
  const STEERING_WHEEL_ROT_Z = 0;
  /** Maps car yaw rate (rad/s) to extra Euler angle (see `STEER_WHEEL_DEFLECT_EULER`). */
  const STEER_WHEEL_YAW_RATE_GAIN = 0.38;
  const STEER_WHEEL_DEFLECT_MAX = 0.72;
  const STEER_WHEEL_SMOOTH = 0.28;
  const STEER_WHEEL_DECAY = 0.9;
  /**
   * Which Euler component gets the yaw-derived deflection (after STEERING_WHEEL_ROT_*).
   * With a large base `rotation.x`, adding to `z` often rolls the rim on the wrong axis;
   * `y` matches in-plane steering for this GLB. Change to `'x' | 'z'` if the wheel still tumbles.
   */
  const STEER_WHEEL_DEFLECT_EULER = /** @type {'x' | 'y' | 'z'} */ ('y');

  function steeringWheelTuneDefaults() {
    return {
      posX: 0,
      posY: -0.8,
      posZ: -4,
    };
  }

  /** @type {{ posX: number; posY: number; posZ: number }} */
  let steeringWheelTune = steeringWheelTuneDefaults();

  /** @type {InstanceType<typeof OrbitControls>} */
  let controls = new OrbitControls(camera, el);

  function applyOrbitControlsDefaults() {
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.screenSpacePanning = true;
    controls.panSpeed = 1.2;
    controls.zoomSpeed = 1.05;
    controls.minDistance = 20;
    controls.maxDistance = 5e6;
    controls.enableRotate = true;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    if (THREE.TOUCH) {
      controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
      };
    }
  }
  applyOrbitControlsDefaults();

  /**
   * Full reset: internal pointer FSM lives in OrbitControls closure and is not
   * exposed — dispose + new instance fixes left-drag mapping after follow/driver POV.
   */
  function recreateOrbitControls() {
    controls.dispose();
    controls = new OrbitControls(camera, el);
    applyOrbitControlsDefaults();
  }

  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(400, 1200, 600);
  scene.add(sun);

  const trackGroup = new THREE.Group();
  scene.add(trackGroup);

  /** Procedural asphalt map — assigned when building track; cleared in clearTrackLines. */
  let trackAsphaltMap = null;

  function createAsphaltNoiseTexture() {
    const sz = 256;
    const cnv = document.createElement('canvas');
    cnv.width = cnv.height = sz;
    const g = cnv.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#3d3d42';
    g.fillRect(0, 0, sz, sz);
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.1})`;
      g.fillRect(Math.random() * sz, Math.random() * sz, 1, 1);
    }
    for (let i = 0; i < 3500; i++) {
      g.fillStyle = `rgba(255,255,255,${0.02 + Math.random() * 0.05})`;
      g.fillRect(Math.random() * sz, Math.random() * sz, 1, 1);
    }
    g.strokeStyle = 'rgba(0,0,0,0.06)';
    for (let i = 0; i < 24; i++) {
      g.beginPath();
      g.moveTo(0, (i / 24) * sz);
      g.lineTo(sz, (i / 24) * sz);
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(cnv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 1);
    if (
      'colorSpace' in tex &&
      renderer.outputColorSpace === THREE.SRGBColorSpace
    ) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    return tex;
  }

  function addVertexColorsToGeometry(geom, hex) {
    const pos = geom.attributes.position;
    const n = pos.count;
    const arr = new Float32Array(n * 3);
    const col = new THREE.Color(hex);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = col.r;
      arr[i * 3 + 1] = col.g;
      arr[i * 3 + 2] = col.b;
    }
    geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }

  const carGroup = new THREE.Group();
  scene.add(carGroup);

  /** @type {Map<string, THREE.Group>} car root: mesh + CSS2D label */
  const carMeshes = new Map();

  /**
   * Shared flat ring in XZ (unit outer radius 1). Mesh rings read thicker than WebGL LineLoop (1px).
   */
  let unitRingGeometry = null;

  function getUnitRingGeometry() {
    if (!unitRingGeometry) {
      const inner = 0.82;
      const outer = 1.0;
      unitRingGeometry = new THREE.RingGeometry(inner, outer, 72);
      unitRingGeometry.rotateX(-Math.PI / 2);
    }
    return unitRingGeometry;
  }

  function releaseCarRings(root) {
    const gold = root.userData.ringGold;
    if (gold) {
      root.remove(gold);
      gold.material?.dispose();
      root.userData.ringGold = null;
    }
    const white = root.userData.ringWhite;
    if (white) {
      root.remove(white);
      white.material?.dispose();
      root.userData.ringWhite = null;
    }
  }

  /**
   * Gold ring = P1 / race leader; cyan ring = driver you're watching (outside gold when same car).
   * depthTest off so rings stay readable on asphalt and under the car mesh.
   */
  function ensureCarRings(root) {
    let gold = root.userData.ringGold;
    let white = root.userData.ringWhite;
    if (!gold) {
      gold = new THREE.Mesh(
        getUnitRingGeometry(),
        new THREE.MeshBasicMaterial({
          color: 0xffd65a,
          transparent: true,
          opacity: 1,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      );
      gold.renderOrder = 100;
      gold.position.y = 0.025;
      root.add(gold);
      root.userData.ringGold = gold;
    }
    if (!white) {
      white = new THREE.Mesh(
        getUnitRingGeometry(),
        new THREE.MeshBasicMaterial({
          color: 0x44d9ff,
          transparent: true,
          opacity: 0.98,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      );
      white.renderOrder = 101;
      white.position.y = 0.048;
      root.add(white);
      root.userData.ringWhite = white;
    }
    if (gold.material) {
      gold.material.opacity = 1;
      gold.material.depthTest = false;
      gold.material.depthWrite = false;
      gold.renderOrder = 100;
    }
    if (white.material) {
      white.material.color.setHex(0x44d9ff);
      white.material.opacity = 0.98;
      white.material.depthTest = false;
      white.material.depthWrite = false;
      white.renderOrder = 101;
      white.position.y = 0.048;
    }
    return { gold, white };
  }

  /**
   * Prepared STL (unit-sized, on ground). Each car gets its own clone() — sharing one
   * BufferGeometry across many Meshes often breaks WebGL (everything looks like boxes/wrong).
   */
  let carStlMaster = null;
  /** Per-team slug → prepared GLB scene root (materials preserved). */
  const teamModelTemplates = new Map();
  /** @type {Map<string, Promise<void>>} */
  const teamModelLoadPromises = new Map();
  /** @type {Promise<void> | null} */
  let carStlLoadPromise = null;

  let active = false;
  let carCubeSize = 12;
  let cx = 0;
  let cy = 0;
  let rotRad = 0;
  /** @type {any} */
  let lastMeta = null;

  /** @type {'free' | 'follow' | 'driver_pov'} */
  let cameraMode = 'free';
  /** @type {string | null} last selected driver code from updateFrame */
  let lastCamFollowCode = null;

  const _camDir = new THREE.Vector3();
  const _camTarget = new THREE.Vector3();
  const _desiredCamPos = new THREE.Vector3();
  const _carPosTarget = new THREE.Vector3();
  /** Driver POV: offset in mesh space before `localToWorld` (unit ≈ car length after scale). */
  const _cockpitLocal = new THREE.Vector3();

  /** Lerp toward camera target each frame so follow/driver POV does not jitter. */
  const CAM_POS_LERP = 0.82;
  /** Slightly softer chase so camera doesn’t “buzz” on mesh jitter. */
  const DRIVER_POV_CAM_LERP = 0.91;
  /** Wall-clock delta between `updateFrame` calls — frame-rate–independent car smoothing. */
  let lastFrameUpdateTs = 0;

  function driverPovTuneDefaults() {
    return {
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: DRIVER_POV_CAMERA_FOV,
    };
  }

  /**
   * Ship-time cockpit defaults per team GLB (mesh-local offsets + look + FOV).
   * Add a row when you measure a model; keys are canonical slugs (same as TEAM_MODEL_ASSET_SLUGS).
   */
  const TEAM_DRIVER_POV_BASE = {
    red_bull_racing: {
      offsetX: -0.15,
      offsetY: 0.215,
      offsetZ: 0.75,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    ferrari: {
      offsetX: -0.155,
      offsetY: 0.28,
      offsetZ: 0.405,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    mercedes: {
      offsetX: -0.15,
      offsetY: 0.06,
      offsetZ: 0.245,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    kick_sauber: {
      offsetX: -0.16,
      offsetY: 0.385,
      offsetZ: 0.33,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    haas_f1_team: {
      offsetX: -0.15,
      offsetY: 0.375,
      offsetZ: 0.21,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    mclaren: {
      offsetX: -0.155,
      offsetY: 0.165,
      offsetZ: 0.67,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    williams: {
      offsetX: -0.16,
      offsetY: 0.33,
      offsetZ: 0.27,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    aston_martin: {
      offsetX: -0.155,
      offsetY: 0.205,
      offsetZ: 0.545,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    rb: {
      offsetX: 0,
      offsetY: 0.12,
      offsetZ: 0.01,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    alpine: {
      offsetX: -0.15,
      offsetY: 0.2,
      offsetZ: 0.715,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    alphaturi: {
      offsetX: -0.15,
      offsetY: 0.19,
      offsetZ: 0.535,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    alfa_romeo: {
      offsetX: -0.155,
      offsetY: -0.225,
      offsetZ: 0.18,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    renault: {
      offsetX: -0.155,
      offsetY: 0.37,
      offsetZ: 0.38,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    racing_point: {
      offsetX: -0.15,
      offsetY: 0.395,
      offsetZ: 0.375,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
    toro_rosso: {
      offsetX: -0.15,
      offsetY: 0.35,
      offsetZ: 0.355,
      lookDownMul: 1,
      lookDistMul: 1,
      fov: 72,
    },
  };

  function getDriverPovTuneStorageSlug() {
    if (!lastCamFollowCode || lastCamFollowCode === '__SC__')
      return '__fallback__';
    const slug = getTeamSlugForDriver(lastCamFollowCode);
    return slug || '__fallback__';
  }

  function mergeDriverPovTune(a, b) {
    return { ...a, ...b };
  }

  /**
   * Effective tune for the car currently followed in driver POV (team slug from session meta).
   * Order: defaults → optional ship-time TEAM_DRIVER_POV_BASE[slug].
   */
  function getEffectiveDriverPovTune() {
    const d = driverPovTuneDefaults();
    const slug = getDriverPovTuneStorageSlug();
    const teamBase = TEAM_DRIVER_POV_BASE[slug] || {};
    return mergeDriverPovTune(d, teamBase);
  }

  /**
   * World-space smoothing for car roots — removes micro-jerk from 25 Hz samples + blend edges.
   * Exponential decay rate (1/s): higher = tighter tracking. Tuned so ~60 Hz matches prior lerp feel.
   */
  const CAR_POS_RATE_MIN = 8;
  const CAR_POS_RATE_MAX = 38;
  /** If target jumps farther than this (m), snap (session seek / glitch). */
  const CAR_POS_SNAP_DIST = 220;

  /** Base yaw smoothing when speed unknown (rad/s feel). */
  const YAW_LERP_MIN = 0.25;
  const YAW_LERP_MAX = 0.76;
  /** Ignore tiny position deltas (m²) when inferring heading — reduces pit-lane jitter. */
  const YAW_MIN_DIST_SQ_M = 0.02 * 0.02;

  function lerpAngleShortest(cur, target, t) {
    let d = target - cur;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return cur + d * t;
  }

  /**
   * Exponential smoothing toward telemetry target. Uses wall-clock `dt` so motion stays smooth at
   * 120 Hz vs 60 Hz. Heading is updated separately from raw telemetry (see `updateFrame` order).
   */
  function smoothCarWorldPosition(root, tx, ty, tz, speedMps, dt) {
    _carPosTarget.set(tx, ty, tz);
    if (!root.userData.carPosSmoothInitialized) {
      root.position.copy(_carPosTarget);
      root.userData.carPosSmoothInitialized = true;
      return;
    }
    if (root.position.distanceTo(_carPosTarget) > CAR_POS_SNAP_DIST) {
      root.position.copy(_carPosTarget);
      return;
    }
    const sp = Number(speedMps);
    const rate = Number.isFinite(sp)
      ? CAR_POS_RATE_MIN +
        (Math.min(sp, 130) / 130) * (CAR_POS_RATE_MAX - CAR_POS_RATE_MIN)
      : (CAR_POS_RATE_MIN + CAR_POS_RATE_MAX) * 0.5;
    const d = Math.max(0, Math.min(Number(dt) || 1 / 60, 0.25));
    const u = 1 - Math.exp(-rate * d);
    root.position.lerp(_carPosTarget, u);
  }

  function isCameraDriverLocked() {
    return (
      (cameraMode === 'follow' || cameraMode === 'driver_pov') &&
      !!lastCamFollowCode &&
      carMeshes.has(lastCamFollowCode)
    );
  }

  /** World-space steering wheel follows the camera (see pivot comment near scene.add). */
  function syncSteeringWheelToCamera() {
    if (!steeringWheelModel) {
      steeringWheelPivot.visible = false;
      wrapEl.style.removeProperty('--driver-wheel-steer');
      return;
    }
    const show =
      active && cameraMode === 'driver_pov' && isCameraDriverLocked();

    if (show && lastCamFollowCode && carMeshes.has(lastCamFollowCode)) {
      const root = carMeshes.get(lastCamFollowCode);
      const yaw = root?.userData.lastYaw ?? 0;
      const t = performance.now() * 0.001;
      if (steerWheelYawPrevTime == null) {
        steerWheelYawPrev = yaw;
        steerWheelYawPrevTime = t;
      } else {
        const dt = Math.max(1e-4, t - steerWheelYawPrevTime);
        let dy = yaw - steerWheelYawPrev;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        steerWheelYawPrev = yaw;
        steerWheelYawPrevTime = t;
        const yawRate = dy / dt;
        const target = THREE.MathUtils.clamp(
          yawRate * STEER_WHEEL_YAW_RATE_GAIN,
          -STEER_WHEEL_DEFLECT_MAX,
          STEER_WHEEL_DEFLECT_MAX,
        );
        steerWheelDeflectRad +=
          (target - steerWheelDeflectRad) * STEER_WHEEL_SMOOTH;
      }
      /* 2D screen rotate is inverted vs GLB Euler deflection — negate so HUD matches wheel visually. */
      wrapEl.style.setProperty(
        '--driver-wheel-steer',
        `${-steerWheelDeflectRad * (180 / Math.PI)}deg`,
      );
    } else {
      steerWheelYawPrevTime = null;
      steerWheelDeflectRad *= STEER_WHEEL_DECAY;
      if (Math.abs(steerWheelDeflectRad) < 1e-4) steerWheelDeflectRad = 0;
      wrapEl.style.removeProperty('--driver-wheel-steer');
    }

    /* Apply scale whenever the model exists so the slider works in any camera mode. */
    const d = steerWheelDeflectRad;
    if (STEER_WHEEL_DEFLECT_EULER === 'x') {
      steeringWheelModel.rotation.set(
        STEERING_WHEEL_ROT_X + d,
        STEERING_WHEEL_ROT_Y,
        STEERING_WHEEL_ROT_Z,
      );
    } else if (STEER_WHEEL_DEFLECT_EULER === 'y') {
      steeringWheelModel.rotation.set(
        STEERING_WHEEL_ROT_X,
        STEERING_WHEEL_ROT_Y + d,
        STEERING_WHEEL_ROT_Z,
      );
    } else {
      steeringWheelModel.rotation.set(
        STEERING_WHEEL_ROT_X,
        STEERING_WHEEL_ROT_Y,
        STEERING_WHEEL_ROT_Z + d,
      );
    }
    steeringWheelModel.scale.setScalar(
      steeringWheelModelFitScale * STEERING_WHEEL_USER_SCALE,
    );
    steeringWheelPivot.visible = show;
    if (!show) return;
    camera.updateMatrixWorld(true);
    _steerLocalOff.set(
      steeringWheelTune.posX,
      steeringWheelTune.posY,
      steeringWheelTune.posZ,
    );
    _steerLocalOff.applyQuaternion(camera.quaternion);
    steeringWheelPivot.position.copy(camera.position).add(_steerLocalOff);
    steeringWheelPivot.quaternion.copy(camera.quaternion);
  }

  function getTeamSlugForDriver(code) {
    if (!code || code === '__SC__') return null;
    const team = lastMeta?.driver_teams?.[code];
    return resolveTeamModelSlug(teamNameToSlug(team));
  }

  /**
   * Chase camera: above and behind the car, looking forward.
   */
  function applyFollowCamera(code) {
    const root = carMeshes.get(code);
    if (!root) return;
    /** Prefer path-only `motionYaw`; else mesh yaw minus RB visual offset. */
    let yaw = root.userData.motionYaw;
    if (yaw === undefined || yaw === null) {
      yaw = root.userData.lastYaw ?? 0;
      const mesh = root.userData.mesh;
      const extra = teamMeshHeadingExtraYaw(mesh?.userData?.teamSlug);
      if (mesh?.userData?.geomSource === 'gltf' && extra) {
        yaw -= extra;
      }
    }
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const back = carCubeSize * 1.15;
    const up = carCubeSize * 0.62;
    const px = root.position.x - fx * back;
    const py = root.position.y + up;
    const pz = root.position.z - fz * back;
    _desiredCamPos.set(px, py, pz);
    camera.position.lerp(_desiredCamPos, CAM_POS_LERP);
    const look = Math.max(carCubeSize * 45, 400);
    _camTarget.set(px + fx * look, py - up * 0.35, pz + fz * look);
    camera.lookAt(_camTarget);
  }

  /**
   * Cockpit view: eye position comes from mesh-local offsets + `localToWorld` so it sits inside
   * the GLB volume (not a world-sin/cos point that ignores model nose/up). Look direction follows
   * the car’s world -Z (Three.js forward) via `getWorldDirection`.
   *
   * Some GLBs (large bbox → small `mesh.scale.x`) need the **entire** cockpit offset scaled by
   * `carCubeSize / w`: world eye height is `localY * w`, so a fixed local base (0.33, …) alone
   * collapses toward 0 when `w` is tiny — camera sits too low even with “normal” tune values.
   * Same teams as `TEAM_MESH_HEADING_EXTRA_YAW` (rb, alfa_romeo) here; negate `_camDir` for POV.
   */
  function applyDriverPovCamera(code) {
    const root = carMeshes.get(code);
    if (!root) return;
    const mesh = root.userData.mesh;
    if (!mesh) return;

    mesh.updateMatrixWorld(true);
    const geom = mesh.userData.geomSource;
    const w = mesh.scale.x || 1;
    const slug = getTeamSlugForDriver(code);

    const t = getEffectiveDriverPovTune();
    if (camera.fov !== t.fov) {
      camera.fov = t.fov;
      camera.updateProjectionMatrix();
    }
    if (geom === 'gltf') {
      const cockpitScale = teamMeshHeadingExtraYaw(slug)
        ? carCubeSize / Math.max(w, 1e-8)
        : 1;
      _cockpitLocal.set(
        (0.15 + t.offsetX) * cockpitScale,
        (0.33 + t.offsetY) * cockpitScale,
        (-0.17 + t.offsetZ) * cockpitScale,
      );
    } else if (geom === 'stl') {
      _cockpitLocal.set(0.11 + t.offsetX, 0.27 + t.offsetY, -0.13 + t.offsetZ);
    } else {
      _cockpitLocal.set(0.07 + t.offsetX, 0.22 + t.offsetY, -0.09 + t.offsetZ);
    }

    mesh.localToWorld(_cockpitLocal);
    _desiredCamPos.copy(_cockpitLocal);
    camera.position.lerp(_desiredCamPos, DRIVER_POV_CAM_LERP);

    mesh.getWorldDirection(_camDir);
    if (geom === 'gltf' && teamMeshHeadingExtraYaw(slug)) {
      _camDir.negate();
    }
    const lookDist = Math.max(w * 50 * t.lookDistMul, 480);
    _camTarget.copy(camera.position).addScaledVector(_camDir, lookDist);
    _camTarget.y -= w * 0.065 * t.lookDownMul;
    camera.lookAt(_camTarget);
  }

  /**
   * Reapply bindings after follow/driver POV (controls disabled) so pointer
   * bookkeeping doesn’t misclassify the next gesture (e.g. left-drag panning).
   * Must match applyOrbitControlsDefaults — same as after recreateOrbitControls().
   */
  function resetOrbitInteractionModel() {
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    if (THREE.TOUCH) {
      controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
      };
    }
    controls.enableRotate = true;
    controls.enablePan = true;
    controls.enableZoom = true;
    if (controls._pointers && Array.isArray(controls._pointers)) {
      controls._pointers.length = 0;
    }
    if (controls._pointerPositions) {
      for (const k of Object.keys(controls._pointerPositions)) {
        delete controls._pointerPositions[k];
      }
    }
  }

  function syncOrbitTargetFromCamera() {
    resetOrbitInteractionModel();
    camera.getWorldDirection(_camDir);
    controls.target
      .copy(camera.position)
      .addScaledVector(_camDir, Math.max(carCubeSize * 80, 250));
    // While follow/driver POV runs, controls.update() is skipped — stale damping deltas
    // would otherwise be applied on the first free-mode frame and twist the orbit.
    if (controls._sphericalDelta) controls._sphericalDelta.set(0, 0, 0);
    if (controls._panOffset) controls._panOffset.set(0, 0, 0);
    controls._scale = 1;
  }

  /** Same framing as the end of rebuildTrack (session load / 3D track build). */
  function applyDefaultFreeCameraPose() {
    resetOrbitInteractionModel();
    const meta = lastMeta;
    const b = meta?.track?.bounds;
    if (!b) {
      syncOrbitTargetFromCamera();
      return;
    }
    const cxi = (b.x_min + b.x_max) / 2;
    const cyi = (b.y_min + b.y_max) / 2;
    const w = Math.max(1, b.x_max - b.x_min);
    const h = Math.max(1, b.y_max - b.y_min);
    const diag = Math.hypot(w, h);
    const dist = diag * 0.55;
    camera.position.set(cxi + dist * 0.55, diag * 0.42, cyi + dist * 0.55);
    controls.target.set(cxi, 0, cyi);
    if (controls._sphericalDelta) controls._sphericalDelta.set(0, 0, 0);
    if (controls._panOffset) controls._panOffset.set(0, 0, 0);
    controls._scale = 1;
  }

  function syncControlsForCameraMode() {
    if (!active) return;
    controls.enabled = !isCameraDriverLocked();
  }

  /**
   * @param {'free' | 'follow' | 'driver_pov'} mode
   */
  function setCameraMode(mode) {
    const m =
      mode === 'follow' || mode === 'driver_pov' || mode === 'free'
        ? mode
        : 'free';
    const prevMode = cameraMode;
    cameraMode = m;
    camera.fov =
      m === 'driver_pov' ? getEffectiveDriverPovTune().fov : DEFAULT_CAMERA_FOV;
    camera.updateProjectionMatrix();
    if (!active) return;
    if (isCameraDriverLocked()) {
      controls.enabled = false;
    } else {
      /* New OrbitControls whenever leaving follow/POV for free — not only when
       * isCameraDriverLocked was true (follow can be "unlocked" with no car mesh
       * but controls still got disabled / desynced). */
      const enteringFreeFromChase =
        m === 'free' && (prevMode === 'follow' || prevMode === 'driver_pov');
      if (enteringFreeFromChase) {
        recreateOrbitControls();
        applyDefaultFreeCameraPose();
      } else {
        syncOrbitTargetFromCamera();
      }
      controls.enabled = true;
      controls.update();
    }
  }

  function getCameraMode() {
    return cameraMode;
  }

  function rotateWorld(x, y) {
    const tx = x - cx;
    const ty = y - cy;
    const cos = Math.cos(rotRad);
    const sin = Math.sin(rotRad);
    const rx = tx * cos - ty * sin + cx;
    const ry = tx * sin + ty * cos + cy;
    return [rx, ry];
  }

  /** Telemetry (x,y) → Three.js (x, y-up, z) with same rotation as 2D map */
  function toThreeVec(xw, yw) {
    const [rx, ry] = rotateWorld(xw, yw);
    /* Match 2D worldToScreen Y flip (canvas Y down vs world Y up). */
    return new THREE.Vector3(rx, 0, -ry);
  }

  /**
   * CSS2DObject listens for `removed` and drops its div from the label layer.
   * Removing only the parent Group does not fire that on children — orphans stay
   * in the DOM (duplicates + frozen tags when toggling 2D/3D and rebuildTrack).
   */
  function releaseCarRoot(root) {
    const label = root.userData.label;
    if (label) {
      root.remove(label);
      root.userData.label = null;
    }
    releaseCarRings(root);
    const mesh = root.userData.mesh;
    if (mesh) {
      root.remove(mesh);
      if (mesh.userData.geomSource === 'gltf') {
        disposeObject3D(mesh);
      } else {
        if (mesh.userData.ownsGeometry && mesh.geometry)
          mesh.geometry.dispose();
        mesh.material?.dispose();
      }
      root.userData.mesh = null;
    }
    carGroup.remove(root);
  }

  function disposeCarMeshes() {
    for (const g of carMeshes.values()) {
      releaseCarRoot(g);
    }
    carMeshes.clear();
  }

  /**
   * STL → Y-up, unit-sized, centered on XZ, bottom at y=0 (clone for each car).
   * @param {THREE.BufferGeometry} geom
   */
  function prepareCarStlTemplate(geom) {
    if (CAR_STL_ROTATE_X !== 0) geom.rotateX(CAR_STL_ROTATE_X);
    geom.computeBoundingBox();
    const bb = geom.boundingBox;
    if (!bb) return;
    const sx = bb.max.x - bb.min.x;
    const sy = bb.max.y - bb.min.y;
    const sz = bb.max.z - bb.min.z;
    const maxDim = Math.max(sx, sy, sz, 1e-8);
    const inv = 1 / maxDim;
    geom.scale(inv, inv, inv);
    geom.computeBoundingBox();
    const b2 = geom.boundingBox;
    if (!b2) return;
    const cx = (b2.min.x + b2.max.x) * 0.5;
    const cz = (b2.min.z + b2.max.z) * 0.5;
    geom.translate(-cx, -b2.min.y, -cz);
    geom.computeVertexNormals();
  }

  /** Prepared `simplify_car.stl` axis lengths in unit space (same proportions as the default car). */
  function getBaseCarUnitBoundingSize() {
    if (!carStlMaster) return null;
    carStlMaster.computeBoundingBox();
    const bb = carStlMaster.boundingBox;
    if (!bb) return null;
    return new THREE.Vector3(
      Math.max(bb.max.x - bb.min.x, 1e-8),
      Math.max(bb.max.y - bb.min.y, 1e-8),
      Math.max(bb.max.z - bb.min.z, 1e-8),
    );
  }

  const _meshBoundsTmp = new THREE.Box3();

  /**
   * Union of each mesh’s world-space AABB (more stable than `Box3.setFromObject` for nested GLBs /
   * skinned meshes — a too-small box made `ref/maxSz` huge and cars gigantic).
   */
  function computeMeshGroupBounds(group) {
    group.updateMatrixWorld(true);
    const box = new THREE.Box3();
    box.makeEmpty();
    let any = false;
    group.traverse((obj) => {
      if (!obj.isMesh && !obj.isSkinnedMesh) return;
      const geom = obj.geometry;
      if (!geom) return;
      geom.computeBoundingBox();
      const bb = geom.boundingBox;
      if (!bb) return;
      _meshBoundsTmp.copy(bb);
      _meshBoundsTmp.applyMatrix4(obj.matrixWorld);
      if (!any) {
        box.copy(_meshBoundsTmp);
        any = true;
      } else {
        box.union(_meshBoundsTmp);
      }
    });
    return any && !box.isEmpty() ? box : null;
  }

  /** Per-axis max of mesh-union vs scene AABB size (avoids one path reporting a tiny axis). */
  function getPreparedGroupAabbSize(group) {
    const meshBox = computeMeshGroupBounds(group);
    const objBox = new THREE.Box3().setFromObject(group);
    const sm = new THREE.Vector3();
    const so = new THREE.Vector3();
    if (meshBox) meshBox.getSize(sm);
    else sm.set(0, 0, 0);
    objBox.getSize(so);
    return new THREE.Vector3(
      Math.max(sm.x, so.x, 1e-8),
      Math.max(sm.y, so.y, 1e-8),
      Math.max(sm.z, so.z, 1e-8),
    );
  }

  /**
   * Normalize team GLB group to **unit scale** — identical pipeline to the STL
   * (prepareCarStlTemplate scales geometry to maxDim=1). This means setScalar(carCubeSize)
   * works the same way for both STL and GLB cars.
   *
   * The previous approach computed a scale relative to the STL ref bounds and left it on the
   * group, but every call site then did group.scale.setScalar(carCubeSize) which silently
   * overwrote that value — making all team cars render at full carCubeSize regardless of their
   * source geometry dimensions.
   *
   * Steps: apply orientation constants → measure AABB → scale so maxDim=1 →
   * center on XZ → lift to y=0 → apply CAR_TEAM_MODEL_SCALE_MULTIPLIER.
   */
  function prepareCarGroupTemplate(group, slug) {
    // group.position.set(0, 0, 0);
    group.scale.set(1, 1, 1);
    const cfg = (slug && TEAM_MODEL_ORIENTATION[slug]) || {};
    const rx = cfg.x ?? CAR_TEAM_MODEL_ROTATE_X;
    const ry = cfg.y ?? CAR_TEAM_MODEL_ROTATE_Y;
    const rz = cfg.z ?? CAR_TEAM_MODEL_ROTATE_Z;
    const liftYFrac = typeof cfg.liftY === 'number' ? cfg.liftY : 0;
    group.rotation.set(rx, ry, rz, 'YXZ');
    group.updateMatrixWorld(true);

    // const g = tpl.clone(true);
    // g.position.set(0, 0, 0); // ← this wipes the centering position
    // g.scale.setScalar((g.userData.unitScale || 1) * carCubeSize);

    // Measure raw size with orientation applied but scale still 1
    const size = getPreparedGroupAabbSize(group);
    const maxDim = Math.max(size.x, size.y, size.z, 1e-8);

    // Normalize to unit max dimension, then apply the per-team multiplier.
    // After this the group sits in the same ~unit AABB as the STL master, so
    // every setScalar(carCubeSize) call sizes it correctly.
    const k = (1 / maxDim) * CAR_TEAM_MODEL_SCALE_MULTIPLIER;
    group.scale.setScalar(k);
    // Store so clones can recover the unit scale even after setScalar(carCubeSize) is called.
    group.userData.unitScale = k;
    group.updateMatrixWorld(true);

    // Center on XZ
    let box2 = computeMeshGroupBounds(group);
    if (!box2) box2 = new THREE.Box3().setFromObject(group);
    const center = new THREE.Vector3();
    box2.getCenter(center);
    group.position.x -= center.x;
    group.position.z -= center.z;

    // Lift so bottom sits at y=0
    let box3 = computeMeshGroupBounds(group);
    if (!box3) box3 = new THREE.Box3().setFromObject(group);
    group.position.y -= box3.min.y;
    group.userData.liftYFraction = liftYFrac;
  }

  /** Vertical offset for team GLBs: liftYFraction * carCubeSize * leaderMul (world Y). */
  function applyTeamGltfVerticalLift(mesh, leaderMul) {
    if (mesh.userData.geomSource !== 'gltf') return;
    const frac = mesh.userData.liftYFraction ?? 0;
    const lm = leaderMul ?? 1;
    mesh.position.y = frac * carCubeSize * lm;
  }

  function disposeObject3D(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          if (m.normalMap) m.normalMap.dispose();
          if (m.roughnessMap) m.roughnessMap.dispose();
          if (m.metalnessMap) m.metalnessMap.dispose();
          if (m.aoMap) m.aoMap.dispose();
          if (m.emissiveMap) m.emissiveMap.dispose();
          m.dispose();
        }
      }
    });
  }

  function clearTeamModelTemplates() {
    for (const g of teamModelTemplates.values()) {
      disposeObject3D(g);
    }
    teamModelTemplates.clear();
    teamModelLoadPromises.clear();
  }

  function upgradePlaceholdersToStl() {
    for (const [code, root] of carMeshes.entries()) {
      const mesh = root.userData.mesh;
      if (!mesh || mesh.userData.geomSource !== 'box') continue;
      const slug = code !== '__SC__' ? getTeamSlugForDriver(code) : null;
      const tpl = slug ? teamModelTemplates.get(slug) : null;
      if (slug && tpl) {
        root.remove(mesh);
        if (mesh.userData.ownsGeometry && mesh.geometry)
          mesh.geometry.dispose();
        mesh.material?.dispose();
        const g = tpl.clone(true);
        g.userData.geomSource = 'gltf';
        g.userData.geomVariant = 'team';
        g.userData.teamSlug = slug;
        // g.position.set(0, 0, 0);
        g.scale.setScalar((g.userData.unitScale || 1) * carCubeSize);
        applyTeamGltfVerticalLift(g, 1);
        root.add(g);
        root.userData.mesh = g;
        continue;
      }
      if (!carStlMaster) continue;
      if (mesh.userData.ownsGeometry && mesh.geometry) mesh.geometry.dispose();
      mesh.geometry = carStlMaster.clone();
      mesh.userData.geomSource = 'stl';
      mesh.userData.geomVariant = 'default';
      mesh.userData.ownsGeometry = true;
      mesh.position.set(0, 0, 0);
      if (code === '__SC__') {
        mesh.scale.setScalar(carCubeSize * 1.35);
      } else {
        mesh.scale.setScalar(carCubeSize);
      }
    }
  }

  function upgradeDefaultStlToTeamModels() {
    for (const [code, root] of carMeshes.entries()) {
      if (code === '__SC__') continue;
      const slug = getTeamSlugForDriver(code);
      const tpl = slug ? teamModelTemplates.get(slug) : null;
      if (!slug || !tpl) continue;
      const mesh = root.userData.mesh;
      if (!mesh) continue;
      if (
        mesh.userData.geomSource === 'gltf' &&
        mesh.userData.geomVariant === 'team' &&
        mesh.userData.teamSlug === slug
      ) {
        continue;
      }
      if (mesh.userData.geomSource !== 'stl') continue;
      root.remove(mesh);
      if (mesh.userData.ownsGeometry && mesh.geometry) mesh.geometry.dispose();
      mesh.material?.dispose();
      const g = tpl.clone(true);
      g.userData.geomSource = 'gltf';
      g.userData.geomVariant = 'team';
      g.userData.teamSlug = slug;
      // g.position.set(0, 0, 0);
      g.scale.setScalar((g.userData.unitScale || 1) * carCubeSize);
      applyTeamGltfVerticalLift(g, 1);
      root.add(g);
      root.userData.mesh = g;
    }
  }

  function afterAnyStlLoad() {
    upgradePlaceholdersToStl();
    upgradeDefaultStlToTeamModels();
  }

  function loadCarStlOnce() {
    if (carStlLoadPromise) return carStlLoadPromise;
    carStlLoadPromise = (async () => {
      const loader = new STLLoader();
      let buf = null;
      const tried = carStlFetchUrls();
      for (const url of tried) {
        try {
          const res = await fetch(url, _NGROK_FETCH_INIT);
          if (res.ok) {
            buf = await res.arrayBuffer();
            break;
          }
          console.debug('[view3d] simplify_car.stl', url, '→', res.status);
        } catch (err) {
          console.debug('[view3d] simplify_car.stl fetch error', url, err);
        }
      }
      if (!buf) {
        console.warn(
          '[view3d] Could not fetch simplify_car.stl — tried:',
          tried,
          '(put frontend/simplify_car.stl and open the app over http, not file://)',
        );
        carStlMaster = null;
        return;
      }
      try {
        const geometry = loader.parse(buf);
        const n = geometry.attributes.position?.count ?? 0;
        if (n < 9) {
          console.warn(
            '[view3d] simplify_car.stl parsed but has too few vertices:',
            n,
          );
          carStlMaster = null;
          return;
        }
        prepareCarStlTemplate(geometry);
        carStlMaster = geometry;
        console.info(
          '[view3d] simplify_car.stl OK —',
          n,
          'vertices (per-car clones)',
        );
        afterAnyStlLoad();
      } catch (e) {
        console.warn('[view3d] Failed to parse simplify_car.stl:', e);
        carStlMaster = null;
      }
    })();
    return carStlLoadPromise;
  }

  /**
   * Loads `./models/{slug}.glb`. No successful load → template stays unset; car uses default STL/box.
   * @param {string} slug
   */
  function loadTeamModelFile(slug) {
    if (!slug || typeof slug !== 'string') return Promise.resolve();
    if (!TEAM_MODEL_ASSET_SLUGS.has(slug)) return Promise.resolve();
    if (teamModelTemplates.has(slug)) return Promise.resolve();
    const existing = teamModelLoadPromises.get(slug);
    if (existing) return existing;

    const p = (async () => {
      try {
        await loadCarStlOnce();
        const gltfLoader = new GLTFLoader();
        const tried = teamModelUrlsForSlug(slug);

        function tryFinalizeGroup(group, label) {
          let n = 0;
          group.traverse((o) => {
            if (o.isMesh && o.geometry?.attributes?.position)
              n += o.geometry.attributes.position.count;
          });
          if (n < 9) return false;
          prepareCarGroupTemplate(group, slug);
          teamModelTemplates.set(slug, group);
          console.info(
            '[view3d] Team model OK —',
            slug,
            n,
            'vertex rows (materials preserved)',
            label,
          );
          afterAnyStlLoad();
          return true;
        }

        for (const { url } of tried) {
          try {
            const res = await fetch(url, _NGROK_FETCH_INIT);
            if (!res.ok) continue;
            const buf = await res.arrayBuffer();
            const basePath = teamModelUrlBase(url);
            const gltf =
              typeof gltfLoader.parseAsync === 'function'
                ? await gltfLoader.parseAsync(buf, basePath)
                : await new Promise((resolve, reject) => {
                    gltfLoader.parse(buf, basePath, resolve, reject);
                  });
            if (tryFinalizeGroup(gltf.scene, `${slug}.glb`)) return;
          } catch {
            /* missing file or parse error — silent (no GLTFLoader.loadAsync / XHR 404 spam) */
          }
        }
      } finally {
        teamModelLoadPromises.delete(slug);
      }
    })();

    teamModelLoadPromises.set(slug, p);
    return p;
  }

  void loadCarStlOnce().catch(() => {
    /* ignore */
  });

  function steeringWheelFetchUrls() {
    const out = [];
    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : '';
    if (
      origin &&
      (origin.startsWith('http://') || origin.startsWith('https://'))
    ) {
      out.push(new URL('/models/steering_wheel.glb', origin).href);
    }
    try {
      const meta = import.meta.url;
      if (meta && !String(meta).startsWith('blob:')) {
        const u = new URL('./models/steering_wheel.glb', meta).href;
        if (!out.includes(u)) out.push(u);
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  function loadSteeringWheelOnce() {
    if (steeringWheelLoadPromise) return steeringWheelLoadPromise;
    steeringWheelLoadPromise = (async () => {
      try {
        const gltfLoader = new GLTFLoader();
        for (const url of steeringWheelFetchUrls()) {
          try {
            const res = await fetch(url, _NGROK_FETCH_INIT);
            if (!res.ok) continue;
            const buf = await res.arrayBuffer();
            const i = url.lastIndexOf('/');
            const basePath = i === -1 ? '' : url.slice(0, i + 1);
            const gltf =
              typeof gltfLoader.parseAsync === 'function'
                ? await gltfLoader.parseAsync(buf, basePath)
                : await new Promise((resolve, reject) => {
                    gltfLoader.parse(buf, basePath, resolve, reject);
                  });
            const root = gltf.scene;
            const box = new THREE.Box3().setFromObject(root);
            if (box.isEmpty()) {
              console.warn(
                '[view3d] steering_wheel.glb: empty bounding box —',
                url,
              );
              continue;
            }
            const center = new THREE.Vector3();
            box.getCenter(center);
            root.position.sub(center);
            const box2 = new THREE.Box3().setFromObject(root);
            const size = new THREE.Vector3();
            box2.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
            const targetSize = 0.95;
            steeringWheelModelFitScale = targetSize / maxDim;
            root.scale.setScalar(
              steeringWheelModelFitScale * STEERING_WHEEL_USER_SCALE,
            );
            const box3 = new THREE.Box3().setFromObject(root);
            const c2 = new THREE.Vector3();
            box3.getCenter(c2);
            root.position.sub(c2);
            root.rotation.set(
              STEERING_WHEEL_ROT_X,
              STEERING_WHEEL_ROT_Y,
              STEERING_WHEEL_ROT_Z,
            );
            root.traverse((o) => {
              if (o.isMesh) {
                o.frustumCulled = false;
                if (o.material) {
                  const mats = Array.isArray(o.material)
                    ? o.material
                    : [o.material];
                  for (const m of mats) {
                    m.side = THREE.DoubleSide;
                    m.needsUpdate = true;
                  }
                }
              }
            });
            steeringWheelPivot.add(root);
            steeringWheelModel = root;
            console.info('[view3d] steering_wheel.glb OK');
            return;
          } catch (err) {
            console.warn('[view3d] steering_wheel.glb failed:', url, err);
          }
        }
        console.warn(
          '[view3d] steering_wheel.glb not loaded — tried:',
          steeringWheelFetchUrls(),
        );
      } catch (e) {
        console.warn('[view3d] steering_wheel.glb:', e);
      }
    })();
    return steeringWheelLoadPromise;
  }

  /**
   * Restore camera-local offset only if it was saved for the same defaults revision.
   * Older keys (v1/v2) and JSON without matching defaultsRev are ignored so values
   * you set in steeringWheelTuneDefaults() actually apply after a reload.
   */
  function initSteeringWheelTuneFromStorage() {
    try {
      const raw = localStorage.getItem(STEERING_WHEEL_TUNE_STORAGE_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return;
      if (o.defaultsRev !== STEERING_WHEEL_TUNE_DEFAULTS_REV) return;
      if (typeof o.posX === 'number') steeringWheelTune.posX = o.posX;
      if (typeof o.posY === 'number') steeringWheelTune.posY = o.posY;
      if (typeof o.posZ === 'number') steeringWheelTune.posZ = o.posZ;
    } catch {
      /* ignore */
    }
  }

  initSteeringWheelTuneFromStorage();
  void loadSteeringWheelOnce();

  /**
   * Each car owns its geometry (STL clone or box) so WebGL draws every instance correctly.
   * @param {'driver' | 'sc'} kind
   * @param {string} [driverCode] Abbreviation — team model from `driver_teams` + `./models/{slug}.glb` if loaded.
   */
  function createCarGeometry(kind, driverCode) {
    if (kind === 'sc') {
      if (carStlMaster) {
        return {
          geometry: carStlMaster.clone(),
          source: 'stl',
          shared: false,
          variant: 'default',
        };
      }
      return {
        geometry: new THREE.BoxGeometry(
          carCubeSize * 1.4,
          carCubeSize * 0.9,
          carCubeSize * 1.6,
        ),
        source: 'box',
        shared: false,
      };
    }
    const slug = getTeamSlugForDriver(driverCode);
    const tpl = slug ? teamModelTemplates.get(slug) : null;
    if (slug && tpl) {
      return {
        group: tpl.clone(true),
        source: 'gltf',
        shared: false,
        variant: 'team',
        teamSlug: slug,
      };
    }
    if (carStlMaster) {
      return {
        geometry: carStlMaster.clone(),
        source: 'stl',
        shared: false,
        variant: 'default',
      };
    }
    return {
      geometry: new THREE.BoxGeometry(
        carCubeSize,
        carCubeSize * 0.65,
        carCubeSize * 1.15,
      ),
      source: 'box',
      shared: false,
    };
  }

  /**
   * Heading from path motion (use blended telemetry x/z, not smoothed mesh position — avoids lag
   * oscillation in corners). Optional `speedMps` tightens smoothing at high speed (accurate turn-in).
   */
  function updateHeadingFromMotion(root, worldX, worldZ, speedMps) {
    const prev = root.userData.prevXZ;
    const lastMeshYaw = root.userData.lastYaw ?? 0;
    /** Path / velocity yaw only (no RB mesh offset). */
    let pathYaw = root.userData.motionYaw;
    if (prev) {
      const dx = worldX - prev.x;
      const dz = worldZ - prev.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > YAW_MIN_DIST_SQ_M) {
        pathYaw = Math.atan2(dx, dz) + CAR_STL_YAW_OFFSET;
        root.userData.motionYaw = pathYaw;
      }
    }
    if (pathYaw === undefined || pathYaw === null) {
      const mesh = root.userData.mesh;
      const extra = teamMeshHeadingExtraYaw(mesh?.userData?.teamSlug);
      if (mesh?.userData?.geomSource === 'gltf' && extra) {
        pathYaw = lastMeshYaw - extra;
      } else {
        pathYaw = lastMeshYaw;
      }
    }
    root.userData.prevXZ = { x: worldX, z: worldZ };
    const sp = Number(speedMps);
    const yawT = Number.isFinite(sp)
      ? Math.min(
          YAW_LERP_MAX,
          YAW_LERP_MIN +
            Math.min(1, Math.max(0, (sp - 4) / 70)) *
              (YAW_LERP_MAX - YAW_LERP_MIN),
        )
      : (YAW_LERP_MIN + YAW_LERP_MAX) * 0.5;
    const mesh = root.userData.mesh;
    if (mesh) {
      let headingTarget = pathYaw;
      const extra = teamMeshHeadingExtraYaw(mesh.userData.teamSlug);
      if (mesh.userData.geomSource === 'gltf' && extra) {
        headingTarget = pathYaw + extra;
      }
      const yaw = lerpAngleShortest(mesh.rotation.y, headingTarget, yawT);
      root.userData.lastYaw = yaw;
      mesh.rotation.y = yaw;
    } else {
      root.userData.lastYaw = pathYaw;
    }
  }

  function driverTagText(code) {
    return String(code).toUpperCase().trim().slice(0, 3);
  }

  /**
   * @param {string} code
   * @param {boolean} isLeader
   * @param {boolean} isSel
   */
  function syncLabelDom(div, code, isLeader, isSel) {
    const tag = driverTagText(code);
    if (div.textContent !== tag) div.textContent = tag;
    div.classList.toggle('is-leader', !!isLeader);
    div.classList.toggle('is-selected', !!isSel);
  }

  function clearTrackLines() {
    while (trackGroup.children.length) {
      const o = trackGroup.children[0];
      trackGroup.remove(o);
      if (o.geometry) o.geometry.dispose();
      const mat = o.material;
      if (Array.isArray(mat)) {
        for (const m of mat) m.dispose();
      } else if (mat) {
        mat.dispose();
      }
    }
    trackAsphaltMap = null;
  }

  /**
   * @param {any} meta sessionMeta
   */
  function rebuildTrack(meta) {
    lastFrameUpdateTs = 0;
    lastMeta = meta;
    if (!meta?.track) {
      clearTrackLines();
      disposeCarMeshes();
      clearTeamModelTemplates();
      return;
    }
    const track = meta.track;
    const b = track.bounds;
    cx = (b.x_min + b.x_max) / 2;
    cy = (b.y_min + b.y_max) / 2;
    rotRad =
      (((meta.circuit_rotation || 0) + CIRCUIT_ROTATION_OFFSET_DEG) * Math.PI) /
      180;

    const w = Math.max(1, b.x_max - b.x_min);
    const h = Math.max(1, b.y_max - b.y_min);
    const diag = Math.hypot(w, h);
    carCubeSize = Math.max(6, Math.min(diag / 100, diag / 40));

    clearTrackLines();
    disposeCarMeshes();
    clearTeamModelTemplates();

    const xi = track.inner.x;
    const yi = track.inner.y;
    const xo = track.outer.x;
    const yo = track.outer.y;
    const nLoop = Math.min(xi.length, yi.length, xo.length, yo.length);

    const yAsphalt = 0.06;
    /** Fixed-length red/white stripes (world units), not one block per polyline edge. */
    const stripeLen = Math.max(3.6, Math.min(diag * 0.0062, 7.5));
    const kerbH = Math.max(0.09, stripeLen * 0.11);
    const kerbW = Math.max(1.15, stripeLen * 0.44);
    const uvMetersPerTile = Math.max(10, carCubeSize * 0.9);

    if (nLoop >= 3) {
      /**
       * Watertight strip: one inner + one outer vertex per index (shared between quads).
       * Per-segment flip logic + duplicate verts caused holes and wrong normals (back-face cull).
       */
      const positions = [];
      const uvs = [];
      const indices = [];
      let cumLen = 0;

      for (let i = 0; i < nLoop; i++) {
        const vi = toThreeVec(xi[i], yi[i]);
        const vo = toThreeVec(xo[i], yo[i]);
        vi.y = vo.y = yAsphalt;
        const u = cumLen / uvMetersPerTile;
        positions.push(vi.x, vi.y, vi.z, vo.x, vo.y, vo.z);
        uvs.push(u, 0, u, 1);
        const i1 = (i + 1) % nLoop;
        const vi1 = toThreeVec(xi[i1], yi[i1]);
        vi1.y = yAsphalt;
        cumLen += vi.distanceTo(vi1);
      }

      let flipWinding = false;
      if (nLoop >= 2) {
        const p0 = new THREE.Vector3(positions[0], positions[1], positions[2]);
        const pO = new THREE.Vector3(positions[3], positions[4], positions[5]);
        const vi = 3;
        const pO1 = new THREE.Vector3(
          positions[vi * 3],
          positions[vi * 3 + 1],
          positions[vi * 3 + 2],
        );
        const n0 = new THREE.Vector3()
          .subVectors(pO, p0)
          .cross(new THREE.Vector3().subVectors(pO1, p0));
        flipWinding = n0.y < 0;
      }

      for (let i = 0; i < nLoop; i++) {
        const i1 = (i + 1) % nLoop;
        const iIn = 2 * i;
        const oIn = 2 * i + 1;
        const iIn1 = 2 * i1;
        const oIn1 = 2 * i1 + 1;
        if (!flipWinding) {
          indices.push(iIn, oIn, oIn1, iIn, oIn1, iIn1);
        } else {
          indices.push(iIn, oIn1, oIn, iIn, iIn1, oIn1);
        }
      }

      const aGeom = new THREE.BufferGeometry();
      aGeom.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(positions, 3),
      );
      aGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      aGeom.setIndex(indices);
      aGeom.computeVertexNormals();

      trackAsphaltMap = createAsphaltNoiseTexture();
      const asphaltMat = new THREE.MeshStandardMaterial({
        map: trackAsphaltMap,
        color: 0xaeaeb2,
        roughness: 0.92,
        metalness: 0.05,
      });
      trackGroup.add(new THREE.Mesh(aGeom, asphaltMat));

      const kerbGeoms = [];
      const up = new THREE.Vector3(0, 1, 0);
      const kerbRed = 0xc91818;
      const kerbWhite = 0xefefef;

      /**
       * Cumulative arc length at each vertex along a closed polyline (telemetry x,y).
       */
      function arcStartsAtVertices(xs, ys) {
        const arc = new Float32Array(nLoop);
        let acc = 0;
        for (let i = 0; i < nLoop; i++) {
          arc[i] = acc;
          const i1 = (i + 1) % nLoop;
          const v = toThreeVec(xs[i], ys[i]);
          const v1 = toThreeVec(xs[i1], ys[i1]);
          v.y = v1.y = yAsphalt;
          acc += v.distanceTo(v1);
        }
        return { arc, total: acc };
      }

      const innerArc = arcStartsAtVertices(xi, yi);
      const outerArc = arcStartsAtVertices(xo, yo);
      const px = track.centerline?.x;
      const py = track.centerline?.y;
      const hasCenter = px && py && px.length >= nLoop && py.length >= nLoop;
      const centerArc = hasCenter ? arcStartsAtVertices(px, py) : null;

      /**
       * Kerb dashes along inner or outer edge: fixed stripeLen, color by arc / stripeLen.
       * Sub-segment tangent + grass at stripe midpoint so boxes follow the curve.
       * When centerline exists, stripe color uses centerline arc so inner/outer stay aligned.
       */
      function addKerbAlongEdge(edgeXs, edgeYs, innerEdge, edgeArc) {
        const { arc } = edgeArc;
        for (let i = 0; i < nLoop; i++) {
          const i1 = (i + 1) % nLoop;
          const p0 = toThreeVec(edgeXs[i], edgeYs[i]);
          const p1 = toThreeVec(edgeXs[i1], edgeYs[i1]);
          p0.y = p1.y = yAsphalt;
          const segLen = p0.distanceTo(p1);
          if (segLen < 1e-6) continue;

          const vi = toThreeVec(xi[i], yi[i]);
          const vo = toThreeVec(xo[i], yo[i]);
          const vi1 = toThreeVec(xi[i1], yi[i1]);
          const vo1 = toThreeVec(xo[i1], yo[i1]);

          let off = 0;
          while (off < segLen - 1e-7) {
            const piece = Math.min(stripeLen, segLen - off);
            const fracMid = (off + piece * 0.5) / segLen;
            const mid = p0.clone().lerp(p1, fracMid);

            const vvi = vi.clone().lerp(vi1, fracMid);
            const vvo = vo.clone().lerp(vo1, fracMid);
            const acrossMid = new THREE.Vector3().subVectors(vvo, vvi);
            if (acrossMid.lengthSq() < 1e-10) {
              off += piece;
              continue;
            }
            acrossMid.normalize();

            let grass = acrossMid.clone();
            if (innerEdge) grass.negate();
            const fracA = off / segLen;
            const fracB = (off + piece) / segLen;
            const pa = p0.clone().lerp(p1, fracA);
            const pb = p0.clone().lerp(p1, fracB);
            pa.y = pb.y = yAsphalt;
            const tangent = new THREE.Vector3().subVectors(pb, pa);
            const pieceLen = tangent.length();
            if (pieceLen < 1e-6) {
              off += piece;
              continue;
            }
            tangent.normalize();

            grass.sub(tangent.clone().multiplyScalar(grass.dot(tangent)));
            if (grass.lengthSq() < 1e-10) {
              off += piece;
              continue;
            }
            grass.normalize();

            const center = mid
              .clone()
              .add(grass.clone().multiplyScalar(kerbW * 0.5));
            center.y = kerbH * 0.5 + yAsphalt + 0.012;

            let zAxis = new THREE.Vector3()
              .crossVectors(tangent, up)
              .normalize();
            if (zAxis.dot(grass) < 0) zAxis.negate();

            const rotM = new THREE.Matrix4().makeBasis(tangent, up, zAxis);
            const quat = new THREE.Quaternion().setFromRotationMatrix(rotM);
            const m = new THREE.Matrix4();
            m.compose(
              center,
              quat,
              new THREE.Vector3(Math.max(pieceLen * 0.998, 0.35), kerbH, kerbW),
            );
            const box = new THREE.BoxGeometry(1, 1, 1);
            box.applyMatrix4(m);

            let colorArc = arc[i] + off + piece * 0.5;
            if (centerArc) {
              const ci = toThreeVec(px[i], py[i]);
              const ci1 = toThreeVec(px[i1], py[i1]);
              ci.y = ci1.y = yAsphalt;
              const cSegLen = ci.distanceTo(ci1);
              colorArc = centerArc.arc[i] + fracMid * cSegLen;
            }
            const colorHex =
              Math.floor(colorArc / stripeLen) % 2 === 0 ? kerbRed : kerbWhite;
            addVertexColorsToGeometry(box, colorHex);
            kerbGeoms.push(box);

            off += piece;
          }
        }
      }

      addKerbAlongEdge(xi, yi, true, innerArc);
      addKerbAlongEdge(xo, yo, false, outerArc);

      if (kerbGeoms.length > 0) {
        const mergedKerbs = mergeGeometries(kerbGeoms);
        for (const g of kerbGeoms) {
          g.dispose();
        }
        if (mergedKerbs) {
          const kerbMat = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.5,
            metalness: 0.1,
          });
          trackGroup.add(new THREE.Mesh(mergedKerbs, kerbMat));
        }
      }
    }

    for (const z of track.drs_zones || []) {
      const a = toThreeVec(z.start.x, z.start.y);
      const bpt = toThreeVec(z.end.x, z.end.y);
      a.y = bpt.y = 0.35;
      const geom = new THREE.BufferGeometry().setFromPoints([a, bpt]);
      const mat = new THREE.LineBasicMaterial({ color: 0x8899aa });
      trackGroup.add(new THREE.Line(geom, mat));
    }

    /** Checkered strip on the racing surface (start/finish). */
    const fl = finishLineFromTrack(track);
    if (fl?.start && fl?.end) {
      const yFl = 0.088;
      const s = toThreeVec(fl.start.x, fl.start.y);
      const e = toThreeVec(fl.end.x, fl.end.y);
      s.y = e.y = yFl;
      const dx = e.x - s.x;
      const dz = e.z - s.z;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len;
      const uz = dz / len;
      const px = -uz;
      const pz = ux;
      const halfW = Math.max(2.2, Math.min(5, len * 0.014));
      const stripes = Math.max(10, Math.min(28, Math.round(len / 12)));
      const seg = len / stripes;
      const flGeoms = [];
      for (let i = 0; i < stripes; i++) {
        const t0 = i * seg;
        const t1 = (i + 1) * seg;
        const ax = s.x + ux * t0 + px * halfW;
        const az = s.z + uz * t0 + pz * halfW;
        const bx = s.x + ux * t1 + px * halfW;
        const bz = s.z + uz * t1 + pz * halfW;
        const cx = s.x + ux * t1 - px * halfW;
        const cz = s.z + uz * t1 - pz * halfW;
        const dxw = s.x + ux * t0 - px * halfW;
        const dzw = s.z + uz * t0 - pz * halfW;
        const g = new THREE.BufferGeometry();
        const positions = new Float32Array([
          ax,
          yFl,
          az,
          bx,
          yFl,
          bz,
          cx,
          yFl,
          cz,
          ax,
          yFl,
          az,
          cx,
          yFl,
          cz,
          dxw,
          yFl,
          dzw,
        ]);
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        g.computeVertexNormals();
        addVertexColorsToGeometry(g, i % 2 === 0 ? 0xececec : 0x0c0c0c);
        flGeoms.push(g);
      }
      if (flGeoms.length > 0) {
        const mergedFl = mergeGeometries(flGeoms);
        for (const g of flGeoms) {
          g.dispose();
        }
        if (mergedFl) {
          const flMat = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.55,
            metalness: 0.08,
          });
          trackGroup.add(new THREE.Mesh(mergedFl, flMat));
        }
      }
      const edgeGeom = new THREE.BufferGeometry().setFromPoints([
        s.clone(),
        e.clone(),
      ]);
      trackGroup.add(
        new THREE.Line(
          edgeGeom,
          new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }),
        ),
      );
    }

    const dist = diag * 0.55;
    camera.position.set(cx + dist * 0.55, diag * 0.42, cy + dist * 0.55);
    controls.target.set(cx, 0, cy);
    /*
     * Do not force `near >= 1`: that clips the driver-view steering wheel when scaled
     * (surfaces end up closer than 1 m). Logarithmic depth keeps the track stable.
     */
    camera.near = Math.max(0.02, diag / 20000);
    camera.far = Math.max(diag * 80, 1e6);
    camera.updateProjectionMatrix();
    controls.update();

    const ww = wrapEl.clientWidth;
    const hh = wrapEl.clientHeight;
    if (ww >= 1 && hh >= 1) labelRenderer.setSize(ww, hh);
  }

  /**
   * @param {any} frame
   * @param {Record<string,string>} driverColors
   * @param {string | null} leaderCode
   * @param {string | null} selectedKey
   */
  function updateFrame(frame, driverColors, leaderCode, selectedKey) {
    const now = performance.now();
    const dt =
      lastFrameUpdateTs > 0
        ? Math.min(0.25, (now - lastFrameUpdateTs) / 1000)
        : 1 / 60;
    lastFrameUpdateTs = now;

    const drivers = frame?.drivers || {};
    const present = new Set();

    const sc = frame?.safety_car;
    if (sc && Number.isFinite(Number(sc.x))) {
      const code = '__SC__';
      present.add(code);
      let root = carMeshes.get(code);
      if (!root) {
        root = new THREE.Group();
        const { geometry, source, shared } = createCarGeometry('sc');
        const mat = new THREE.MeshStandardMaterial({
          color: 0xcccccc,
          metalness: 0.15,
          roughness: 0.5,
        });
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.userData.geomSource = source;
        mesh.userData.ownsGeometry = !shared;
        if (source === 'box') {
          mesh.position.set(0, carCubeSize * 0.35, 0);
          mesh.scale.setScalar(1);
        } else {
          mesh.position.set(0, 0, 0);
          mesh.scale.setScalar(carCubeSize * 1.35);
        }
        const div = document.createElement('div');
        div.className = 'driver-label-3d driver-label-3d--sc';
        div.textContent = 'SC';
        const lo = new CSS2DObject(div);
        lo.center.set(0.5, 1);
        lo.position.set(0, -carCubeSize * 0.55, 0);
        root.add(mesh);
        root.add(lo);
        root.userData.mesh = mesh;
        root.userData.label = lo;
        carGroup.add(root);
        carMeshes.set(code, root);
      }
      const wv = toThreeVec(sc.x, sc.y);
      updateHeadingFromMotion(root, wv.x, wv.z, undefined);
      smoothCarWorldPosition(root, wv.x, wv.y, wv.z, undefined, dt);
      const mesh = root.userData.mesh;
      if (mesh.userData.geomSource === 'stl') {
        mesh.scale.setScalar(carCubeSize * 1.35);
      }
    } else {
      const root = carMeshes.get('__SC__');
      if (root) {
        releaseCarRoot(root);
        carMeshes.delete('__SC__');
      }
    }

    for (const [code, pos] of Object.entries(drivers)) {
      if (!Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y)))
        continue;
      present.add(code);
      const teamSlug = getTeamSlugForDriver(code);
      if (teamSlug) void loadTeamModelFile(teamSlug).catch(() => {});
      let root = carMeshes.get(code);
      const hex = normalizeHex(driverColors[code] || '#ffffff');
      const col = new THREE.Color(hex);
      const isLeader = !!(leaderCode && code === leaderCode);
      const isSel = !!(selectedKey && code === selectedKey);
      if (!root) {
        root = new THREE.Group();
        const built = createCarGeometry('driver', code);
        if (built.source === 'gltf' && built.group) {
          const m = built.group;
          m.userData.geomSource = 'gltf';
          m.userData.geomVariant = 'team';
          if (built.teamSlug) m.userData.teamSlug = built.teamSlug;
          m.position.set(0, 0, 0);
          m.scale.setScalar((m.userData.unitScale || 1) * carCubeSize);
          applyTeamGltfVerticalLift(m, 1);
          root.add(m);
          root.userData.mesh = m;
        } else {
          const { geometry, source, shared, variant } = built;
          const mat = new THREE.MeshStandardMaterial({
            color: col,
            metalness: 0.2,
            roughness: 0.5,
            emissive: 0x000000,
            emissiveIntensity: 0,
          });
          const mesh = new THREE.Mesh(geometry, mat);
          mesh.userData.geomSource = source;
          mesh.userData.ownsGeometry = !shared;
          if (source === 'stl') {
            mesh.userData.geomVariant = variant ?? 'default';
          }
          if (source === 'box') {
            mesh.position.set(0, carCubeSize * 0.32, 0);
            mesh.scale.setScalar(1);
          } else {
            mesh.position.set(0, 0, 0);
            mesh.scale.setScalar(carCubeSize);
          }
          root.add(mesh);
          root.userData.mesh = mesh;
        }
        const div = document.createElement('div');
        div.className = 'driver-label-3d';
        const lo = new CSS2DObject(div);
        lo.center.set(0.5, 1);
        lo.position.set(0, -carCubeSize * 0.48, 0);
        root.add(lo);
        root.userData.label = lo;
        carGroup.add(root);
        carMeshes.set(code, root);
      }
      const mesh = root.userData.mesh;
      const label = root.userData.label;
      if (mesh.userData.geomSource !== 'gltf' && mesh.material) {
        mesh.material.color.copy(col);
        mesh.material.emissive.setHex(0x000000);
        mesh.material.emissiveIntensity = 0;
      }
      const leaderMul = isLeader ? 1.12 : 1;
      if (mesh.userData.geomSource === 'stl') {
        mesh.scale.setScalar(carCubeSize * leaderMul);
      } else if (mesh.userData.geomSource === 'gltf') {
        mesh.scale.setScalar(
          (mesh.userData.unitScale || 1) * carCubeSize * leaderMul,
        );
        applyTeamGltfVerticalLift(mesh, leaderMul);
      } else {
        mesh.scale.setScalar(leaderMul);
      }
      const refR = carCubeSize * 0.48 * leaderMul;
      const { gold, white } = ensureCarRings(root);
      const showRings = cameraMode !== 'driver_pov'; // cockpit view: no ground rings
      gold.visible = showRings && isLeader;
      white.visible = showRings && isSel;
      if (isLeader) {
        gold.scale.setScalar(refR * 1.06);
      } else {
        gold.scale.setScalar(1);
      }
      if (isSel) {
        const mul = isLeader && isSel ? 1.38 : 1.22;
        white.scale.setScalar(refR * mul);
      } else {
        white.scale.setScalar(1);
      }
      const wv = toThreeVec(pos.x, pos.y);
      updateHeadingFromMotion(root, wv.x, wv.z, pos.speed);
      smoothCarWorldPosition(root, wv.x, wv.y, wv.z, pos.speed, dt);
      syncLabelDom(label.element, code, isLeader, isSel);
    }

    for (const [code, root] of [...carMeshes.entries()]) {
      if (!present.has(code)) {
        releaseCarRoot(root);
        carMeshes.delete(code);
      }
    }

    lastCamFollowCode =
      selectedKey && Object.prototype.hasOwnProperty.call(drivers, selectedKey)
        ? selectedKey
        : null;
    syncControlsForCameraMode();
  }

  function setActive(on) {
    active = !!on;
    el.style.display = on ? 'block' : 'none';
    lrEl.style.display = on ? '' : 'none';
    if (!on) {
      controls.enabled = false;
    } else {
      syncControlsForCameraMode();
      if (controls.enabled) controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    }
  }

  function tick() {
    if (!active) return;
    if (isCameraDriverLocked()) {
      if (cameraMode === 'driver_pov') {
        applyDriverPovCamera(lastCamFollowCode);
      } else {
        applyFollowCamera(lastCamFollowCode);
      }
    } else {
      controls.update();
    }
    syncSteeringWheelToCamera();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  function resize(width, height) {
    if (width < 1 || height < 1) return;
    renderer.setSize(width, height, false);
    labelRenderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function dispose() {
    controls.dispose();
    if (steeringWheelModel) {
      steeringWheelPivot.remove(steeringWheelModel);
      disposeObject3D(steeringWheelModel);
      steeringWheelModel = null;
    }
    steeringWheelLoadPromise = null;
    clearTrackLines();
    disposeCarMeshes();
    if (carStlMaster) {
      carStlMaster.dispose();
      carStlMaster = null;
    }
    clearTeamModelTemplates();
    if (unitRingGeometry) {
      unitRingGeometry.dispose();
      unitRingGeometry = null;
    }
    scene.remove(steeringWheelPivot);
    renderer.dispose();
    lrEl.remove();
    el.remove();
  }

  return {
    setActive,
    tick,
    resize,
    rebuildTrack,
    updateFrame,
    setCameraMode,
    getCameraMode,
    dispose,
    get element() {
      return el;
    },
  };
}
