import "../../styles/public-starfield.css";

type StarPoint = readonly [x: number, y: number];

const starGroups = [
  {
    tone: "primary",
    points: [
      [231, 520], [1337, 355], [327, 589], [471, 634], [684, 648],
      [865, 58], [1091, 305], [1523, 336], [258, 189], [1002, 384],
      [228, 671], [1571, 729], [1299, 579], [669, 854], [1372, 696],
      [936, 771], [466, 387], [343, 422], [36, 654], [305, 828],
      [119, 27], [515, 210], [378, 62], [63, 424], [1361, 846],
      [1009, 585]
    ]
  },
  {
    tone: "secondary",
    points: [
      [756, 537], [1411, 320], [487, 471], [137, 366], [247, 83],
      [500, 739], [1083, 77], [622, 81], [157, 173], [1443, 563],
      [278, 733], [999, 850], [1484, 111], [1063, 692], [568, 416],
      [283, 358], [1231, 776], [68, 847], [1418, 785], [389, 517],
      [1184, 88], [1531, 555], [767, 356], [1469, 216], [559, 275]
    ]
  },
  {
    tone: "tertiary",
    points: [
      [970, 529], [1394, 437], [1086, 794], [1297, 260], [729, 30],
      [756, 110], [253, 588], [548, 499], [968, 634], [1301, 68],
      [360, 866], [751, 702], [848, 751], [652, 382], [1263, 194],
      [1374, 162], [1142, 175], [1165, 360], [1484, 768], [331, 111],
      [1471, 690], [1159, 670]
    ]
  }
] as const satisfies readonly {
  tone: "primary" | "secondary" | "tertiary";
  points: readonly StarPoint[];
}[];

const starPaths = starGroups.map(({ tone, points }) => ({
  tone,
  // A tiny horizontal segment with a round cap renders as a screen-sized dot.
  // Fixed coordinates keep the constellation stable while avoiding a tiled grid.
  path: points.map(([x, y]) => `M${x} ${y}h.01`).join(" ")
}));

export function PublicStarfield() {
  return (
    <svg
      className="public-starfield"
      viewBox="0 0 1600 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {starPaths.map(({ tone, path }) => (
        <g key={tone}>
          <path className={`public-starfield-${tone}-halo`} d={path} />
          <path className={`public-starfield-${tone}`} d={path} />
        </g>
      ))}
    </svg>
  );
}
