import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ScaleType } from "@h5web/lib";
import type { ColorMap, ColorScaleType, Domain } from "@h5web/lib";
import type { DetectorImageResult } from "../lib/event-data";
import type { Panel3D } from "../lib/panel3d";
import { imageToRGBA } from "../lib/colormap";

/**
 * Mantid-style instrument view: every detector panel drawn as a textured quad
 * at its true lab-frame position, with the sample at the origin.
 *
 * Panels are textured from the same `DetectorImageResult` the 2D views use, so
 * the TOF slider drives this view for free.
 *
 * Deliberately plain three.js rather than @react-three/fiber, even though the
 * app depends on both. h5web pulls in its own copy of react-three-fiber, and
 * Vite's dependency optimiser leaves us with two separate instances, each with
 * its own render-loop state. A Canvas mounted from our copy would build its
 * scene correctly and then never draw, because the loop's `running` flag
 * belonged to the other instance. Owning the renderer and the animation frame
 * outright removes that entire class of problem, and for a static set of quads
 * it is less code than the declarative version. Still no new dependencies:
 * three and OrbitControls are already here.
 *
 * This is one WebGL context — which is why it is a view *mode*, never shown
 * beside a grid of panels (see PanelThumbnail for the context-limit story).
 */

interface Props {
  /**
   * Explicit pixel height for the viewport. The renderer sizes itself from the
   * container, which therefore needs a definite height.
   */
  height: number;
  panels3d: Panel3D[];
  /** Keyed by panel name; panels with no entry render untextured. */
  imagesByName: Map<string, DetectorImageResult>;
  domain: Domain;
  colorScale?: ColorScaleType;
  colorMap?: ColorMap | "Greys_r";
  /** Called with the panel name when one is clicked. */
  onSelect?: (name: string) => void;
}

const UNTEXTURED = 0x6b7280;

/** Basis matrix taking local (x=fast, y=slow, z=normal) into the lab frame. */
function panelMatrix(p: Panel3D): THREE.Matrix4 {
  const f = new THREE.Vector3(...p.fastAxis).normalize();
  const s = new THREE.Vector3(...p.slowAxis).normalize();
  const n = new THREE.Vector3().crossVectors(f, s).normalize();
  const m = new THREE.Matrix4().makeBasis(f, s, n);
  m.setPosition(new THREE.Vector3(...p.center));
  return m;
}

function makeTexture(image: DetectorImageResult, domain: Domain,
                     scale: ColorScaleType, colorMap: string): THREE.DataTexture {
  const [rows, cols] = image.shape;
  // No row flip: a DataTexture samples bottom-up, matching h5web putting
  // detector row 0 at the bottom.
  const rgba = imageToRGBA(image.image, rows, cols, domain as [number, number],
                           scale, colorMap, false);
  const t = new THREE.DataTexture(new Uint8Array(rgba.buffer), cols, rows);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export function Instrument3D({
  height,
  panels3d,
  imagesByName,
  domain,
  colorScale = ScaleType.Linear,
  colorMap = "Viridis" as ColorMap | "Greys_r",
  onSelect,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const meshesRef = useRef(new Map<string, THREE.Mesh>());
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  // Props the animation loop and click handler read without re-subscribing.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Scene lifetime is tied to the geometry: new panels mean a new instrument.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || panels3d.length === 0) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x10141a);

    // Frame the instrument: furthest panel corner sets distance and marker size.
    let radius = 0.1;
    for (const p of panels3d) {
      radius = Math.max(radius, Math.hypot(...p.center) + Math.max(p.width, p.height) / 2);
    }

    const camera = new THREE.PerspectiveCamera(
      45, Math.max(mount.clientWidth, 1) / Math.max(mount.clientHeight, 1),
      radius / 100, radius * 50
    );
    camera.position.set(radius * 1.8, radius * 1.2, radius * 1.8);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.target.set(0, 0, 0);
    controls.update();

    const meshes = new Map<string, THREE.Mesh>();
    for (const p of panels3d) {
      const geom = new THREE.PlaneGeometry(p.width, p.height);
      const mat = new THREE.MeshBasicMaterial({
        color: UNTEXTURED, side: THREE.DoubleSide, toneMapped: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(panelMatrix(p));
      mesh.name = p.name;
      scene.add(mesh);
      meshes.set(p.name, mesh);
    }

    // Sample marker, beam along z, and lab axes for orientation.
    const sample = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.035, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xe8b84b })
    );
    scene.add(sample);

    const beamGeom = new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, -radius * 3, 0, 0, radius * 3], 3)
    );
    const beam = new THREE.Line(beamGeom, new THREE.LineBasicMaterial({ color: 0x8899aa }));
    scene.add(beam);

    const axes = new THREE.AxesHelper(radius * 0.6);
    scene.add(axes);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    meshesRef.current = meshes;

    // Own the animation frame outright — no shared scheduler to fight.
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(mount);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { downAt = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      // Ignore the pointer-up that ends an orbit drag.
      if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1,
                  -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects([...meshes.values()], false)[0];
      if (hit) onSelectRef.current?.(hit.object.name);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material & { map?: THREE.Texture };
        if (mat) { mat.map?.dispose(); mat.dispose?.(); }
      });
      beamGeom.dispose();
      axes.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      meshesRef.current = new Map();
    };
  }, [panels3d]);

  // Re-texture in place whenever the counts or colour mapping change. Kept
  // separate from scene construction so a TOF change does not rebuild the scene.
  useEffect(() => {
    const meshes = meshesRef.current;
    if (meshes.size === 0) return;
    for (const [name, mesh] of meshes) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      const image = imagesByName.get(name);
      const old = mat.map;
      if (image) {
        mat.map = makeTexture(image, domain, colorScale, colorMap);
        mat.color.set(0xffffff);
      } else {
        mat.map = null;
        mat.color.set(UNTEXTURED);
      }
      mat.needsUpdate = true;
      old?.dispose();
    }
  }, [imagesByName, domain, colorScale, colorMap, panels3d]);

  if (panels3d.length === 0) {
    return (
      <div className="instrument3d-empty" style={{ height }}>
        No detector geometry found in this file.
        <br />
        <span>
          Needs NXlauetof axis datasets, a NeXus <code>depends_on</code> chain,
          or a Mantid IDF at <code>instrument_xml</code>.
        </span>
      </div>
    );
  }

  return (
    <div className="instrument3d" style={{ height }}>
      <div ref={mountRef} className="instrument3d-mount" />
      <div className="instrument3d-hint">
        drag: rotate · wheel: zoom · right-drag: pan · click a panel to open it ·{" "}
        {panels3d.length} panels
      </div>
    </div>
  );
}
