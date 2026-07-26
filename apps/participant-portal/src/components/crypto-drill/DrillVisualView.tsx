/**
 * 図解 (`DrillVisual`) の描画。
 *
 * 値は `@tenkacloud/crypto-drill` が参照実装から起こしたものをそのまま描くだけで、この
 * component は計算をしない (表示と採点の期待値が別経路になると必ずずれる)。
 *
 * 5 種類の `kind` を 1 つの component で受けるのは、節ごとに「どの図か」を data で宣言させる
 * ためである。節を書き足すときに component を増やさずに済む。
 */

import Box from "@cloudscape-design/components/box";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import type {
  BitLane,
  DrillVisual,
  LocaleCode,
  RoundRow,
  TruthRow,
  WordRow,
} from "@tenkacloud/crypto-drill";
import { localize, nibbleDiffFlags } from "@tenkacloud/crypto-drill";
import "./crypto-drill.css";

/** bit 列を `groupSize` 桁ずつ空白で区切って読めるようにする。 */
export function groupBits(bits: string, groupSize: number): readonly string[] {
  if (groupSize <= 0) return [bits];
  const groups: string[] = [];
  for (let i = 0; i < bits.length; i += groupSize) {
    groups.push(bits.slice(i, i + groupSize));
  }
  return groups;
}

function LaneNote({
  lane,
  locale,
}: {
  readonly lane: BitLane | WordRow;
  readonly locale: LocaleCode;
}) {
  if (lane.note === undefined) return null;
  return (
    <Box variant="small" color="text-body-secondary">
      {localize(lane.note, locale)}
    </Box>
  );
}

function BitLanes({
  lanes,
  groupSize,
  locale,
}: {
  readonly lanes: readonly BitLane[];
  readonly groupSize: number;
  readonly locale: LocaleCode;
}) {
  return (
    <div>
      {lanes.map((lane) => (
        <Box key={lane.label} padding={{ bottom: "xs" }}>
          <Box variant="awsui-key-label">{lane.label}</Box>
          <div className="tc-drill-scroll">
            <div className="tc-drill-bits" data-testid={`bit-lane-${lane.label}`}>
              {groupBits(lane.bits, groupSize).map((group, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 桁位置そのものが識別子である
                <span className="tc-drill-bit-group" key={`${lane.label}-${index}`}>
                  {group}
                </span>
              ))}
            </div>
          </div>
          <LaneNote lane={lane} locale={locale} />
        </Box>
      ))}
    </div>
  );
}

function WordRows({
  rows,
  locale,
}: {
  readonly rows: readonly WordRow[];
  readonly locale: LocaleCode;
}) {
  return (
    <div className="tc-drill-scroll">
      <Table
        variant="embedded"
        contentDensity="compact"
        items={[...rows]}
        columnDefinitions={[
          { id: "label", header: "", cell: (row: WordRow) => row.label, width: 160 },
          {
            id: "hex",
            header: "hex",
            cell: (row: WordRow) => <span className="tc-drill-mono">{row.hex}</span>,
          },
          {
            id: "binary",
            header: "binary",
            cell: (row: WordRow) => <span className="tc-drill-mono">{row.binary}</span>,
          },
          {
            id: "note",
            header: "",
            cell: (row: WordRow) => <LaneNote lane={row} locale={locale} />,
          },
        ]}
      />
    </div>
  );
}

/** 差分表示。2 行目以降は 1 行目と違う 16 進桁を強調する。 */
function HashDiff({ rows }: { readonly rows: readonly { label: string; hex: string }[] }) {
  const [first] = rows;
  return (
    <div>
      {rows.map((row) => {
        const flags =
          first === undefined || first.hex.length !== row.hex.length
            ? row.hex.split("").map(() => false)
            : nibbleDiffFlags(first.hex, row.hex);
        return (
          <Box key={row.label} padding={{ bottom: "xs" }}>
            <Box variant="awsui-key-label">{row.label}</Box>
            <div className="tc-drill-scroll">
              <div className="tc-drill-mono" data-testid={`hash-diff-${row.label}`}>
                {row.hex.split("").map((digit, index) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: 桁位置そのものが識別子である
                    key={`${row.label}-${index}`}
                    className={flags[index] === true ? "tc-drill-diff-changed" : undefined}
                  >
                    {digit}
                  </span>
                ))}
              </div>
            </div>
          </Box>
        );
      })}
    </div>
  );
}

/**
 * 真理値表。入力列は `inputs`、最後の 1 列は `output` を読む (出力が伏せられている節では
 * `output` が `?` になっているので、そのまま描けば穴埋め表になる)。
 */
function TruthTable({
  headers,
  rows,
}: {
  readonly headers: readonly string[];
  readonly rows: readonly TruthRow[];
}) {
  const columns: TableProps.ColumnDefinition<TruthRow>[] = headers.map((header, column) => ({
    id: header,
    header,
    cell: (row: TruthRow) => (
      <span className="tc-drill-mono">
        {column < row.inputs.length ? row.inputs[column] : row.output}
      </span>
    ),
  }));
  return (
    <div className="tc-drill-scroll">
      <Table
        variant="embedded"
        contentDensity="compact"
        items={[...rows]}
        columnDefinitions={columns}
      />
    </div>
  );
}

/** 64 ラウンドの状態表。 */
function RoundsTable({
  labels,
  rows,
}: {
  readonly labels: readonly string[];
  readonly rows: readonly RoundRow[];
}) {
  const columns: TableProps.ColumnDefinition<RoundRow>[] = [
    { id: "index", header: "#", cell: (row) => row.index, width: 60 },
    ...labels.map((label, column) => ({
      id: label,
      header: label,
      cell: (row: RoundRow) => <span className="tc-drill-mono">{row.words[column]}</span>,
    })),
  ];
  return (
    <div className="tc-drill-scroll">
      <Table
        variant="embedded"
        contentDensity="compact"
        items={[...rows]}
        columnDefinitions={columns}
      />
    </div>
  );
}

/** 節が宣言した図解を描く。 */
export function DrillVisualView({
  visual,
  locale,
}: {
  readonly visual: DrillVisual;
  readonly locale: LocaleCode;
}) {
  if (visual.kind === "bit-lanes") {
    return <BitLanes lanes={visual.lanes} groupSize={visual.groupSize} locale={locale} />;
  }
  if (visual.kind === "words") {
    return <WordRows rows={visual.rows} locale={locale} />;
  }
  if (visual.kind === "truth-table") {
    return <TruthTable headers={visual.headers} rows={visual.rows} />;
  }
  if (visual.kind === "rounds") {
    return <RoundsTable labels={visual.labels} rows={visual.rows} />;
  }
  return <HashDiff rows={visual.rows} />;
}
