import { Color, MathUtils, Vector3, type Node } from "three/webgpu";
import {
  Fn,
  cameraPosition,
  dot,
  exp,
  float,
  fog,
  hash,
  max,
  mix,
  normalize,
  positionView,
  positionWorld,
  select,
  smoothstep,
  uniform,
  vec3,
} from "three/tsl";

const SEA_LEVEL = 62;
const WHITE = new Color(0xffffff);
/** Altitude over which the haze thins by a factor of e. */
const HAZE_HEIGHT = 140;

interface SkyState {
  readonly zenith: Color;
  readonly horizon: Color;
  readonly sun: Color;
  readonly sunIntensity: number;
  readonly ambient: number;
}

// Sky palettes by sun elevation in degrees, interpolated in between.
const SKY_KEYS: ReadonlyArray<readonly [number, SkyState]> = [
  [
    -12,
    {
      zenith: new Color(0x070d1f),
      horizon: new Color(0x16203a),
      sun: new Color(0x8ea6e6),
      sunIntensity: 0.55,
      ambient: 0.34,
    },
  ],
  [
    -2,
    {
      zenith: new Color(0x16213f),
      horizon: new Color(0x9a6a5c),
      sun: new Color(0xff7a45),
      sunIntensity: 0.35,
      ambient: 0.45,
    },
  ],
  [
    6,
    {
      zenith: new Color(0x2f5aa8),
      horizon: new Color(0xffb27a),
      sun: new Color(0xffa25e),
      sunIntensity: 1.6,
      ambient: 0.74,
    },
  ],
  [
    18,
    {
      zenith: new Color(0x3b73cf),
      horizon: new Color(0xd9c2a8),
      sun: new Color(0xffd5a1),
      sunIntensity: 2.15,
      ambient: 0.84,
    },
  ],
  [
    45,
    {
      zenith: new Color(0x3d7ad8),
      horizon: new Color(0xb9d3ec),
      sun: new Color(0xfff1dc),
      sunIntensity: 2.4,
      ambient: 0.9,
    },
  ],
  [
    90,
    {
      zenith: new Color(0x3a76d6),
      horizon: new Color(0xb3cfee),
      sun: new Color(0xfff6ea),
      sunIntensity: 2.5,
      ambient: 0.92,
    },
  ],
];

/** Lighting values the scene applies to its sun and sky lights. */
export interface Daylight {
  readonly direction: Vector3;
  readonly sunColor: Color;
  readonly sunIntensity: number;
  readonly skyColor: Color;
  readonly groundColor: Color;
  readonly ambientIntensity: number;
  readonly daylight: number;
}

/**
 * Sky, fog, and sun state shared by every material. The sky and the fog read the
 * same uniforms, so distant terrain melts into the horizon behind it.
 */
export class Atmosphere {
  readonly sunDirection = uniform(new Vector3(0.4, 0.7, 0.3));
  readonly sunColor = uniform(new Color(0xfff1dc));
  readonly zenith = uniform(new Color(0x3d7ad8));
  readonly horizon = uniform(new Color(0xb9d3ec));
  /** Blocks from the camera where streamed terrain ends and fully fades into the sky. */
  readonly viewDistance = uniform(2400);
  /** 1 in daylight and 0 at night, for effects that change with the light, like glowing blocks. */
  readonly daylight = uniform(1);

  /** Sky radiance in a world direction. The sun disc is bright enough to bloom. */
  readonly sky = Fn(([direction]: [Node<"vec3">]) => {
    const up = max(direction.y, 0);
    const gradient = mix(this.horizon, this.zenith, up.pow(0.42));
    const belowHorizon = mix(
      this.horizon,
      this.horizon.mul(0.55),
      direction.y.negate().clamp(0, 1).pow(0.6),
    );
    const base = select(direction.y.greaterThanEqual(0), gradient, belowHorizon);
    const toSun = max(dot(direction, this.sunDirection), 0);
    const glow = this.sunColor.mul(toSun.pow(6).mul(0.28).add(toSun.pow(80).mul(0.9)));
    const disc = this.sunColor.mul(smoothstep(0.99955, 0.99975, toSun).mul(24));

    // After dusk, stars and a pale moon opposite the sun fade in.
    const night = float(1).sub(this.daylight).pow(2);
    const cell = direction.mul(360).floor();
    const star = hash(cell.x.add(cell.y.mul(113)).add(cell.z.mul(769)));
    const stars = smoothstep(0.9975, 1, star).mul(3).mul(up.mul(4).clamp(0, 1));
    const toMoon = max(dot(direction, this.sunDirection.negate()), 0);
    const moon = smoothstep(0.99965, 0.9998, toMoon).mul(2.2).add(toMoon.pow(40).mul(0.12));
    const nightSky = vec3(0.85, 0.9, 1).mul(stars.add(moon)).mul(night);
    return base.add(glow).add(disc).add(nightSky);
  });

  /** Haze color along a view direction, flattened toward the horizon and without the disc. */
  readonly haze = Fn(([direction]: [Node<"vec3">]) => {
    const flattened = normalize(vec3(direction.x, max(direction.y.mul(0.35), 0.015), direction.z));
    const toSun = max(dot(flattened, this.sunDirection), 0);
    const base = mix(this.horizon, this.zenith, flattened.y.pow(0.42));
    return base.add(this.sunColor.mul(toSun.pow(6).mul(0.22)));
  });

  /**
   * Height fog: haze is densest at sea level and thins with altitude, so a view from
   * high above stays clear while the horizon still fades. Terrain also fades out
   * before the streaming distance, so the world never ends at a visible edge.
   */
  readonly fogNode = Fn(() => {
    const distance = positionView.length();
    const cameraHeight = cameraPosition.y.sub(SEA_LEVEL).div(HAZE_HEIGHT).max(0);
    const pointHeight = positionWorld.y.sub(SEA_LEVEL).div(HAZE_HEIGHT).max(0);
    const rise = pointHeight.sub(cameraHeight);
    // Mean of exp(-height) along the ray, the closed form of the height fog integral.
    const meanDensity = select(
      rise.abs().lessThan(0.001),
      exp(cameraHeight.negate()),
      exp(cameraHeight.negate()).sub(exp(pointHeight.negate())).div(rise),
    );
    const haze = float(1).sub(
      exp(distance.mul(meanDensity).mul(2.1).div(this.viewDistance).negate()),
    );
    const edge = smoothstep(this.viewDistance.mul(0.7), this.viewDistance.mul(0.97), distance);
    const direction = normalize(positionWorld.sub(cameraPosition));
    return fog(this.haze(direction), max(haze, edge).clamp(0, 1));
  })();

  /**
   * Moves the sun along its arc. Hour 12 is noon; the sun rises in the east (+x),
   * sets in the west, and leans south (+z) so shadows fall toward the north.
   */
  setTimeOfDay(hour: number): Daylight {
    const angle = ((hour - 6) / 12) * Math.PI;
    const elevation = Math.sin(angle) * 64;
    const radians = MathUtils.degToRad(elevation);
    const direction = new Vector3(
      Math.cos(angle) * Math.cos(radians),
      Math.sin(radians),
      0.42 * Math.cos(radians),
    ).normalize();
    // At night the moon takes over from the opposite side of the sky.
    const lightDirection = elevation < -4 ? direction.clone().multiplyScalar(-1) : direction;
    const state = skyAt(elevation);

    const daylight = MathUtils.smoothstep(elevation, -10, 8);
    this.daylight.value = daylight;
    this.sunDirection.value.copy(direction);
    this.sunColor.value.copy(state.sun);
    this.zenith.value.copy(state.zenith);
    this.horizon.value.copy(state.horizon);
    return {
      direction: lightDirection,
      sunColor: state.sun,
      sunIntensity: state.sunIntensity,
      // Daytime sky light is paler than the sky, so shaded faces keep their own color.
      skyColor: state.zenith
        .clone()
        .lerp(state.horizon, 0.5)
        .lerp(WHITE, 0.4 * daylight),
      groundColor: new Color(0xb09c80).multiplyScalar(Math.max(0.15, state.ambient)),
      ambientIntensity: state.ambient,
      daylight,
    };
  }
}

function skyAt(elevation: number): SkyState {
  const upper = SKY_KEYS.findIndex(([key]) => key >= elevation);
  if (upper <= 0) return SKY_KEYS[Math.max(0, upper)]![1];
  const [lowKey, low] = SKY_KEYS[upper - 1]!;
  const [highKey, high] = SKY_KEYS[upper]!;
  const amount = (elevation - lowKey) / (highKey - lowKey);
  return {
    zenith: low.zenith.clone().lerp(high.zenith, amount),
    horizon: low.horizon.clone().lerp(high.horizon, amount),
    sun: low.sun.clone().lerp(high.sun, amount),
    sunIntensity: MathUtils.lerp(low.sunIntensity, high.sunIntensity, amount),
    ambient: MathUtils.lerp(low.ambient, high.ambient, amount),
  };
}
