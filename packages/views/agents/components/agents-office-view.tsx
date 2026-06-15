"use client";

import { useEffect, useRef } from "react";
import type PhaserType from "phaser";
import type { AgentLiveAction } from "@multica/core/agents";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import type { AgentRow } from "./agent-columns";
import { useNavigation } from "../../navigation";
import { useWorkspacePaths } from "@multica/core/paths";

// ═══════════════════════════════════════════════════════════════════════════
// SoWork-style virtual office. Top-down warm map with a desk grid and a lounge.
// Agents are living characters: they sit at their desk when working/queued,
// and when idle they roam the lounge — mingling, grabbing a coffee, or
// wandering back to their own desk — with a stepping-bob walk animation.
//
// Rendering is pixel-crisp on HiDPI: the canvas backing store is sized at the
// device pixel ratio and the camera zoom is multiplied by the DPR, so every
// vector edge and avatar lands on a physical pixel. Text is rendered at high
// resolution for the same reason.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Tile + layout constants (design pixels) ────────────────────────────────
const T = 16;
const DESK_COLS = 4;
const DESK_CELL_W = 11 * T; // 176
const DESK_CELL_H = 9 * T;  // 144
const PAD = 3 * T;          // outer margin / gutter
const LOUNGE_COL_W = 6.5 * T; // 104 — lounge slot pitch X (room for the "Available" chip)
const LOUNGE_ROW_H = 6 * T;   // 96 — lounge slot pitch Y

// ─── Warm SoWork palette ─────────────────────────────────────────────────────
const C = {
  floorA:       0xf3eee5,
  floorB:       0xece5d9,
  floorLine:    0xd8d0c0,
  rug:          0xe6ddcb,
  meetFill:     0xe6f0fb,
  meetBorder:   0x6f9fd6,
  loungeFill:   0xe9f4ea,
  loungeBorder: 0x76b27f,
  deskTop:      0xcaa074,
  deskTopHi:    0xe0bc92,
  deskEdge:     0xa9805a,
  deskShadow:   0x6b4f38,
  monitorBody:  0x2c2c34,
  monSleep:     0x171b24,
  monWork:      0x123d8f,
  monWorkGlow:  0x3b82f6,
  monQueue:     0x7c3a09,
  monQueueGlow: 0xf59e0b,
  chair:        0x6d5240,
  plantPot:     0x9c7255,
  plantDark:    0x2f7d34,
  plantMid:     0x44a049,
  textDark:     "#23211c",
  textMid:      "#6f6a60",
};

// Agent accent palette
const PALETTE = [
  0x4a7fc4, 0x7b68c8, 0x48a87a, 0xc99b3a,
  0xc45a7b, 0xcf7a3a, 0x3a9aaa, 0x7848c8,
  0x3aaa68, 0xb840a0, 0xc45858, 0x4a90a4,
];
const agentColor = (i: number) => PALETTE[i % PALETTE.length] ?? 0x4a7fc4;

// Status colors
const RING = {
  working:  0x3b82f6,
  queued:   0xf59e0b,
  online:   0x22c55e,
  unstable: 0xf59e0b,
  offline:  0x9aa3b2,
};
const CHIP = {
  working:  { color: "#1d4ed8", bg: "#dbeafe" },
  queued:   { color: "#92400e", bg: "#fef3c7" },
  available:{ color: "#15803d", bg: "#dcfce7" },
  unstable: { color: "#b45309", bg: "#fef3c7" },
  offline:  { color: "#64748b", bg: "#f1f5f9" },
};

// ─── Status helpers ───────────────────────────────────────────────────────────
type Posture = "working" | "queued" | "sleeping" | "offline";

// Status ring reflects what the agent is doing, matching the legend:
// working → blue, queued → amber, available → green, offline → gray.
function ringColorFor(posture: Posture, av: string): number {
  if (posture === "offline") return RING.offline;
  if (posture === "working") return RING.working;
  if (posture === "queued") return RING.queued;
  return av === "unstable" ? RING.unstable : RING.online; // sleeping = available
}

function classify(row: AgentRow): { av: string; wl: string; isOffline: boolean; atDesk: boolean; posture: Posture } {
  const av = row.presence?.availability ?? "offline";
  const wl = row.presence?.workload ?? "idle";
  const isOffline = av === "offline" || av === "archived";
  const atDesk = isOffline || wl === "working" || wl === "queued";
  const posture: Posture = isOffline ? "offline" : wl === "working" ? "working" : wl === "queued" ? "queued" : "sleeping";
  return { av, wl, isOffline, atDesk, posture };
}

function chipFor(
  row: AgentRow,
  summaryMap: Map<string, string>,
  actions: Map<string, AgentLiveAction>,
): { text: string; style: { color: string; bg: string } } {
  const { av, wl, isOffline } = classify(row);
  if (isOffline) return { text: "Offline", style: CHIP.offline };
  if (av === "unstable") return { text: "Unstable", style: CHIP.unstable };
  if (wl === "working") {
    // Prefer the live action ("Reading paths.ts"), then the task trigger
    // summary, then a plain running count.
    const action = actions.get(row.agent.id)?.label;
    const s = action ?? summaryMap.get(row.agent.id);
    const base = `${row.presence?.runningCount ?? 0}/${row.presence?.capacity ?? "?"} running`;
    return { text: s ? (s.length > 24 ? s.slice(0, 23) + "…" : s) : base, style: CHIP.working };
  }
  if (wl === "queued") return { text: `${row.presence?.queuedCount ?? 0} queued`, style: CHIP.queued };
  return { text: "Available", style: CHIP.available };
}

// ═══════════════════════════════════════════════════════════════════════════
// World geometry
// ═══════════════════════════════════════════════════════════════════════════

function deskAreaSize(n: number) {
  const cols = DESK_COLS;
  const rows = Math.max(2, Math.ceil(n / cols));
  return { w: cols * DESK_CELL_W, h: rows * DESK_CELL_H, rows };
}
function worldSize(n: number): { WW: number; WH: number; desk: { w: number; h: number; rows: number }; loungeRows: number } {
  const desk = deskAreaSize(n);
  const WW = PAD + desk.w + PAD;
  const loungeCols = Math.max(4, Math.floor((WW - PAD * 2) / LOUNGE_COL_W));
  const loungeRows = Math.max(2, Math.ceil(n / loungeCols));
  // Roomy lounge so idle agents have space to roam, mingle and grab coffee.
  const loungeH = 3 * T + loungeRows * LOUNGE_ROW_H + 2 * T;
  const WH = PAD + Math.max(desk.h, 10 * T) + PAD + loungeH;
  return { WW, WH, desk, loungeRows };
}
function deskCell(i: number): { x: number; y: number } {
  return { x: PAD + (i % DESK_COLS) * DESK_CELL_W, y: PAD + Math.floor(i / DESK_COLS) * DESK_CELL_H };
}
function deskCenterX(i: number) { return deskCell(i).x + DESK_CELL_W / 2; }
function deskMonitorY(i: number) { return deskCell(i).y + 2.2 * T; }
function deskStandPos(i: number): [number, number] { return [deskCenterX(i), deskCell(i).y + 5.4 * T]; }

function deskAreaSizeWidth() { return DESK_COLS * DESK_CELL_W; }

function loungeBounds(WW: number, WH: number, deskH: number) {
  const y = PAD + Math.max(deskH, 10 * T) + PAD;
  return { x: PAD, y, w: WW - PAD * 2, h: WH - y - T };
}
function loungeCols(WW: number) { return Math.max(4, Math.floor((WW - PAD * 2) / LOUNGE_COL_W)); }
function loungeSlotPos(slot: number, WW: number, WH: number, deskH: number): [number, number] {
  const b = loungeBounds(WW, WH, deskH);
  const cols = loungeCols(WW);
  const usableW = b.w - LOUNGE_COL_W;
  const step = cols > 1 ? usableW / (cols - 1) : 0;
  const col = slot % cols;
  const rrow = Math.floor(slot / cols);
  const x = b.x + LOUNGE_COL_W / 2 + col * step;
  const y = b.y + 3 * T + rrow * LOUNGE_ROW_H;
  return [x, y];
}

const avKey = (id: string) => `av_${id}`;
const circKey = (id: string) => `circ_${id}`;
type Track = <T extends PhaserType.GameObjects.GameObject>(obj: T) => T;

// ─── State ─────────────────────────────────────────────────────────────────
interface CameraState { scrollX: number; scrollY: number; uiZoom: number }
interface CharState {
  container: PhaserType.GameObjects.Container; // world position (walk target)
  figure: PhaserType.GameObjects.Container;    // bobs while walking / breathing
  ring: PhaserType.GameObjects.Arc;
  chip: PhaserType.GameObjects.Text;
  posture: Posture;
  av: string;
  homeX: number;
  homeY: number;
  lastChip: string;
  walkingTo: { x: number; y: number } | null;
  deskIndex: number;     // home desk — wander excursions can visit it
  behaviorGen: number;   // bumped on each startBehavior to cancel stale wander chains
}

export interface DelegationEdge { fromAgentId: string; toAgentId: string }
export interface AgentsOfficeViewProps {
  rows: AgentRow[];
  runningTaskSummary?: Map<string, string>;
  /** Live "what is this agent doing right now" per agent id (Reading, Bash, …). */
  liveActions?: Map<string, AgentLiveAction>;
  delegationEdges?: DelegationEdge[];
}

// Module-level text resolution, set per game from DPR.
let TEXT_RES = 2;
// Module-level current lounge bounds, refreshed each updateScene — read by the
// idle-agent wander behavior (which runs on delayed timers, outside updateScene).
let LOUNGE: { x: number; y: number; w: number; h: number } | null = null;
function addText(scene: PhaserType.Scene, x: number, y: number, str: string, style: Phaser.Types.GameObjects.Text.TextStyle) {
  return scene.add.text(x, y, str, { fontFamily: "system-ui, -apple-system, Arial, sans-serif", ...style }).setResolution(TEXT_RES);
}

// ═══════════════════════════════════════════════════════════════════════════
// React component
// ═══════════════════════════════════════════════════════════════════════════

export function AgentsOfficeView({
  rows,
  runningTaskSummary = new Map(),
  liveActions = new Map(),
  delegationEdges = [],
}: AgentsOfficeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<PhaserType.Game | null>(null);
  const cameraStateRef = useRef<CameraState | null>(null);
  const saveCameraRef = useRef<(() => CameraState) | null>(null);
  const redrawRef = useRef<(() => void) | null>(null);
  const camApiRef = useRef<{ zoomBy: (f: number) => void; reset: () => void } | null>(null);
  const prevKeyRef = useRef("");

  const rowsRef = useRef(rows);
  const summaryRef = useRef(runningTaskSummary);
  const actionsRef = useRef(liveActions);
  const edgesRef = useRef(delegationEdges);
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const navigateRef = useRef((id: string) => navigation.push(paths.agentDetail(id)));

  rowsRef.current = rows;
  summaryRef.current = runningTaskSummary;
  actionsRef.current = liveActions;
  edgesRef.current = delegationEdges;
  navigateRef.current = (id: string) => navigation.push(paths.agentDetail(id));

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    let cancelled = false;

    import("phaser").then((mod) => {
      if (cancelled || !el || gameRef.current) return;
      const Phaser = mod.default as typeof PhaserType;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      TEXT_RES = Math.min(4, Math.ceil(dpr * 2));

      // World geometry — recomputed on every update so the floor, desks and
      // lounge always match the CURRENT agent count (agent data loads async,
      // after the game is created).
      let geom = worldSize(Math.max(rowsRef.current.length, 8));
      let minZoom = 0.4;
      let uiZoom = cameraStateRef.current?.uiZoom ?? 1.4;
      let didCenter = false;
      let floorKey = ""; // rebuild the floor only when world size changes

      // Layer trackers (cleared + redrawn on state change)
      const floorObjs: PhaserType.GameObjects.GameObject[] = [];
      const trackFloor: Track = (o) => { floorObjs.push(o); return o; };
      const clearFloor = () => { for (const o of floorObjs) if (o.scene) o.destroy(); floorObjs.length = 0; };

      const deskObjs: PhaserType.GameObjects.GameObject[] = [];
      const trackDesk: Track = (o) => { deskObjs.push(o); return o; };
      const clearDesks = () => { for (const o of deskObjs) if (o.scene) o.destroy(); deskObjs.length = 0; };

      const delegObjs: PhaserType.GameObjects.GameObject[] = [];
      const trackDeleg: Track = (o) => { delegObjs.push(o); return o; };
      const clearDelegs = (scene: PhaserType.Scene) => {
        for (const o of delegObjs) { scene.tweens.killTweensOf(o); if (o.scene) o.destroy(); } delegObjs.length = 0;
      };

      const charMap = new Map<string, CharState>();

      function computeMinZoom(scene: PhaserType.Scene) {
        const cssW = scene.scale.width / dpr, cssH = scene.scale.height / dpr;
        // Fill the viewport so the empty beige void is never visible.
        return Math.min(3.5, Math.max(cssW / geom.WW, cssH / geom.WH));
      }

      function updateScene(scene: PhaserType.Scene) {
        // Recompute geometry for the current agent count, then redraw the floor.
        geom = worldSize(Math.max(rowsRef.current.length, 8));
        const { WW, WH, desk } = geom;
        const deskH = desk.h;
        LOUNGE = loungeBounds(WW, WH, deskH);

        const nextFloorKey = `${WW}x${WH}`;
        if (nextFloorKey !== floorKey) {
          floorKey = nextFloorKey;
          clearFloor();
          drawFloor(scene, trackFloor, WW, WH, deskH);
        }

        clearDesks();
        const data = rowsRef.current;

        // Pass 1 — desks + compute lounge slots
        let loungeSlot = 0;
        const placement = new Map<string, { x: number; y: number; atDesk: boolean }>();
        data.forEach((row, i) => {
          const cls = classify(row);
          drawDesk(scene, trackDesk, i, row, cls.posture, actionsRef.current);
          if (cls.atDesk) {
            const [x, y] = deskStandPos(i);
            placement.set(row.agent.id, { x, y, atDesk: true });
          } else {
            const [x, y] = loungeSlotPos(loungeSlot++, WW, WH, deskH);
            placement.set(row.agent.id, { x, y, atDesk: false });
          }
        });

        // Pass 2 — characters
        const seen = new Set<string>();
        data.forEach((row, i) => {
          seen.add(row.agent.id);
          const cls = classify(row);
          const pos = placement.get(row.agent.id)!;
          const existing = charMap.get(row.agent.id);
          if (!existing) {
            const st = createChar(scene, row, i, pos.x, pos.y, navigateRef.current, summaryRef.current, actionsRef.current);
            charMap.set(row.agent.id, st);
            startBehavior(scene, st, cls.posture, pos.x, pos.y);
          } else {
            const moved = Math.hypot(pos.x - existing.homeX, pos.y - existing.homeY) > 6;
            const postureChanged = existing.posture !== cls.posture;
            const avChanged = existing.av !== cls.av;
            refreshChip(existing, row, summaryRef.current, actionsRef.current);
            if (moved || postureChanged || avChanged) {
              transitionChar(scene, existing, pos.x, pos.y, cls.posture, cls.av);
            }
          }
        });

        // Remove vanished agents
        for (const [id, st] of charMap) {
          if (!seen.has(id)) {
            scene.tweens.killTweensOf(st.container);
            scene.tweens.killTweensOf(st.figure);
            if (st.container.scene) st.container.destroy();
            charMap.delete(id);
          }
        }

        clearDelegs(scene);
        drawDelegations(scene, edgesRef.current, charMap, trackDeleg);

        // Keep the camera inside the (possibly resized) world and out of the void.
        const cam = scene.cameras.main;
        cam.setBounds(0, 0, WW, WH);
        minZoom = computeMinZoom(scene);
        if (uiZoom < minZoom) { uiZoom = minZoom; cam.setZoom(uiZoom * dpr); }
        if (!didCenter && !cameraStateRef.current) {
          cam.centerOn(deskAreaSizeWidth() / 2 + PAD, PAD + deskH / 2);
          didCenter = true;
        }
      }

      const cssW = el.clientWidth || 960;
      const cssH = el.clientHeight || 600;

      gameRef.current = new Phaser.Game({
        type: Phaser.AUTO,
        width: Math.floor(cssW * dpr),
        height: Math.floor(cssH * dpr),
        parent: el,
        backgroundColor: "#f3eee5",
        render: { antialias: true, roundPixels: false, powerPreference: "high-performance" },
        scale: { mode: Phaser.Scale.NONE, autoCenter: Phaser.Scale.NO_CENTER },
        scene: {
          key: "office",
          preload(this: PhaserType.Scene) {
            this.load.on("loaderror", () => {});
            rowsRef.current.forEach((row) => {
              const url = resolvePublicFileUrl(row.agent.avatar_url ?? null);
              if (url) this.load.image(avKey(row.agent.id), url);
            });
          },
          create(this: PhaserType.Scene) {
            const scene = this;

            // HiDPI: backing store at DPR, CSS at design size, camera zoom × DPR.
            scene.game.canvas.style.width = cssW + "px";
            scene.game.canvas.style.height = cssH + "px";

            // Bake circular avatar textures once.
            rowsRef.current.forEach((row) => bakeCircle(scene, avKey(row.agent.id), circKey(row.agent.id), 96));

            const cam = scene.cameras.main;
            const saved = cameraStateRef.current;
            cam.setZoom(uiZoom * dpr);
            if (saved) cam.setScroll(saved.scrollX, saved.scrollY);

            saveCameraRef.current = () => ({ scrollX: cam.scrollX, scrollY: cam.scrollY, uiZoom });
            const setUiZoom = (z: number, focusX?: number, focusY?: number) => {
              const next = Phaser.Math.Clamp(z, minZoom, 3.5);
              if (focusX != null && focusY != null) {
                const before = cam.getWorldPoint(focusX * dpr, focusY * dpr);
                cam.setZoom(next * dpr);
                const after = cam.getWorldPoint(focusX * dpr, focusY * dpr);
                cam.scrollX += before.x - after.x;
                cam.scrollY += before.y - after.y;
              } else {
                cam.setZoom(next * dpr);
              }
              uiZoom = next;
            };
            camApiRef.current = {
              zoomBy: (f) => setUiZoom(uiZoom * f),
              reset: () => { setUiZoom(minZoom); cam.centerOn(deskAreaSizeWidth() / 2 + PAD, PAD + geom.desk.h / 2); },
            };

            setupCamera(scene, Phaser, dpr, () => uiZoom, setUiZoom);
            updateScene(scene); // draws floor + everything, sets bounds/minZoom/centering
            redrawRef.current = () => updateScene(scene);

            // HiDPI-correct resize — also re-clamp zoom to the new fit.
            const ro = new ResizeObserver(() => {
              const w = el.clientWidth, h = el.clientHeight;
              if (!w || !h) return;
              scene.scale.resize(Math.floor(w * dpr), Math.floor(h * dpr));
              scene.game.canvas.style.width = w + "px";
              scene.game.canvas.style.height = h + "px";
              minZoom = computeMinZoom(scene);
              if (uiZoom < minZoom) { uiZoom = minZoom; cam.setZoom(uiZoom * dpr); }
            });
            ro.observe(el);
            scene.events.once("shutdown", () => ro.disconnect());
          },
        },
      });
    });

    return () => {
      cancelled = true;
      if (saveCameraRef.current) cameraStateRef.current = saveCameraRef.current();
      gameRef.current?.destroy(true);
      gameRef.current = null;
      redrawRef.current = null;
      camApiRef.current = null;
    };
  }, []);

  useEffect(() => {
    const key =
      rows.map((r) => `${r.agent.id}|${r.presence?.availability ?? ""}|${r.presence?.workload ?? ""}|${r.presence?.runningCount ?? 0}|${r.presence?.queuedCount ?? 0}|${runningTaskSummary.get(r.agent.id) ?? ""}|${liveActions.get(r.agent.id)?.label ?? ""}`).join(",")
      + ";" + delegationEdges.map((e) => `${e.fromAgentId}>${e.toAgentId}`).join(",");
    if (key === prevKeyRef.current) return;
    prevKeyRef.current = key;
    redrawRef.current?.();
  }, [rows, runningTaskSummary, liveActions, delegationEdges]);

  return (
    <div className="relative flex-1 w-full overflow-hidden" style={{ background: "#f3eee5" }}>
      <div ref={containerRef} className="absolute inset-0 select-none" />

      {/* Legend */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background/85 px-3 py-2 text-xs shadow-sm backdrop-blur">
        <LegendDot color="#3b82f6" label="Working" />
        <LegendDot color="#f59e0b" label="Queued" />
        <LegendDot color="#22c55e" label="Available" />
        <LegendDot color="#9aa3b2" label="Offline" />
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-border/60 bg-background/85 p-1 shadow-sm backdrop-blur">
        <ZoomBtn label="−" onClick={() => camApiRef.current?.zoomBy(1 / 1.25)} />
        <button
          onClick={() => camApiRef.current?.reset()}
          className="rounded px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted"
        >
          Reset
        </button>
        <ZoomBtn label="+" onClick={() => camApiRef.current?.zoomBy(1.25)} />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}
function ZoomBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded text-base font-medium text-muted-foreground transition-colors hover:bg-muted"
    >
      {label}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Camera — DOM events, DPR-aware pan + zoom-at-pointer
// ═══════════════════════════════════════════════════════════════════════════

function setupCamera(
  scene: PhaserType.Scene,
  Phaser: typeof PhaserType,
  dpr: number,
  getUiZoom: () => number,
  setUiZoom: (z: number, fx?: number, fy?: number) => void,
) {
  const canvas = scene.game.canvas;
  const TH = 3;
  let origin: { x: number; y: number } | null = null;

  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    origin = { x: e.clientX, y: e.clientY };
    canvas.style.cursor = "grabbing";
  };
  const onMove = (e: MouseEvent) => {
    if (!origin || !(e.buttons & 1)) { origin = null; canvas.style.cursor = "grab"; return; }
    const dx = e.clientX - origin.x, dy = e.clientY - origin.y;
    if (Math.abs(dx) < TH && Math.abs(dy) < TH) return;
    const cam = scene.cameras.main;
    const z = getUiZoom();
    cam.scrollX -= dx / z; // CSS px → world px (camZoom = uiZoom × dpr, css = backing/dpr ⇒ /uiZoom)
    cam.scrollY -= dy / z;
    origin = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => { origin = null; canvas.style.cursor = "grab"; };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const fx = e.clientX - rect.left, fy = e.clientY - rect.top;
    // Gentle, per-event-clamped so a trackpad fling or big wheel notch can't jump.
    const factor = Phaser.Math.Clamp(Math.exp(-e.deltaY * 0.0012), 0.95, 1.05);
    setUiZoom(getUiZoom() * factor, fx, fy);
  };

  canvas.style.cursor = "grab";
  void dpr;
  canvas.addEventListener("mousedown", onDown);
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseup", onUp);
  canvas.addEventListener("mouseleave", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
}

// ═══════════════════════════════════════════════════════════════════════════
// Circular avatar baking
// ═══════════════════════════════════════════════════════════════════════════

function bakeCircle(scene: PhaserType.Scene, srcKey: string, outKey: string, D: number): boolean {
  if (scene.textures.exists(outKey)) return true;
  if (!scene.textures.exists(srcKey) || scene.textures.get(srcKey).key === "__MISSING") return false;
  const src = scene.textures.get(srcKey).getSourceImage() as HTMLImageElement;
  const scale = Math.max(D / src.width, D / src.height);
  const img = scene.make.image({ x: D / 2, y: D / 2, key: srcKey, add: false }).setScale(scale);
  const mg = scene.make.graphics({ x: 0, y: 0 });
  mg.fillStyle(0xffffff, 1).fillCircle(D / 2, D / 2, D / 2);
  const mask = mg.createGeometryMask();
  img.setMask(mask);
  const rt = scene.make.renderTexture({ x: 0, y: 0, width: D, height: D }, false);
  rt.draw(img);
  rt.saveTexture(outKey); // rt must NOT be destroyed — it backs the saved texture
  img.destroy();
  mg.destroy();
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Floor + zones
// ═══════════════════════════════════════════════════════════════════════════

function drawFloor(scene: PhaserType.Scene, track: Track, WW: number, WH: number, deskH: number) {
  const g = track(scene.add.graphics().setDepth(0));
  const TILE = 2 * T;

  // Checkerboard floor
  for (let x = 0; x < WW; x += TILE) {
    for (let y = 0; y < WH; y += TILE) {
      const alt = ((x / TILE) + (y / TILE)) % 2 === 0;
      g.fillStyle(alt ? C.floorA : C.floorB, 1);
      g.fillRect(x, y, TILE, TILE);
    }
  }
  g.lineStyle(1, C.floorLine, 0.35);
  for (let x = 0; x <= WW; x += TILE) g.lineBetween(x, 0, x, WH);
  for (let y = 0; y <= WH; y += TILE) g.lineBetween(0, y, WW, y);

  // Soft rug under desk grid
  const da = deskAreaSizeWidth();
  g.fillStyle(C.rug, 0.5);
  g.fillRoundedRect(PAD - T, PAD - T, da + 2 * T, Math.max(deskH, 10 * T) + 2 * T, 14);

  drawLounge(scene, track, g, WW, WH, deskH);

  // Corner plants
  drawPlant(g, PAD - 2 * T, PAD - 2 * T);
}

function drawLounge(scene: PhaserType.Scene, track: Track, g: PhaserType.GameObjects.Graphics, WW: number, WH: number, deskH: number) {
  const b = loungeBounds(WW, WH, deskH);

  g.fillStyle(C.loungeFill, 1);
  g.fillRoundedRect(b.x, b.y, b.w, b.h, 14);
  g.lineStyle(2, C.loungeBorder, 0.6);
  g.strokeRoundedRect(b.x, b.y, b.w, b.h, 14);

  // Header bar
  g.fillStyle(0xffffff, 0.5);
  g.fillRoundedRect(b.x + 8, b.y + 8, b.w - 16, 1.6 * T, 8);

  // Coffee bar (left)
  const cbx = b.x + 1.5 * T, cby = b.y + 1.2 * T;
  g.fillStyle(0xcaa074, 1);
  g.fillRoundedRect(cbx, cby, 4 * T, 1.4 * T, 5);
  g.fillStyle(0x2c2c34, 1);
  g.fillRoundedRect(cbx + 0.5 * T, cby - 0.4 * T, 1.2 * T, 1.4 * T, 3);
  g.fillStyle(0x22c55e, 1);
  g.fillCircle(cbx + 1.1 * T, cby + 0.3 * T, 2);
  [0, 1, 2].forEach((k) => {
    g.fillStyle(0xffffff, 0.9);
    g.fillRoundedRect(cbx + 2.2 * T + k * 0.7 * T, cby + 0.3 * T, 0.5 * T, 0.7 * T, 2);
  });

  // Sofas (right side, decorative)
  [
    [b.x + b.w - 5 * T, b.y + 1.6 * T, C.meetFill, C.meetBorder],
    [b.x + b.w - 5 * T, b.y + b.h - 2.4 * T, 0xfde8e8, 0xe0a0a0],
  ].forEach(([sx, sy, fill, border]) => {
    g.fillStyle(0x000000, 0.08);
    g.fillRoundedRect((sx as number) + 2, (sy as number) + 2, 3.6 * T, 1.4 * T, 8);
    g.fillStyle(fill as number, 0.9);
    g.fillRoundedRect(sx as number, sy as number, 3.6 * T, 1.4 * T, 8);
    g.lineStyle(1.5, border as number, 0.6);
    g.strokeRoundedRect(sx as number, sy as number, 3.6 * T, 1.4 * T, 8);
  });

  track(addText(scene, b.x + 1.5 * T, b.y + 8, "☕  Lounge · Available", {
    fontSize: "11px", color: "#1d6b32", fontStyle: "bold",
  }).setDepth(1).setOrigin(0, 0));
}

function drawPlant(g: PhaserType.GameObjects.Graphics, px: number, py: number) {
  g.fillStyle(C.plantPot, 1);
  g.fillRoundedRect(px + 5, py + T + 4, 14, T - 4, 3);
  g.fillStyle(C.plantDark, 1);
  g.fillCircle(px + 12, py + T, 11);
  g.fillStyle(C.plantMid, 0.85);
  g.fillCircle(px + 6, py + T + 3, 7);
  g.fillCircle(px + 18, py + T + 3, 7);
}

// ═══════════════════════════════════════════════════════════════════════════
// Desk
// ═══════════════════════════════════════════════════════════════════════════

function drawDesk(scene: PhaserType.Scene, track: Track, i: number, row: AgentRow, posture: Posture, actions: Map<string, AgentLiveAction>) {
  const cell = deskCell(i);
  const cx = deskCenterX(i);
  const monY = deskMonitorY(i);
  const dim = posture === "offline" ? 0.5 : posture === "sleeping" ? 0.78 : 1;

  const deskW = 8 * T, deskH = 3.6 * T;
  const deskX = cx - deskW / 2, deskY = monY - 0.2 * T;
  const g = track(scene.add.graphics().setDepth(1));

  // Shadow + surface
  g.fillStyle(C.deskShadow, 0.18 * dim);
  g.fillRoundedRect(deskX + 4, deskY + 5, deskW, deskH, 7);
  g.fillStyle(C.deskTop, dim);
  g.fillRoundedRect(deskX, deskY, deskW, deskH, 7);
  g.lineStyle(1.5, C.deskTopHi, 0.5 * dim);
  g.lineBetween(deskX + 6, deskY + 2, deskX + deskW - 6, deskY + 2);
  g.lineStyle(1.5, C.deskEdge, 0.6 * dim);
  g.strokeRoundedRect(deskX, deskY, deskW, deskH, 7);

  // Monitor
  const monW = 3.6 * T, monH = 2.2 * T;
  const mx = cx - monW / 2, my = deskY + 4;
  const working = posture === "working", queued = posture === "queued";
  if (working) { g.fillStyle(C.monWorkGlow, 0.22); g.fillRoundedRect(mx - 5, my - 5, monW + 10, monH + 10, 8); }
  else if (queued) { g.fillStyle(C.monQueueGlow, 0.18); g.fillRoundedRect(mx - 5, my - 5, monW + 10, monH + 10, 8); }
  g.fillStyle(C.monitorBody, dim);
  g.fillRoundedRect(mx, my, monW, monH, 4);
  const screen = working ? C.monWork : queued ? C.monQueue : C.monSleep;
  g.fillStyle(screen, dim);
  g.fillRoundedRect(mx + 3, my + 3, monW - 6, monH - 6, 3);
  // stand
  g.fillStyle(C.monitorBody, dim);
  g.fillRect(cx - 2, my + monH, 4, 5);
  g.fillRoundedRect(cx - T * 0.7, my + monH + 4, T * 1.4, 4, 2);

  // Keyboard + mouse
  g.fillStyle(0x3a3a42, 0.6 * dim);
  g.fillRoundedRect(cx - T, deskY + deskH - 0.9 * T, 2 * T, 0.7 * T, 2);
  g.fillRoundedRect(cx + 1.3 * T, deskY + deskH - 0.9 * T, 8, 0.55 * T, 3);

  // Screen content
  if (working) {
    // Show the current tool ("Read", "Bash", "Update topic"); else a run count.
    const tool = actions.get(row.agent.id)?.tool;
    const screenText = tool ? (tool.length > 11 ? tool.slice(0, 10) + "…" : tool) : summaryOnScreen(row);
    track(addText(scene, cx, my + monH / 2, screenText, { fontSize: "8px", color: "#9ec5fe", align: "center" }).setDepth(2).setOrigin(0.5, 0.5));
  } else if (queued) {
    track(addText(scene, cx, my + monH / 2, `${row.presence?.queuedCount ?? 0} queued`, { fontSize: "8px", color: "#fcd34d", align: "center" }).setDepth(2).setOrigin(0.5, 0.5));
  } else if (posture === "offline") {
    track(addText(scene, cx, my + monH / 2, "🔒", { fontSize: "11px" }).setDepth(2).setOrigin(0.5, 0.5).setAlpha(0.6));
  } else {
    // sleeping — small zzz
    track(addText(scene, cx, my + monH / 2, "𝗓", { fontSize: "9px", color: "#5b6472" }).setDepth(2).setOrigin(0.5, 0.5).setAlpha(0.7));
  }

  // Empty chair when the agent is away in the lounge (no character at this desk)
  if (posture === "sleeping") {
    const chairY = cell.y + 5.4 * T;
    g.fillStyle(0x000000, 0.08);
    g.fillEllipse(cx, chairY + 10, 26, 9);
    g.fillStyle(C.chair, 0.55);
    g.fillCircle(cx, chairY, 11);
    g.lineStyle(1.5, C.chair, 0.4);
    g.strokeCircle(cx, chairY, 11);
    // Small "away" tag so an empty desk reads as "agent is in the lounge"
    const nm = row.agent.name.length > 12 ? row.agent.name.slice(0, 11) + "…" : row.agent.name;
    track(addText(scene, cx, chairY + 18, nm, { fontSize: "9px", color: C.textMid, align: "center" }).setDepth(2).setOrigin(0.5, 0).setAlpha(0.6));
  }
}

function summaryOnScreen(row: AgentRow): string {
  return `▶ ${row.presence?.runningCount ?? 0}/${row.presence?.capacity ?? "?"}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Character
// ═══════════════════════════════════════════════════════════════════════════

function buildFigure(scene: PhaserType.Scene, row: AgentRow, idx: number, posture: Posture, av: string, summaryMap: Map<string, string>, actions: Map<string, AgentLiveAction>) {
  const color = agentColor(idx);
  const isOffline = posture === "offline";
  const alpha = isOffline ? 0.5 : 1;
  const ringColor = ringColorFor(posture, av);

  // ring halo (filled, body covers center)
  const ring = scene.add.circle(0, 0, 15, ringColor).setAlpha(alpha);
  const body = scene.add.circle(0, 1, 12, color).setAlpha(alpha);
  const headColor = blend(color, 0xffffff, 0.42);
  const head = scene.add.circle(2, -6, 7.5, headColor).setAlpha(alpha);
  const headHi = scene.add.circle(3.5, -8.5, 3, 0xffffff).setAlpha(alpha * 0.4);

  let avatar: PhaserType.GameObjects.GameObject | null = null;
  const ck = circKey(row.agent.id);
  if (scene.textures.exists(ck)) {
    avatar = scene.add.image(0, 0, ck).setDisplaySize(24, 24).setAlpha(alpha);
  } else {
    avatar = addText(scene, 0, 1, (row.agent.name[0] ?? "?").toUpperCase(), { fontSize: "13px", color: "#ffffff", fontStyle: "bold" }).setOrigin(0.5, 0.5).setAlpha(alpha);
  }

  const nm = row.agent.name.length > 14 ? row.agent.name.slice(0, 13) + "…" : row.agent.name;
  const namePlate = addText(scene, 0, 19, nm, {
    fontSize: "10px", color: "#ffffff", fontStyle: "bold", backgroundColor: "#1f2430e0", padding: { x: 7, y: 3 },
  }).setOrigin(0.5, 0);

  const c = chipFor(row, summaryMap, actions);
  const chip = addText(scene, 0, 35, c.text, {
    fontSize: "9px", color: c.style.color, backgroundColor: c.style.bg, padding: { x: 6, y: 3 },
  }).setOrigin(0.5, 0);

  const figure = scene.add.container(0, 0, [ring, body, head, headHi, avatar, namePlate, chip]);
  return { figure, ring, chip };
}

function createChar(
  scene: PhaserType.Scene,
  row: AgentRow,
  idx: number,
  x: number,
  y: number,
  navigate: (id: string) => void,
  summaryMap: Map<string, string>,
  actions: Map<string, AgentLiveAction>,
): CharState {
  const { posture, av } = classify(row);
  const { figure, ring, chip } = buildFigure(scene, row, idx, posture, av, summaryMap, actions);

  const shadow = scene.add.ellipse(0, 17, 30, 8, 0x000000, 0.16);
  const outer = scene.add.container(x, y, [shadow, figure]);
  outer.setDepth(6).setSize(40, 50).setInteractive({ useHandCursor: true });

  outer.on("pointerover", () => {
    scene.tweens.add({ targets: figure, scaleX: 1.12, scaleY: 1.12, duration: 130, ease: "Back.easeOut" });
    chip.setDepth(1);
  });
  outer.on("pointerout", () => scene.tweens.add({ targets: figure, scaleX: 1, scaleY: 1, duration: 130 }));
  outer.on("pointerup", (p: PhaserType.Input.Pointer) => { if (p.getDistance() < 6) navigate(row.agent.id); });

  if (posture === "offline") {
    scene.tweens.add({ targets: figure, alpha: { from: 1, to: 0.55 }, duration: 2200, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
  }

  const c = chipFor(row, summaryMap, actions);
  return { container: outer, figure, ring, chip, posture, av, homeX: x, homeY: y, lastChip: c.text, walkingTo: null, deskIndex: idx, behaviorGen: 0 };
}

function refreshChip(st: CharState, row: AgentRow, summaryMap: Map<string, string>, actions: Map<string, AgentLiveAction>) {
  const c = chipFor(row, summaryMap, actions);
  if (c.text === st.lastChip) return;
  st.lastChip = c.text;
  st.chip.setText(c.text).setColor(c.style.color).setBackgroundColor(c.style.bg);
}

function transitionChar(
  scene: PhaserType.Scene,
  st: CharState,
  tx: number,
  ty: number,
  posture: Posture,
  av: string,
) {
  // Ring color follows the agent's state (working/queued/available/offline)
  st.ring.setFillStyle(ringColorFor(posture, av));
  st.av = av;

  if (st.walkingTo && Math.abs(st.walkingTo.x - tx) < 1 && Math.abs(st.walkingTo.y - ty) < 1) {
    st.posture = posture;
    return;
  }

  scene.tweens.killTweensOf(st.container);
  scene.tweens.killTweensOf(st.figure);
  st.figure.setScale(1);

  const dist = Math.hypot(tx - st.container.x, ty - st.container.y);
  if (dist < 5) {
    st.walkingTo = null;
    st.posture = posture;
    st.homeX = tx; st.homeY = ty;
    startBehavior(scene, st, posture, tx, ty);
    return;
  }

  st.walkingTo = { x: tx, y: ty };
  walkTo(scene, st, tx, ty, () => {
    st.walkingTo = null;
    st.posture = posture;
    st.homeX = tx; st.homeY = ty;
    startBehavior(scene, st, posture, tx, ty);
  });
}

// ─── Behaviors ───────────────────────────────────────────────────────────────

function startBehavior(scene: PhaserType.Scene, st: CharState, posture: Posture, homeX: number, homeY: number) {
  void homeX; void homeY;
  scene.tweens.killTweensOf(st.figure);
  st.figure.setPosition(0, 0).setScale(1);
  const gen = ++st.behaviorGen; // invalidates any in-flight wander chain

  if (posture === "working") {
    // focused typing — quick subtle vertical pulse
    scene.tweens.add({ targets: st.figure, y: -2, duration: 1300, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
  } else if (posture === "queued") {
    // impatient sway
    scene.tweens.add({ targets: st.figure, x: 2.5, duration: 480, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
  } else if (posture === "sleeping") {
    // relaxed breathing, then spontaneous lounge life (mingle / coffee / desk visit)
    breathe(scene, st);
    loungeLife(scene, st, gen);
  }
  // offline → no motion (alpha pulse set at creation)
}

function breathe(scene: PhaserType.Scene, st: CharState) {
  scene.tweens.add({ targets: st.figure, scaleX: 1.04, scaleY: 1.04, duration: 2400, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
}

// Idle agents loiter like real coworkers: they mostly stand still (just
// breathing), and only once in a while get up to mingle, grab a coffee or
// wander back to their desk. Long, randomised intervals keep it calm — not a
// museum where everyone is constantly walking. `gen` cancels the chain when
// the agent's behavior is restarted (e.g. it picks up a task).
function loungeLife(scene: PhaserType.Scene, st: CharState, gen: number) {
  // 10–40s between even *considering* a move, so the office feels settled.
  const dwell = 10000 + Math.random() * 30000;
  scene.time.delayedCall(dwell, () => {
    if (!st.container.scene || st.behaviorGen !== gen || st.posture !== "sleeping" || st.walkingTo) return;

    // Most of the time, just stay put and keep breathing.
    if (Math.random() < 0.6) { loungeLife(scene, st, gen); return; }

    const L = LOUNGE;
    let tx: number, ty: number;
    const roll = Math.random();
    if (!L) {
      tx = st.homeX; ty = st.homeY;
    } else if (roll < 0.5) {
      // shift around their own spot
      tx = st.homeX + (Math.random() * 2 - 1) * 2.4 * T;
      ty = st.homeY + (Math.random() * 2 - 1) * 1.4 * T;
    } else if (roll < 0.75) {
      // grab a coffee at the bar (top-left of the lounge)
      tx = L.x + (2 + Math.random() * 3) * T;
      ty = L.y + 2.2 * T;
    } else if (roll < 0.9) {
      // amble to another open spot in the lounge
      const m = 1.5 * T;
      tx = L.x + m + Math.random() * (L.w - 2 * m);
      ty = L.y + 3 * T + Math.random() * Math.max(T, L.h - 4 * T);
    } else {
      // wander back to their own desk and sit for a while
      const [dx, dy] = deskStandPos(st.deskIndex);
      tx = dx; ty = dy;
    }
    if (L) tx = Math.min(Math.max(tx, L.x + T), L.x + L.w - T);

    walkTo(scene, st, tx, ty, () => {
      if (!st.container.scene || st.behaviorGen !== gen || st.posture !== "sleeping") return;
      scene.tweens.killTweensOf(st.figure);
      st.figure.setPosition(0, 0);
      breathe(scene, st);
      loungeLife(scene, st, gen);
    });
  });
}

// ─── Walk — grounded shadow + stepping bob ────────────────────────────────────

function walkTo(scene: PhaserType.Scene, st: CharState, tx: number, ty: number, onDone: () => void) {
  const outer = st.container, fig = st.figure;
  const dist = Math.hypot(tx - outer.x, ty - outer.y);
  const duration = Math.max(420, dist * 3.2);

  scene.tweens.add({
    targets: outer, x: tx, y: ty, duration, ease: "Sine.easeInOut",
    onComplete: () => {
      scene.tweens.killTweensOf(fig);
      scene.tweens.add({ targets: fig, y: 0, scaleX: 1, scaleY: 1, duration: 130, ease: "Quad.easeOut", onComplete: onDone });
    },
  });

  // stepping bob + subtle squash while in transit
  scene.tweens.killTweensOf(fig);
  scene.tweens.add({ targets: fig, y: -5, duration: 230, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
  scene.tweens.add({ targets: fig, scaleY: 0.94, scaleX: 1.05, duration: 230, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
}

// ═══════════════════════════════════════════════════════════════════════════
// Delegation links — dashed line + arrow + traveling pulse, parent → child
// ═══════════════════════════════════════════════════════════════════════════

function drawDelegations(scene: PhaserType.Scene, edges: DelegationEdge[], charMap: Map<string, CharState>, track: Track) {
  for (const edge of edges) {
    const from = charMap.get(edge.fromAgentId);
    const to = charMap.get(edge.toAgentId);
    if (!from || !to || !from.container.scene || !to.container.scene) continue;

    const fx = from.container.x, fy = from.container.y;
    const tx = to.container.x, ty = to.container.y;
    const dx = tx - fx, dy = ty - fy;
    const len = Math.hypot(dx, dy);
    if (len < 24) continue;
    const ux = dx / len, uy = dy / len;
    const s0 = 22, s1 = 24;

    const g = track(scene.add.graphics().setDepth(5).setAlpha(0.8));
    let d = s0;
    while (d < len - s1) {
      const e = Math.min(d + 8, len - s1);
      g.lineStyle(2, 0x6366f1, 1).lineBetween(fx + ux * d, fy + uy * d, fx + ux * e, fy + uy * e);
      d += 13;
    }
    const ang = Math.atan2(dy, dx);
    const ax = tx - ux * s1, ay = ty - uy * s1;
    g.fillStyle(0x6366f1, 1).fillTriangle(
      ax + ux * 8, ay + uy * 8,
      ax + Math.cos(ang + 2.4) * 7, ay + Math.sin(ang + 2.4) * 7,
      ax + Math.cos(ang - 2.4) * 7, ay + Math.sin(ang - 2.4) * 7,
    );

    track(addText(scene, (fx + tx) / 2, (fy + ty) / 2 - 9, "delegated", {
      fontSize: "8px", color: "#4f46e5", backgroundColor: "#eef2ff", padding: { x: 5, y: 2 },
    }).setDepth(5).setOrigin(0.5, 1).setAlpha(0.9));

    const x0 = fx + ux * s0, y0 = fy + uy * s0;
    const x1 = tx - ux * s1, y1 = ty - uy * s1;
    const dot = track(scene.add.circle(x0, y0, 4, 0x818cf8).setDepth(7).setAlpha(0.95));
    scene.tweens.add({
      targets: dot, x: x1, y: y1, duration: 1000, ease: "Sine.easeIn", repeat: -1,
      onRepeat: () => (dot as unknown as { setPosition: (x: number, y: number) => void }).setPosition(x0, y0),
    });
  }
}

// ─── Color blend ───────────────────────────────────────────────────────────
function blend(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}
