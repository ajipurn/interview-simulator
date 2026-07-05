"use client";

/**
 * The whole 3D world. Architecture (walls/floors) stays primitive — it defines
 * the collision map; everything else is Kenney CC0: characters from "Mini
 * Characters" (public/models/mini, baked idle/walk/sit clips), furniture from
 * "Furniture Kit" (public/models/furniture). Third-person player (WASD/arrows,
 * E to sit); the interviewer nods along with the AI's live audio level.
 */
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type GamePhase = "lobby" | "explore" | "interview" | "scoring" | "report";

export const SPAWN = new THREE.Vector3(0, 0, 8.2);
/** Player chair — walking near it offers "sit", sitting starts the interview. */
export const SIT_POS = new THREE.Vector3(0, 0, -2.9);
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
  sofa: "/models/furniture/loungeSofa.glb",
  laptop: "/models/furniture/laptop.glb",
  books: "/models/furniture/books.glb",
  rug: "/models/furniture/rugRectangle.glb",
};

// --- walkable space -----------------------------------------------------
// Two rects joined by the door gap; furniture blocks. Cheap and enough —
// ponytail: no navmesh/physics until the floor plan stops being two boxes.

const REGIONS: { x1: number; x2: number; z1: number; z2: number }[] = [
  { x1: -1.3, x2: 1.3, z1: 0.2, z2: 8.7 }, // corridor
  { x1: -3.6, x2: 3.6, z1: -5.7, z2: -0.2 }, // interview room
  // door gap — must overlap both rooms by > 2×PLAYER_RADIUS or a dead zone forms
  { x1: -0.9, x2: 0.9, z1: -0.9, z2: 0.9 },
];

const BLOCKERS: { x1: number; x2: number; z1: number; z2: number }[] = [
  { x1: -1.2, x2: 1.2, z1: -5.4, z2: -3.4 }, // desk + interviewer side
  { x1: -0.35, x2: 0.35, z1: -3.25, z2: -2.55 }, // player chair
  { x1: -3.85, x2: -2.95, z1: -6.05, z2: -5.15 }, // room plants
  { x1: 2.95, x2: 3.85, z1: -6.05, z2: -5.15 },
  { x1: -3.5, x2: -1.9, z1: -6.1, z2: -5.6 }, // bookcase
  { x1: 0.75, x2: 1.65, z1: 1.15, z2: 2.05 }, // corridor plant
  { x1: -1.5, x2: -0.6, z1: 4.5, z2: 6.5 }, // corridor sofa
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
      {/* floor: corridor wood + room carpet */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 3]} receiveShadow>
        <planeGeometry args={[14, 14]} />
        <meshStandardMaterial color="#a8895f" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, -3.2]} receiveShadow>
        <planeGeometry args={[7.8, 5.8]} />
        <meshStandardMaterial color="#31465f" />
      </mesh>
      {/* ceiling — hidden in helicopter view */}
      {!dollhouse && (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 3, 1]}>
          <planeGeometry args={[16, 18]} />
          <meshStandardMaterial color="#f4f1ea" />
        </mesh>
      )}

      {/* corridor walls (entrance z=9 → room z=0); east wall faces the helicopter camera */}
      <Wall position={[-1.6, 1.5, 5]} size={[0.15, 3, 8]} />
      <Wall position={[1.6, 1.5, 5]} size={[0.15, 3, 8]} stub={dollhouse} />
      <Painting x={-1.5} z={6.5} rotY={Math.PI / 2} color="#c96f4a" />
      {!dollhouse && <Painting x={1.5} z={4.5} rotY={-Math.PI / 2} color="#4a86c9" />}
      <Furn url={F.plant} position={[1.2, 0, 1.6]} />
      <Furn url={F.sofa} position={[-1.05, 0, 5.5]} rotY={Math.PI / 2} />
      <Furn url={F.rug} position={[0, 0.005, 7.6]} scale={FURN_SCALE * 0.8} />

      {/* interview room shell; east + front walls face the helicopter camera */}
      <Wall position={[0, 1.5, -6.15]} size={[8, 3, 0.15]} />
      <Wall position={[-4, 1.5, -3]} size={[0.15, 3, 6.3]} />
      <Wall position={[4, 1.5, -3]} size={[0.15, 3, 6.3]} stub={dollhouse} />
      {/* front wall with a door gap */}
      <Wall position={[-2.6, 1.5, 0]} size={[2.9, 3, 0.15]} stub={dollhouse} />
      <Wall position={[2.6, 1.5, 0]} size={[2.9, 3, 0.15]} stub={dollhouse} />
      {!dollhouse && <Wall position={[0, 2.75, 0]} size={[2.3, 0.5, 0.15]} />}

      {/* decor on the wall the player stares at all game */}
      <Painting x={-1.6} z={-6.05} rotY={0} color="#c9a84a" />
      <Painting x={1.6} z={-6.05} rotY={0} color="#4a86c9" />

      {/* window with "daylight" on the left wall */}
      <mesh position={[-3.9, 1.6, -3.6]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[2.6, 1.5]} />
        <meshStandardMaterial color="#bcd6ef" emissive="#9fc4e8" emissiveIntensity={0.9} />
      </mesh>

      {/* furniture — Kenney Furniture Kit */}
      <Furn url={F.rug} position={[0, 0.006, -3.7]} />
      <Furn url={F.desk} position={[0, 0, -4]} />
      <Furn url={F.chair} position={[0, 0, -4.9]} />
      <Furn url={F.chair} position={[0, 0, -2.9]} rotY={Math.PI} />
      <Furn url={F.laptop} position={[0.35, DESK_TOP, -4]} rotY={Math.PI} scale={FURN_SCALE * 0.55} />
      <Furn url={F.books} position={[-0.5, DESK_TOP, -4.05]} rotY={0.4} />
      <Furn url={F.bookcase} position={[-2.7, 0, -5.88]} />
      <Furn url={F.plant} position={[-3.4, 0, -5.6]} />
      <Furn url={F.plant} position={[3.4, 0, -5.6]} />

      <CeilingLamp x={0} z={-3.5} showFixture={!dollhouse} />
      <CeilingLamp x={0} z={2} showFixture={!dollhouse} />
      <CeilingLamp x={0} z={6} showFixture={!dollhouse} />
    </group>
  );
}

// --- characters ---------------------------------------------------------

const INTERVIEWER_CLIPS = ["sit"] as const;

function Interviewer({ aiLevel }: { aiLevel: { current: number } }) {
  const { scene, animations, scale } = useBlockyCharacter("/models/mini/character-female-a.glb");
  const { mixer, play } = useClips(scene, animations, INTERVIEWER_CLIPS);
  const head = useMemo(() => scene.getObjectByName("head"), [scene]);

  useEffect(() => play("sit"), [play]);

  useFrame(({ clock }, dt) => {
    mixer.update(dt);
    // talk cue: nod + tilt scaled by live TTS level, applied after the mixer
    const level = aiLevel.current;
    const t = clock.elapsedTime;
    if (head) {
      head.rotation.x += Math.sin(t * 13) * 0.12 * level;
      head.rotation.z += Math.sin(t * 7) * 0.05 * level;
    }
  });

  return (
    <group position={[0, SEAT_Y, -4.9]} rotation={[0, 0, 0]}>
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
}: {
  seated: boolean;
  controllable: boolean;
  onNearChair: (near: boolean) => void;
}) {
  const { scene, animations, scale } = useBlockyCharacter("/models/mini/character-male-a.glb");
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
      const ix = (keys.current.right ? 1 : 0) - (keys.current.left ? 1 : 0);
      const iz = (keys.current.down ? 1 : 0) - (keys.current.up ? 1 : 0);
      if (ix !== 0 || iz !== 0) {
        moving = true;
        // input is screen-relative: rotate by the helicopter camera's 45° azimuth
        // so W walks "up the screen", not up the world axis
        const dx = (ix + iz) * Math.SQRT1_2;
        const dz = (iz - ix) * Math.SQRT1_2;
        const len = Math.hypot(dx, dz);
        const stepX = (dx / len) * SPEED * dt;
        const stepZ = (dz / len) * SPEED * dt;
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
      camGoal.set(1.35, 1.7, -1.05);
      lookGoal.set(-0.12, 0.9, -4.8);
    } else {
      camGoal.set(p.x + 4.6, 7.6, p.z + 4.6);
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
}: {
  phase: GamePhase;
  onNearChair: (near: boolean) => void;
  aiLevel: { current: number };
}) {
  const seated = phase === "interview" || phase === "scoring" || phase === "report";
  return (
    <>
      <color attach="background" args={["#10141b"]} />
      <fog attach="fog" args={["#10141b", 14, 36]} />
      <ambientLight intensity={0.55} />
      <directionalLight
        position={[-6, 5, -2]}
        intensity={1.1}
        color="#dfe9f5"
        castShadow
        shadow-mapSize={[1024, 1024]}
      />
      <Office dollhouse={!seated} />
      <Interviewer aiLevel={aiLevel} />
      <Player seated={seated} controllable={phase === "explore"} onNearChair={onNearChair} />
    </>
  );
}
