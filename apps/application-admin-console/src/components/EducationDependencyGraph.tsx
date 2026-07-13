import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type {
  EducationGraphNode,
  EducationGraphResponse,
  EducationNodeType,
} from "../api/education-graph-client";

type TFn = (key: string) => string;

const TYPE_ORDER: readonly EducationNodeType[] = [
  "problem",
  "learning_objective",
  "concept",
  "assessment_criterion",
  "misconception",
  "audience",
];

const NODE_COLORS: Readonly<Record<EducationNodeType, { fill: string; text: string }>> = {
  problem: { fill: "#0972d3", text: "#ffffff" },
  learning_objective: { fill: "#d1f1ff", text: "#0f1b2a" },
  concept: { fill: "#e9ebed", text: "#0f1b2a" },
  assessment_criterion: { fill: "#d5f2e2", text: "#0f1b2a" },
  misconception: { fill: "#ffe3c2", text: "#0f1b2a" },
  audience: { fill: "#ebe5ff", text: "#0f1b2a" },
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 64;
const COLUMN_GAP = 48;
const ROW_GAP = 32;
const PADDING = 24;

interface NodePosition {
  readonly x: number;
  readonly y: number;
}

function layoutNodes(nodes: readonly EducationGraphNode[]): {
  readonly positions: ReadonlyMap<string, NodePosition>;
  readonly width: number;
  readonly height: number;
} {
  const activeTypes = TYPE_ORDER.filter((type) => nodes.some((node) => node.type === type));
  const positions = new Map<string, NodePosition>();
  let maxRows = 1;
  for (const [column, type] of activeTypes.entries()) {
    const columnNodes = nodes.filter((node) => node.type === type);
    maxRows = Math.max(maxRows, columnNodes.length);
    for (const [row, node] of columnNodes.entries()) {
      positions.set(node.id, {
        x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
      });
    }
  }
  return {
    positions,
    width: PADDING * 2 + activeTypes.length * NODE_WIDTH + (activeTypes.length - 1) * COLUMN_GAP,
    height: PADDING * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * ROW_GAP,
  };
}

export function EducationDependencyGraph({
  graph,
  t,
}: {
  readonly graph: EducationGraphResponse;
  readonly t: TFn;
}) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const layout = layoutNodes(graph.nodes);
  const nodeTypeLabel = (type: EducationNodeType) => t(`education_graph.node_type_${type}`);
  const relationTypeLabel = (type: string) => t(`education_graph.relation_${type}`);

  return (
    <SpaceBetween size="m">
      <div style={{ maxWidth: "100%", overflowX: "auto" }}>
        <svg
          aria-hidden="true"
          data-testid="education-graph-svg"
          focusable="false"
          height={layout.height}
          style={{ display: "block", minWidth: `${layout.width}px` }}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
        >
          <defs>
            <marker
              id="education-graph-arrow"
              markerHeight="8"
              markerWidth="8"
              orient="auto"
              refX="7"
              refY="4"
              viewBox="0 0 8 8"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#5f6b7a" />
            </marker>
          </defs>
          {graph.relations.map((relation) => {
            const source = layout.positions.get(relation.source);
            const target = layout.positions.get(relation.target);
            if (!source || !target) return null;
            const x1 = source.x + NODE_WIDTH;
            const y1 = source.y + NODE_HEIGHT / 2;
            const x2 = target.x;
            const y2 = target.y + NODE_HEIGHT / 2;
            return (
              <g key={`${relation.source}-${relation.type}-${relation.target}`}>
                <line
                  markerEnd="url(#education-graph-arrow)"
                  stroke="#5f6b7a"
                  strokeWidth="2"
                  x1={x1}
                  x2={x2}
                  y1={y1}
                  y2={y2}
                />
                <text
                  fill="#414d5c"
                  fontSize="11"
                  textAnchor="middle"
                  x={(x1 + x2) / 2}
                  y={(y1 + y2) / 2 - 6}
                >
                  {relationTypeLabel(relation.type)}
                </text>
              </g>
            );
          })}
          {graph.nodes.map((node) => {
            // `layoutNodes` receives this exact array and assigns every valid node id.
            const position = layout.positions.get(node.id) as NodePosition;
            const colors = NODE_COLORS[node.type];
            return (
              <g key={node.id} transform={`translate(${position.x} ${position.y})`}>
                <title>{`${nodeTypeLabel(node.type)}: ${node.label}`}</title>
                <rect
                  fill={colors.fill}
                  height={NODE_HEIGHT}
                  rx="8"
                  stroke="#5f6b7a"
                  width={NODE_WIDTH}
                />
                <text fill={colors.text} fontSize="11" fontWeight="700" x="12" y="20">
                  {nodeTypeLabel(node.type)}
                </text>
                <foreignObject height="30" width={NODE_WIDTH - 24} x="12" y="27">
                  <div
                    style={{
                      color: colors.text,
                      fontSize: "13px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {node.label}
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </svg>
      </div>

      <Box variant="h3">{t("education_graph.nodes_heading")}</Box>
      <ul aria-label={t("education_graph.nodes_label")}>
        {graph.nodes.map((node) => (
          <li key={node.id}>
            {node.label} — {nodeTypeLabel(node.type)}
          </li>
        ))}
      </ul>

      <Box variant="h3">{t("education_graph.relations_heading")}</Box>
      <ul aria-label={t("education_graph.relations_label")}>
        {graph.relations.map((relation) => {
          const source = nodeById.get(relation.source);
          const target = nodeById.get(relation.target);
          const sourceLabel = source
            ? `${source.label} (${nodeTypeLabel(source.type)})`
            : relation.source;
          const targetLabel = target
            ? `${target.label} (${nodeTypeLabel(target.type)})`
            : relation.target;
          return (
            <li key={`${relation.source}-${relation.type}-${relation.target}`}>
              {sourceLabel} — {relationTypeLabel(relation.type)} → {targetLabel}
            </li>
          );
        })}
      </ul>
    </SpaceBetween>
  );
}
