/* Small construction kit for the two dry interiors. Static fittings are
   merged by material, so rivets, pipes and panel seams do not cost a draw each. */
import * as THREE from "three";
import { mergeGeometries } from "./geo.js";

export class InteriorKit {
  constructor(scene, boxes = []) {
    this.scene = scene;
    this.boxes = boxes;
    this.parts = new Map();
    this.textures = [];
  }
  material(color, metalness = 0.25, roughness = 0.65, glow = 0) {
    return new THREE.MeshStandardMaterial({ color, metalness, roughness,
      emissive: glow, emissiveIntensity: 0.65 });
  }
  add(geometry, material, x, y, z, rotation = [0, 0, 0]) {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1));
    geometry.applyMatrix4(matrix);
    if (!this.parts.has(material)) this.parts.set(material, []);
    this.parts.get(material).push(geometry);
  }
  box(w, h, d, m, x, y, z, collide = false, rotation) {
    this.add(new THREE.BoxGeometry(w, h, d), m, x, y, z, rotation);
    if (collide) this.boxes.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
  }
  cylinder(r, length, m, x, y, z, rotation = [0, 0, 0], segments = 12) {
    this.add(new THREE.CylinderGeometry(r, r, length, segments), m, x, y, z, rotation);
  }
  ring(r, thickness, m, x, y, z, rotation = [0, 0, 0]) {
    this.add(new THREE.TorusGeometry(r, thickness, 6, 32), m, x, y, z, rotation);
  }
  line(a, b, radius, material) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const g = new THREE.CylinderGeometry(radius, radius, start.distanceTo(end), 6);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize()));
    const mid = start.add(end).multiplyScalar(0.5);
    this.add(g, material, mid.x, mid.y, mid.z);
  }
  sign(title, subtitle, width, x, y, z, yaw = 0, color = "#7fe2d2") {
    const canvas = document.createElement("canvas");
    canvas.width = 1024; canvas.height = 256;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0b202b"; ctx.fillRect(0, 0, 1024, 256);
    ctx.fillStyle = color; ctx.fillRect(0, 0, 8, 256);
    ctx.fillStyle = color; ctx.font = "bold 68px monospace";
    ctx.fillText(title, 42, 108, 940);
    ctx.fillStyle = "#94b1ba"; ctx.font = "30px monospace";
    ctx.fillText(subtitle, 44, 182, 930);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace; this.textures.push(texture);
    this.add(new THREE.PlaneGeometry(width, width / 4),
      new THREE.MeshBasicMaterial({ map: texture }), x, y, z, [0, yaw, 0]);
  }
  finish() {
    for (const [material, parts] of this.parts) {
      const mesh = new THREE.Mesh(mergeGeometries(parts), material);
      this.scene.add(mesh);
      parts.forEach((p) => p.dispose());
    }
    this.parts.clear();
  }
  disposeTextures() { this.textures.forEach((t) => t.dispose()); }
}

/* A stylised external view, not a second expensive render of the entire sea.
   Depth changes the light; silhouettes have fins/tails rather than black blobs. */
export function seaWindow() {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, depth: { value: 30 } },
    side: THREE.DoubleSide,
    vertexShader: "varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
    fragmentShader: `varying vec2 vUv; uniform float time; uniform float depth;
      float ellipse(vec2 p, vec2 size){return 1.-smoothstep(.88,1.,length(p/size));}
      void main(){
        float dark=clamp(depth/1000.,0.,.85);
        vec3 c=mix(vec3(.012,.07,.105),vec3(.09,.36,.43),vUv.y)*(1.-dark);
        c+=vec3(.015,.055,.06)*pow(.5+.5*sin(vUv.x*21.+vUv.y*4.+time*.18),7.)*vUv.y*(1.-dark);
        for(int i=0;i<7;i++){
          float fi=float(i);vec2 p=vUv-vec2(fract(time*(.006+fi*.002)+fi*.173)*1.4-.2,.22+fi*.092);
          float body=ellipse(p,vec2(.022,.007));
          float tail=step(-.036,p.x)*step(p.x,-.017)*step(abs(p.y),(-p.x-.016)*.6);
          c=mix(c,vec3(.015,.085,.10)*(1.-dark),max(body,tail)*.85);
        }
        float speck=pow(max(0.,sin(vUv.x*241.+time*.15)*sin(vUv.y*187.-time*.1)),36.);
        c+=vec3(.07,.20,.20)*speck;
        gl_FragColor=vec4(c,1.);
      }`,
  });
}
