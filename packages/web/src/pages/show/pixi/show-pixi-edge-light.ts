import { MeshSimple, Texture } from "pixi.js";
import type { PointerMagnetTransform } from "../../../lib/ui/pointer-magnet.js";

type ProjectPoint = (x: number, y: number, output: Float32Array, offset: number) => void;
type EdgePaint = { color: number; alpha: number };
const arcSteps = 6;
const straightSteps = 16;
const pointCount = 4 * (arcSteps + straightSteps);

// Only the mouse-owned card allocates this narrow border mesh. Its tiny ramp
// texture contains the original bright border blended into its local highlight.
// Pointer movement updates buffers, never a card snapshot or a second outline.
export class ShowPixiEdgeLight {
  readonly mesh: MeshSimple;
  readonly #local = new Float32Array(pointCount * 4);
  readonly #positions = new Float32Array(pointCount * 4);
  readonly #uvs = new Float32Array(pointCount * 4);
  #width = 0;
  #height = 0;
  #renderScale = 0;

  constructor(border: EdgePaint, light: EdgePaint) {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const ramp = context.createImageData(128, 1);
    for (let pixel = 0; pixel < 128; pixel += 1) {
      const lightAlpha = light.alpha * (1 - pixel / 127);
      const borderAlpha = border.alpha * (1 - lightAlpha);
      const alpha = lightAlpha + borderAlpha;
      for (let channel = 0; channel < 3; channel += 1) {
        const shift = (2 - channel) * 8;
        const lightValue = (light.color >> shift) & 255;
        const borderValue = (border.color >> shift) & 255;
        ramp.data[pixel * 4 + channel] = alpha > 0
          ? Math.round((lightValue * lightAlpha + borderValue * borderAlpha) / alpha)
          : 0;
      }
      ramp.data[pixel * 4 + 3] = Math.round(alpha * 255);
    }
    context.putImageData(ramp, 0, 0);
    const texture = Texture.from(canvas);
    texture.source.scaleMode = "linear";
    const indices = new Uint32Array(pointCount * 6);
    for (let point = 0; point < pointCount; point += 1) {
      const outer = point * 2;
      const next = (point + 1) % pointCount * 2;
      indices.set([outer, next, outer + 1, next, next + 1, outer + 1], point * 6);
    }
    this.mesh = new MeshSimple({
      texture, vertices: this.#positions, uvs: this.#uvs, indices,
      roundPixels: false
    });
    this.mesh.autoUpdate = false;
    this.mesh.eventMode = "none";
  }

  update(
    width: number,
    height: number,
    renderScale: number,
    magnet: PointerMagnetTransform,
    project: ProjectPoint
  ) {
    if (width !== this.#width || height !== this.#height || renderScale !== this.#renderScale) {
      this.#width = width;
      this.#height = height;
      this.#renderScale = renderScale;
      this.#layout();
    }
    for (let offset = 0; offset < this.#local.length; offset += 4) {
      const x = this.#local[offset]!;
      const y = this.#local[offset + 1]!;
      const distance = Math.min(1, Math.hypot(
        x / (width / 2) - magnet.normalizedX,
        y / (height / 2) - magnet.normalizedY
      ) / 1.3);
      // Encode both the radial falloff and the center-to-edge strength in the
      // same ramp, matching the gallery's 65% ellipse and magnet opacity.
      const u = (0.5 + (1 - (1 - distance) * magnet.edgeStrength) * 127) / 128;
      this.#uvs[offset] = this.#uvs[offset + 2] = u;
      this.#uvs[offset + 1] = this.#uvs[offset + 3] = 0.5;
      project(x, y, this.#positions, offset);
      project(this.#local[offset + 2]!, this.#local[offset + 3]!, this.#positions, offset + 2);
    }
    this.mesh.geometry.getBuffer("aPosition").update();
    this.mesh.geometry.getBuffer("aUV").update();
  }

  #layout() {
    const halfWidth = this.#width / 2;
    const halfHeight = this.#height / 2;
    const border = Math.min(halfWidth, halfHeight, 1 / this.#renderScale);
    const radius = Math.min(halfWidth, halfHeight, 6 / this.#renderScale);
    let offset = 0;
    const append = (x: number, y: number, normalX: number, normalY: number) => {
      this.#local[offset++] = x;
      this.#local[offset++] = y;
      this.#local[offset++] = x - normalX * border;
      this.#local[offset++] = y - normalY * border;
    };
    for (let corner = 0; corner < 4; corner += 1) {
      const signX = corner === 0 || corner === 3 ? 1 : -1;
      const signY = corner < 2 ? 1 : -1;
      const centerX = signX * (halfWidth - radius);
      const centerY = signY * (halfHeight - radius);
      const start = corner * Math.PI / 2;
      for (let step = 0; step < arcSteps; step += 1) {
        const angle = start + step / arcSteps * Math.PI / 2;
        const normalX = Math.cos(angle);
        const normalY = Math.sin(angle);
        append(centerX + radius * normalX, centerY + radius * normalY, normalX, normalY);
      }
      const end = start + Math.PI / 2;
      const normalX = Math.cos(end);
      const normalY = Math.sin(end);
      const edgeLength = corner % 2 === 0 ? this.#width - radius * 2 : this.#height - radius * 2;
      for (let step = 0; step < straightSteps; step += 1) {
        const along = step / straightSteps * edgeLength;
        append(
          centerX + radius * normalX - normalY * along,
          centerY + radius * normalY + normalX * along,
          normalX, normalY
        );
      }
    }
  }

  destroy() {
    const geometry = this.mesh.geometry;
    this.mesh.parent?.removeChild(this.mesh);
    this.mesh.destroy({ texture: true, textureSource: true });
    geometry.destroy();
  }
}
