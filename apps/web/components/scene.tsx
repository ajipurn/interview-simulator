"use client";

/**
 * The whole 3D world. Architecture (walls/floors) stays primitive — it defines
 * the collision map; everything else is Kenney CC0: characters from "Mini
 * Characters" (public/models/mini, baked idle/walk/sit clips), furniture from
 * "Furniture Kit" (public/models/furniture). Third-person player (WASD/arrows,
 * E to sit); the interviewer nods along with the AI's live audio level.
 */
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type GamePhase = "lobby" | "explore" | "interview" | "scoring" | "report";

/** Screen-relative analog input from the touch joystick, -1..1 per axis. */
export interface StickState {
  x: number;
  z: number;
}

export const SPAWN = new THREE.Vector3(0, 0, 8.5);
/** Player chair — walking near it offers "sit", sitting starts the interview. */
export const SIT_POS = new THREE.Vector3(0, 0, -3.9);
const SIT_NEAR = 1.15;
const SPEED = 3.1;
const PLAYER_RADIUS = 0.3;
/** Chibi height — mini characters normalized to this. */
const CHAR_HEIGHT = 1.5;
/** Height of the chair seat — where a sitting character's origin lands. */
const SEAT_Y = 0.4;
/** Furniture Kit is authored at roughly half scale (desk 0.38 raw) — scale to meters. */
const FURN_SCALE = 1.95;
const DESK_TOP = 0.74;

const F = {
  desk: "/models/furniture/desk.glb",
  chair: "/models/furniture/chairDesk.glb",
  bookcase: "/models/furniture/bookcaseClosedWide.glb",
  plant: "/models/furniture/pottedPlant.glb",
  plantSmall: "/models/furniture/plantSmall2.glb",
  sofa: "/models/furniture/loungeSofa.glb",
  loungeChair: "/models/furniture/loungeChair.glb",
  tableCoffee: "/models/furniture/tableCoffee.glb",
  laptop: "/models/furniture/laptop.glb",
  books: "/models/furniture/books.glb",
  rug: "/models/furniture/rugRectangle.glb",
  rugRound: "/models/furniture/rugRound.glb",
  doormat: "/models/furniture/rugDoormat.glb",
};

// --- walkable space -----------------------------------------------------
// Two rects joined by the door gap; furniture blocks. Cheap and enough —
// ponytail: no navmesh/physics until the floor plan stops being two boxes.

const REGIONS: { x1: number; x2: number; z1: number; z2: number }[] = [
  { x1: -6.9, x2: 6.9, z1: 0.1, z2: 9.9 }, // open lobby (14×10)
  { x1: -4.4, x2: 4.4, z1: -6.9, z2: -0.1 }, // interview room (9×7)
  // door gap — must overlap both rooms by > 2×PLAYER_RADIUS or a dead zone forms
  { x1: -1.1, x2: 1.1, z1: -0.9, z2: 0.9 },
];

const BLOCKERS: { x1: number; x2: number; z1: number; z2: number }[] = [
  // interview room
  { x1: -1.0, x2: 1.0, z1: -6.4, z2: -4.4 }, // desk + interviewer chair
  { x1: -0.5, x2: 0.5, z1: -4.35, z2: -3.45 }, // player chair
  { x1: -3.9, x2: -2.1, z1: -7.0, z2: -6.3 }, // bookcase
  { x1: -4.3, x2: -3.7, z1: -6.8, z2: -6.2 }, // room plants
  { x1: 3.7, x2: 4.3, z1: -6.8, z2: -6.2 },
  // lobby: waiting corner (west)
  { x1: -6.4, x2: -5.4, z1: 3.4, z2: 5.6 }, // sofa west
  { x1: -2.6, x2: -1.6, z1: 3.4, z2: 5.6 }, // sofa east
  { x1: -4.5, x2: -3.5, z1: 4.0, z2: 5.0 }, // coffee table
  { x1: -4.6, x2: -3.4, z1: 5.9, z2: 6.7 }, // lounge chair
  // lobby: reception (east, near entrance) + shelf + plants
  { x1: 4.4, x2: 6.0, z1: 7.4, z2: 8.6 }, // reception desk
  { x1: 5.7, x2: 6.6, z1: 7.5, z2: 8.5 }, // reception chair
  { x1: 6.3, x2: 7.0, z1: 3.6, z2: 5.4 }, // lobby bookcase
  { x1: -6.8, x2: -6.2, z1: 0.3, z2: 0.9 },
  { x1: 6.2, x2: 6.8, z1: 0.3, z2: 0.9 },
  { x1: -6.8, x2: -6.2, z1: 9.1, z2: 9.7 },
  { x1: -2.2, x2: -1.6, z1: 0.2, z2: 0.8 }, // plants flanking the door
  { x1: 1.6, x2: 2.2, z1: 0.2, z2: 0.8 },
];

function canWalk(x: number, z: number): boolean {
  const r = PLAYER_RADIUS;
  const inRegion = REGIONS.some(
    (a) => x >= a.x1 + r && x <= a.x2 - r && z >= a.z1 + r && z <= a.z2 - r,
  );
  if (!inRegion) return false;
  return !BLOCKERS.some((b) => x > b.x1 - r && x < b.x2 + r && z > b.z1 - r && z < b.z2 + r);
}

// --- Kenney blocky characters -------------------------------------------

function useBlockyCharacter(url: string) {
  const gltf = useLoader(GLTFLoader, url);
  return useMemo(() => {
    const scene = gltf.scene;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (mat?.map) mat.map.magFilter = THREE.NearestFilter; // keep the palette crisp
      }
    });
    const box = new THREE.Box3().setFromObject(scene);
    const scale = CHAR_HEIGHT / Math.max(0.001, box.max.y - box.min.y);
    return { scene, animations: gltf.animations, scale };
  }, [gltf]);
}

function useClips(
  scene: THREE.Object3D,
  animations: THREE.AnimationClip[],
  names: readonly string[],
) {
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  const actions = useMemo(() => {
    const out = new Map<string, THREE.AnimationAction>();
    for (const n of names) {
      const clip = THREE.AnimationClip.findByName(animations, n);
      if (clip) out.set(n, mixer.clipAction(clip));
    }
    return out;
  }, [mixer, animations, names]);
  const current = useRef<THREE.AnimationAction | null>(null);
  const play = (name: string) => {
    const next = actions.get(name);
    if (!next || current.current === next) return;
    next.reset().fadeIn(0.15).play();
    current.current?.fadeOut(0.15);
    current.current = next;
  };
  return { mixer, play };
}

/**
 * One Furniture Kit piece. Kit origins sit at a corner, not the center —
 * recenter x/z on load so `position` means "center of the piece on the floor".
 * Clones the cached scene, so the same URL can be placed many times.
 */
function Furn({
  url,
  position,
  rotY = 0,
  scale = FURN_SCALE,
}: {
  url: string;
  position: [number, number, number];
  rotY?: number;
  scale?: number;
}) {
  const gltf = useLoader(GLTFLoader, url);
  const obj = useMemo(() => {
    const c = gltf.scene.clone(true);
    c.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    const box = new THREE.Box3().setFromObject(c);
    c.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    const wrap = new THREE.Group();
    wrap.add(c);
    return wrap;
  }, [gltf]);
  return <primitive object={obj} position={position} rotation={[0, rotY, 0]} scale={scale} />;
}

// --- office props --------------------------------------------------------

const STUB_H = 0.35;

/** `stub` = dollhouse cut: camera-side walls shrink to a low ledge so the interior stays visible. */
function Wall({
  position,
  size,
  color = "#e8e4da",
  stub = false,
}: {
  position: [number, number, number];
  size: [number, number, number];
  color?: string;
  stub?: boolean;
}) {
  const [w, h, d] = size;
  return (
    <mesh position={[position[0], stub ? STUB_H / 2 : position[1], position[2]]} receiveShadow castShadow>
      <boxGeometry args={[w, stub ? STUB_H : h, d]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

function CeilingLamp({ x, z, showFixture }: { x: number; z: number; showFixture: boolean }) {
  return (
    <group position={[x, 2.95, z]}>
      {showFixture && (
        <mesh>
          <boxGeometry args={[1.1, 0.06, 0.4]} />
          <meshStandardMaterial color="#ffffff" emissive="#fff7e0" emissiveIntensity={1.6} />
        </mesh>
      )}
      <pointLight intensity={6} distance={7} decay={2} color="#fff2d0" />
    </group>
  );
}

/** Where the clickable wall poster points. Swap the texture by editing makePosterTexture. */
const POSTER_URL = "https://kenney.nl";

function makePosterTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 340;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#171c26";
    g.fillRect(0, 0, 512, 340);
    g.strokeStyle = "#4a86c9";
    g.lineWidth = 14;
    g.strokeRect(7, 7, 498, 326);
    g.fillStyle = "#e8e6e1";
    g.font = "bold 44px monospace";
    g.textAlign = "center";
    g.fillText("INTERVIEW", 256, 110);
    g.fillText("SIMULATOR", 256, 160);
    g.fillStyle = "#7fb0e8";
    g.font = "28px monospace";
    g.fillText("assets: kenney.nl", 256, 230);
    g.fillStyle = "#6ad08a";
    g.font = "24px monospace";
    g.fillText("[ klik untuk buka ]", 256, 290);
  }
  return new THREE.CanvasTexture(c);
}

/** Wall art that opens a URL when clicked; glows + cursor on hover. */
function Poster({ position, url }: { position: [number, number, number]; url: string }) {
  const tex = useMemo(makePosterTexture, []);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    document.body.style.cursor = hover ? "pointer" : "auto";
    return () => {
      document.body.style.cursor = "auto";
    };
  }, [hover]);
  return (
    <mesh
      position={position}
      scale={hover ? 1.06 : 1}
      onClick={(e) => {
        e.stopPropagation();
        window.open(url, "_blank", "noopener,noreferrer");
      }}
      onPointerOver={() => setHover(true)}
      onPointerOut={() => setHover(false)}
    >
      <planeGeometry args={[1.5, 1.0]} />
      <meshStandardMaterial
        map={tex}
        emissive={hover ? "#3a4b66" : "#000000"}
        emissiveIntensity={0.8}
      />
    </mesh>
  );
}

function Painting({ x, z, rotY, color }: { x: number; z: number; rotY: number; color: string }) {
  return (
    <mesh position={[x, 1.7, z]} rotation={[0, rotY, 0]}>
      <planeGeometry args={[0.9, 0.6]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

/** `dollhouse` = helicopter view: no ceiling/lamp fixtures so the camera sees inside. */
function Office({ dollhouse }: { dollhouse: boolean }) {
  return (
    <group>
      {/* floors: lobby wood + interview-room carpet */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 5]} receiveShadow>
        <planeGeometry args={[14, 10]} />
        <meshStandardMaterial color="#a8895f" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, -3.5]} receiveShadow>
        <planeGeometry args={[9, 7]} />
        <meshStandardMaterial color="#31465f" />
      </mesh>
      {/* ceiling — hidden in helicopter view */}
      {!dollhouse && (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 3, 1.5]}>
          <planeGeometry args={[15, 18]} />
          <meshStandardMaterial color="#f4f1ea" />
        </mesh>
      )}

      {/* lobby shell (14×10, z 0..10); south + east walls face the helicopter camera */}
      <Wall position={[-7, 1.5, 5]} size={[0.15, 3, 10.15]} stub={dollhouse} />
      <Wall position={[7, 1.5, 5]} size={[0.15, 3, 10.15]} stub={dollhouse} />
      <Wall position={[0, 1.5, 10]} size={[14.15, 3, 0.15]} stub={dollhouse} />

      {/* interview room shell (9×7, z -7..0); east + front walls face the camera */}
      <Wall position={[0, 1.5, -7]} size={[9.15, 3, 0.15]} stub={dollhouse} />
      <Wall position={[-4.5, 1.5, -3.5]} size={[0.15, 3, 7.15]} stub={dollhouse} />
      <Wall position={[4.5, 1.5, -3.5]} size={[0.15, 3, 7.15]} stub={dollhouse} />
      {/* front wall with a centered door gap (±1.2) */}
      <Wall position={[-4.1, 1.5, 0]} size={[5.8, 3, 0.15]} stub={dollhouse} />
      <Wall position={[4.1, 1.5, 0]} size={[5.8, 3, 0.15]} stub={dollhouse} />
      {!dollhouse && <Wall position={[0, 2.75, 0]} size={[2.4, 0.5, 0.15]} />}

      {/* wall decor lives on full-height walls only — orbiting camera means any
          wall can be a stub in dollhouse view, so hide it all there */}
      {!dollhouse && (
        <>
          <Painting x={-1.8} z={-6.92} rotY={0} color="#c9a84a" />
          <Poster position={[1.8, 1.7, -6.91]} url={POSTER_URL} />
          <Painting x={-6.92} z={1.5} rotY={Math.PI / 2} color="#c96f4a" />
          {[3, 7].map((z) => (
            <mesh key={z} position={[-6.92, 1.6, z]} rotation={[0, Math.PI / 2, 0]}>
              <planeGeometry args={[2.6, 1.5]} />
              <meshStandardMaterial color="#bcd6ef" emissive="#9fc4e8" emissiveIntensity={0.9} />
            </mesh>
          ))}
          <mesh position={[-4.42, 1.6, -3.5]} rotation={[0, Math.PI / 2, 0]}>
            <planeGeometry args={[2.6, 1.5]} />
            <meshStandardMaterial color="#bcd6ef" emissive="#9fc4e8" emissiveIntensity={0.9} />
          </mesh>
        </>
      )}

      {/* interview room furniture */}
      <Furn url={F.rug} position={[0, 0.006, -4.6]} />
      <Furn url={F.desk} position={[0, 0, -5]} />
      <Furn url={F.chair} position={[0, 0, -5.9]} />
      <Furn url={F.chair} position={[0, 0, -3.9]} rotY={Math.PI} />
      <Furn url={F.laptop} position={[0.35, DESK_TOP, -5]} rotY={Math.PI} scale={FURN_SCALE * 0.55} />
      <Furn url={F.books} position={[-0.5, DESK_TOP, -5.05]} rotY={0.4} />
      <Furn url={F.bookcase} position={[-3, 0, -6.65]} />
      <Furn url={F.plantSmall} position={[-3, 1.55, -6.65]} />
      <Furn url={F.plant} position={[-4, 0, -6.5]} />
      <Furn url={F.plant} position={[4, 0, -6.5]} />

      {/* lobby: waiting corner (west) */}
      <Furn url={F.rugRound} position={[-4, 0.006, 4.5]} scale={FURN_SCALE * 1.2} />
      <Furn url={F.sofa} position={[-5.9, 0, 4.5]} rotY={Math.PI / 2} />
      <Furn url={F.sofa} position={[-2.1, 0, 4.5]} rotY={-Math.PI / 2} />
      <Furn url={F.loungeChair} position={[-4, 0, 6.3]} rotY={Math.PI} />
      <Furn url={F.tableCoffee} position={[-4, 0, 4.5]} />
      <Furn url={F.books} position={[-4, 0.36, 4.5]} rotY={1.1} />

      {/* lobby: reception near the entrance (east) */}
      <Furn url={F.desk} position={[5.2, 0, 8]} rotY={-Math.PI / 2} />
      <Furn url={F.chair} position={[6.1, 0, 8]} rotY={-Math.PI / 2} />
      <Furn url={F.laptop} position={[5.2, DESK_TOP, 8]} rotY={Math.PI / 2} scale={FURN_SCALE * 0.55} />
      <Furn url={F.bookcase} position={[6.68, 0, 4.5]} rotY={-Math.PI / 2} />
      <Furn url={F.doormat} position={[0, 0.006, 9.2]} />

      {/* plants around the lobby */}
      <Furn url={F.plant} position={[-6.5, 0, 0.6]} />
      <Furn url={F.plant} position={[6.5, 0, 0.6]} />
      <Furn url={F.plant} position={[-6.5, 0, 9.4]} />
      <Furn url={F.plant} position={[-1.9, 0, 0.5]} />
      <Furn url={F.plant} position={[1.9, 0, 0.5]} />

      <CeilingLamp x={0} z={-2.3} showFixture={!dollhouse} />
      <CeilingLamp x={0} z={-5.2} showFixture={!dollhouse} />
      <CeilingLamp x={-3.5} z={2.5} showFixture={!dollhouse} />
      <CeilingLamp x={3.5} z={2.5} showFixture={!dollhouse} />
      <CeilingLamp x={-3.5} z={7} showFixture={!dollhouse} />
      <CeilingLamp x={3.5} z={7} showFixture={!dollhouse} />
    </group>
  );
}

// --- characters ---------------------------------------------------------

const INTERVIEWER_CLIPS = ["sit"] as const;

function Interviewer({ aiLevel }: { aiLevel: { current: number } }) {
  const { scene, animations, scale } = useBlockyCharacter("/models/mini/character-female-d.glb");
  const { mixer, play } = useClips(scene, animations, INTERVIEWER_CLIPS);
  const head = useMemo(() => scene.getObjectByName("head"), [scene]);

  useEffect(() => play("sit"), [play]);

  useFrame(({ clock }, dt) => {
    mixer.update(dt);
    // talk cue: nod + tilt scaled by live TTS level. SET, never accumulate —
    // this clip doesn't animate the head node, so `+=` would integrate every
    // frame until the head keels over onto the desk.
    const level = aiLevel.current;
    const t = clock.elapsedTime;
    if (head) {
      head.rotation.x = Math.sin(t * 13) * 0.12 * level;
      head.rotation.z = Math.sin(t * 7) * 0.05 * level;
    }
  });

  return (
    <group position={[0, SEAT_Y, -5.9]} rotation={[0, 0, 0]}>
      <primitive object={scene} scale={scale} />
    </group>
  );
}

const KEYMAP: Record<string, "up" | "down" | "left" | "right"> = {
  KeyW: "up",
  ArrowUp: "up",
  KeyS: "down",
  ArrowDown: "down",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
};

const PLAYER_CLIPS = ["idle", "walk", "sit"] as const;

/**
 * Third-person player: world-axis WASD/arrow movement with wall & furniture
 * collision, baked walk/idle/sit clips, follow camera. When `seated`, snaps
 * onto the chair and the camera moves over the shoulder toward the interviewer.
 */
function Player({
  seated,
  controllable,
  onNearChair,
  stick,
}: {
  seated: boolean;
  controllable: boolean;
  onNearChair: (near: boolean) => void;
  stick: { current: StickState };
}) {
  const { scene, animations, scale } = useBlockyCharacter("/models/mini/character-male-d.glb");
  const { mixer, play } = useClips(scene, animations, PLAYER_CLIPS);
  const group = useRef<THREE.Group>(null);
  const pos = useRef(SPAWN.clone());
  const facing = useRef(Math.PI); // toward -z, into the office
  const near = useRef(false);
  const keys = useRef({ up: false, down: false, left: false, right: false });
  const camGoal = useMemo(() => new THREE.Vector3(), []);
  const lookGoal = useMemo(() => new THREE.Vector3(), []);
  const look = useMemo(() => new THREE.Vector3(0, 1, SPAWN.z), []);
  const camera = useThree((s) => s.camera);
  /** Helicopter-camera azimuth (drag to orbit) and distance (wheel to zoom). */
  const yaw = useRef(Math.PI / 4);
  const dist = useRef(6.5);

  useEffect(() => {
    // Pointer events cover mouse AND touch; movementX is unreliable on touch,
    // so track the last X ourselves. The joystick overlay sits above the
    // canvas, so its touches never reach these handlers.
    let active = -1;
    let lastX = 0;
    const onDown = (e: PointerEvent) => {
      if (active === -1 && e.isPrimary !== false && e.target instanceof HTMLCanvasElement) {
        active = e.pointerId;
        lastX = e.clientX;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId === active) {
        yaw.current -= (e.clientX - lastX) * 0.006;
        lastX = e.clientX;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId === active) active = -1;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.target instanceof HTMLCanvasElement)
        dist.current = Math.min(12, Math.max(4, dist.current + e.deltaY * 0.01));
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLElement &&
      (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return; // let WASD type into the lobby form
      const k = KEYMAP[e.code];
      if (!k) return;
      e.preventDefault();
      keys.current[k] = true;
    };
    const up = (e: KeyboardEvent) => {
      const k = KEYMAP[e.code];
      if (k) keys.current[k] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const p = pos.current;
    let moving = false;

    if (seated) {
      p.set(SIT_POS.x, 0, SIT_POS.z);
      facing.current = Math.PI; // face the interviewer
    } else if (controllable) {
      // keyboard + joystick merge; both are screen-relative
      let ix = (keys.current.right ? 1 : 0) - (keys.current.left ? 1 : 0) + stick.current.x;
      let iz = (keys.current.down ? 1 : 0) - (keys.current.up ? 1 : 0) + stick.current.z;
      const ilen = Math.hypot(ix, iz);
      if (ilen > 1) {
        ix /= ilen;
        iz /= ilen;
      }
      if (ilen > 0.15) {
        moving = true;
        // input is screen-relative: rotate by the camera azimuth so "up" always
        // walks up the screen, wherever the camera has been orbited to
        const sy = Math.sin(yaw.current);
        const cy = Math.cos(yaw.current);
        const dx = ix * cy + iz * sy;
        const dz = iz * cy - ix * sy;
        const len = Math.hypot(dx, dz);
        // analog: speed scales with stick deflection
        const stepX = (dx / len) * SPEED * dt * Math.min(1, len);
        const stepZ = (dz / len) * SPEED * dt * Math.min(1, len);
        // slide along walls: try the full move, then each axis alone
        if (canWalk(p.x + stepX, p.z + stepZ)) {
          p.x += stepX;
          p.z += stepZ;
        } else if (canWalk(p.x + stepX, p.z)) {
          p.x += stepX;
        } else if (canWalk(p.x, p.z + stepZ)) {
          p.z += stepZ;
        }
        const target = Math.atan2(dx, dz);
        let diff = target - facing.current;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        facing.current += diff * Math.min(1, 14 * dt);
      }
      const isNear = p.distanceTo(SIT_POS) < SIT_NEAR;
      if (isNear !== near.current) {
        near.current = isNear;
        onNearChair(isNear);
      }
    }

    play(seated ? "sit" : moving ? "walk" : "idle");
    mixer.update(dt);

    const g = group.current;
    if (g) {
      g.position.set(p.x, seated ? SEAT_Y : 0, p.z);
      g.rotation.y = facing.current;
    }

    // camera: helicopter (isometric-ish, from the south-east) while roaming,
    // over-the-shoulder once seated
    if (seated) {
      // chibi heads sit lower — framing tuned for the mini characters
      camGoal.set(1.35, 1.7, -2.05);
      lookGoal.set(-0.12, 0.9, -5.8);
    } else {
      const d = dist.current;
      camGoal.set(p.x + Math.sin(yaw.current) * d, d * 1.17, p.z + Math.cos(yaw.current) * d);
      lookGoal.set(p.x, 0.6, p.z);
    }
    const k = 1 - Math.exp(-6 * dt);
    camera.position.lerp(camGoal, k);
    look.lerp(lookGoal, k);
    camera.lookAt(look);
  });

  return (
    <group ref={group} position={[SPAWN.x, 0, SPAWN.z]} rotation={[0, Math.PI, 0]}>
      <primitive object={scene} scale={scale} />
    </group>
  );
}

export function Scene({
  phase,
  onNearChair,
  aiLevel,
  stick,
}: {
  phase: GamePhase;
  onNearChair: (near: boolean) => void;
  aiLevel: { current: number };
  stick: { current: StickState };
}) {
  const seated = phase === "interview" || phase === "scoring" || phase === "report";
  return (
    <>
      <color attach="background" args={["#10141b"]} />
      <fog attach="fog" args={["#10141b", 16, 48]} />
      <ambientLight intensity={0.55} />
      <directionalLight
        position={[-8, 9, -2]}
        intensity={1.1}
        color="#dfe9f5"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
        shadow-camera-far={40}
      />
      <Office dollhouse={!seated} />
      <Interviewer aiLevel={aiLevel} />
      <Player
        seated={seated}
        controllable={phase === "explore"}
        onNearChair={onNearChair}
        stick={stick}
      />
    </>
  );
}
