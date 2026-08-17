import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { Minus, Plus, RotateCcw } from "lucide-react";

import { CoreAction, type TraceRecord } from "@ai-mesh/protocol";
import type { RoomSnapshot } from "@ai-mesh/application";

import {
  buildTraceTimeline,
  type TraceTimelineAgentLane,
  type TraceTimelineEdge,
  type TraceTimelineProjection,
  type TraceTimelineRoomNode,
  type TraceTimelineTurn,
} from "../shared/trace-timeline.js";
import {
  buildActivityTimelineScale,
  packTimelineLabelCenters,
  type ActivityTimelineScale,
} from "../shared/timeline-layout.js";
import { IconButton, TabList } from "./ui/controls.js";

type TraceView = "timeline" | "events";

const roomLabelWidth = 46;
const roomLabelGap = 8;
const roomLabelPadding = 18;

interface Selection {
  readonly kind: "room" | "turn";
  readonly id: string;
}

export function TrajectoryView({
  snapshot,
}: {
  readonly snapshot: RoomSnapshot;
}): React.JSX.Element {
  const [view, setView] = useState<TraceView>("timeline");
  const [selection, setSelection] = useState<Selection | undefined>();
  const projection = useMemo(() => buildTraceTimeline(snapshot), [snapshot]);
  const records = useMemo(
    () => snapshot.trace
      .slice()
      .sort((left, right) => right.occurredAt - left.occurredAt || right.sequence - left.sequence),
    [snapshot.trace],
  );
  const selected = validSelection(selection, projection)
    ? selection
    : projection.room.at(-1) === undefined
      ? projection.turns.at(-1) === undefined
        ? undefined
        : { kind: "turn" as const, id: projection.turns.at(-1)!.id }
      : { kind: "room" as const, id: projection.room.at(-1)!.id };
  const statusIssues = records.filter(
    (record) => record.status === "expired" || record.status === "failed",
  ).length;
  const issueCount = projection.issues.length + statusIssues;

  return (
    <section className="trajectory-workspace" aria-label="运行轨迹" data-ui="trajectory-view">
      <header className="trajectory-heading">
        <div>
          <div className="trajectory-title-row">
            <h1>运行轨迹</h1>
            <span className="objective-pill"><i /> 客观事件与执行过程分离</span>
          </div>
          <p>Room 严格串行，Agent 独立并发；连线只来自显式协议引用。</p>
        </div>
        <div className="trajectory-summary">
          <span><b>{projection.room.length}</b> Room 消息</span>
          <span><b>{projection.turns.length}</b> Agent turn</span>
          {issueCount === 0 ? null : <span className="warning"><b>{issueCount}</b> 需关注</span>}
        </div>
      </header>
      <div className="trajectory-view-tabs" data-ui="trajectory-tabs">
        <TabList
          value={view}
          onValueChange={setView}
          ariaLabel="轨迹视图"
          items={[
            { value: "timeline", label: <>时间轴 <span>{projection.turns.length + projection.room.length}</span></> },
            { value: "events", label: <>原始事件 <span>{records.length}</span></> },
          ]}
        />
        <small>{view === "timeline" ? "Agent 运行期按实时时长 · 长空闲已折叠" : "最新事件在上"}</small>
      </div>
      {view === "timeline" ? (
        projection.room.length === 0 && projection.turns.length === 0 ? (
          <div className="trajectory-empty">
            <strong>还没有可呈现的运行轨迹</strong>
            <p>Room 消息和 Agent 状态事件出现后，会分别进入客观轴与执行泳道。</p>
          </div>
        ) : (
          <TimelineWorkbench
            snapshot={snapshot}
            projection={projection}
            selection={selected}
            onSelect={setSelection}
          />
        )
      ) : (
        <RawTraceView snapshot={snapshot} records={records} />
      )}
      <p className="trajectory-boundary">本页只读取本地诊断轨迹；它不会进入 Room 账本或 Agent 共享上下文。</p>
    </section>
  );
}

function TimelineWorkbench({
  snapshot,
  projection,
  selection,
  onSelect,
}: {
  readonly snapshot: RoomSnapshot;
  readonly projection: TraceTimelineProjection;
  readonly selection: Selection | undefined;
  readonly onSelect: (selection: Selection) => void;
}): React.JSX.Element {
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ left: 0, width: 1 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const activityScale = useMemo(
    () => buildActivityTimelineScale(timelineActivityTimestamps(projection), projection.turns),
    [projection],
  );
  const densityWidth = projection.room.length * (roomLabelWidth + roomLabelGap) + roomLabelPadding * 2;
  const baseWidth = Math.max(
    1_100,
    densityWidth,
    (activityScale.anchors.length + 1) * (roomLabelWidth + roomLabelGap),
  );
  const plotWidth = baseWidth * zoom;

  const updateViewport = (): void => {
    const element = scrollRef.current;
    if (element === null || element.scrollWidth === 0) return;
    setViewport({
      left: element.scrollLeft / element.scrollWidth,
      width: Math.min(1, element.clientWidth / element.scrollWidth),
    });
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element !== null) {
        element.scrollLeft = element.scrollWidth;
        updateViewport();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [baseWidth, projection.endedAt]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const zoomTo = (requestedZoom: number, focalRatio = .5): void => {
    const nextZoom = Math.min(4, Math.max(1, requestedZoom));
    const element = scrollRef.current;
    if (element === null || nextZoom === zoom) return;
    const contentRatio = Math.min(
      1,
      Math.max(0, (element.scrollLeft + element.clientWidth * focalRatio) / plotWidth),
    );
    setZoom(nextZoom);
    window.requestAnimationFrame(() => {
      element.scrollLeft = contentRatio * baseWidth * nextZoom - element.clientWidth * focalRatio;
      updateViewport();
    });
  };

  const seekOverview = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const element = scrollRef.current;
    if (element === null) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    element.scrollLeft = ratio * element.scrollWidth - element.clientWidth / 2;
    updateViewport();
  };

  const zoomOverview = (event: ReactWheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    zoomTo(zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2), ratio);
  };

  return (
    <div className="trajectory-workbench">
      <div className="trajectory-main">
        <TimelineOverview
          snapshot={snapshot}
          projection={projection}
          activityScale={activityScale}
          viewport={viewport}
          onSeek={seekOverview}
          onZoom={zoomOverview}
        />
        <div className="timeline-toolbar">
          <div className="timeline-legend" aria-label="轨迹图例">
            <span className="room">Room 消息</span>
            <span className="turn">Agent turn</span>
            <span className="change">调和增量</span>
            <span className="commit">提交对应</span>
          </div>
          <div className="timeline-zoom" role="group" aria-label="时间轴缩放">
            <IconButton
              disabled={zoom <= 1}
              onClick={() => zoomTo(zoom / 1.25)}
              label="缩小活动轴"
            ><Minus className="size-3.5" /></IconButton>
            <output>{Math.round(zoom * 100)}%</output>
            <IconButton
              disabled={zoom >= 4}
              onClick={() => zoomTo(zoom * 1.25)}
              label="放大活动轴"
            ><Plus className="size-3.5" /></IconButton>
            <IconButton label="重置活动轴" disabled={zoom === 1} onClick={() => zoomTo(1)}>
              <RotateCcw className="size-3.5" />
            </IconButton>
          </div>
        </div>
        <TimelineChart
          snapshot={snapshot}
          projection={projection}
          activityScale={activityScale}
          selection={selection}
          onSelect={onSelect}
          plotWidth={plotWidth}
          scrollRef={scrollRef}
          onScroll={updateViewport}
        />
      </div>
      <TimelineInspector
        snapshot={snapshot}
        projection={projection}
        selection={selection}
        onSelect={onSelect}
      />
    </div>
  );
}

function TimelineOverview({
  snapshot,
  projection,
  activityScale,
  viewport,
  onSeek,
  onZoom,
}: {
  readonly snapshot: RoomSnapshot;
  readonly projection: TraceTimelineProjection;
  readonly activityScale: ActivityTimelineScale;
  readonly viewport: { readonly left: number; readonly width: number };
  readonly onSeek: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onZoom: (event: ReactWheelEvent<HTMLDivElement>) => void;
}): React.JSX.Element {
  const position = (timestamp: number): number => activityScale.position(timestamp) * 100;
  return (
    <section className="timeline-overview" aria-label="轨迹活动概览">
      <header>
        <div><strong>活动概览</strong><span>{activityScale.anchors.length} 个锚点 · Agent 时长保留</span></div>
        <time>实际跨度 {formatDuration(projection.endedAt - projection.startedAt)} · 滚轮缩放</time>
      </header>
      <div className="overview-grid">
        <div className="overview-labels">
          <span>Room</span>
          {projection.lanes.map((lane) => (
            <span key={lane.actorId}>{participantName(snapshot, lane.actorId)}</span>
          ))}
        </div>
        <div
          className="overview-plot"
          onClick={onSeek}
          onWheel={onZoom}
          role="presentation"
          title="点击定位，滚轮缩放下方活动轴"
        >
          <div className="overview-row room-row">
            {projection.room.map((message) => (
              <i
                className={`${actorToneClass(snapshot, message.actorId)}${message.traceMissing ? " missing" : ""}`}
                key={message.id}
                style={{ left: `${position(message.occurredAt)}%` }}
              />
            ))}
          </div>
          {projection.lanes.map((lane) => (
            <div className="overview-row" key={lane.actorId}>
              {lane.turns.map((turn) => (
                <i
                  className={`turn-bar ${turn.status} ${actorToneClass(snapshot, turn.actorId)}`}
                  key={turn.id}
                  style={{
                    left: `${position(turn.startedAt)}%`,
                    width: `${Math.max(.35, position(turn.endedAt) - position(turn.startedAt))}%`,
                  }}
                >
                  <TurnPhaseBand turn={turn} compact />
                </i>
              ))}
            </div>
          ))}
          <div
            className="overview-viewport"
            style={{ left: `${viewport.left * 100}%`, width: `${viewport.width * 100}%` }}
          />
        </div>
      </div>
    </section>
  );
}

function TimelineChart({
  snapshot,
  projection,
  activityScale,
  selection,
  onSelect,
  plotWidth,
  scrollRef,
  onScroll,
}: {
  readonly snapshot: RoomSnapshot;
  readonly projection: TraceTimelineProjection;
  readonly activityScale: ActivityTimelineScale;
  readonly selection: Selection | undefined;
  readonly onSelect: (selection: Selection) => void;
  readonly plotWidth: number;
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  readonly onScroll: () => void;
}): React.JSX.Element {
  const axisHeight = 34;
  const rowHeight = 76;
  const roomLabelTop = axisHeight + 8;
  const roomAnchorY = axisHeight + rowHeight - 12;
  const chartHeight = axisHeight + rowHeight * (projection.lanes.length + 1);
  const percent = (timestamp: number): number =>
    Math.min(100, Math.max(0, activityScale.position(timestamp) * 100));
  const laneIndex = new Map(projection.lanes.map((lane, index) => [lane.actorId, index]));
  const turnById = new Map(projection.turns.map((turn) => [turn.id, turn]));
  const roomLabelCenters = packTimelineLabelCenters(
    projection.room.map((message) => percent(message.occurredAt) * plotWidth / 100),
    {
      width: plotWidth,
      labelWidth: roomLabelWidth,
      gap: roomLabelGap,
      padding: roomLabelPadding,
    },
  );
  const yForEndpoint = (endpoint: TraceTimelineEdge["source"]): number => {
    if (endpoint.kind === "room") return roomAnchorY;
    const turn = turnById.get(endpoint.id);
    const index = turn === undefined ? 0 : laneIndex.get(turn.actorId) ?? 0;
    return axisHeight + rowHeight * (index + 1) + rowHeight / 2;
  };
  const edgeSelected = (edge: TraceTimelineEdge): boolean =>
    selection !== undefined &&
    ((selection.kind === edge.source.kind && selection.id === edge.source.id) ||
      (selection.kind === edge.target.kind && selection.id === edge.target.id));
  const relatedIds = new Set(
    selection === undefined
      ? []
      : projection.edges
          .filter(edgeSelected)
          .flatMap((edge) => [edge.source.id, edge.target.id]),
  );
  const tickIndices = activityTickIndices(activityScale.anchors.length);
  return (
    <div className="timeline-chart-shell">
      <div className="timeline-lane-labels" style={{ height: chartHeight }}>
        <div className="timeline-axis-label">轨道</div>
        <LaneLabel title="Room" detail={`${String(projection.room.length)} 条串行消息`} room />
        {projection.lanes.map((lane) => (
          <LaneLabel
            key={lane.actorId}
            title={participantName(snapshot, lane.actorId)}
            detail={`${participantLabel(snapshot, lane.actorId)} · ${String(lane.turns.length)} turns`}
            tone={actorToneClass(snapshot, lane.actorId)}
          />
        ))}
      </div>
      <div
        className="timeline-plot-scroll"
        ref={scrollRef}
        onScroll={(_event: ReactUIEvent<HTMLDivElement>) => onScroll()}
      >
        <div className="timeline-plot" style={{ width: plotWidth, minWidth: plotWidth, height: chartHeight }}>
          <div className="timeline-axis">
            {tickIndices.map((index) => {
              const timestamp = activityScale.anchors[index] ?? projection.startedAt;
              return <time key={index} style={{ left: `${percent(timestamp)}%` }}>
                A{index + 1} · {formatAxisClock(timestamp)}
              </time>
            })}
          </div>
          {Array.from({ length: projection.lanes.length + 1 }, (_, index) => (
            <div
              className={`timeline-row-line${index === 0 ? " room" : ""}`}
              key={index}
              style={{ top: axisHeight + rowHeight * index }}
            />
          ))}
          <svg
            className="timeline-edges"
            viewBox={`0 0 1000 ${String(chartHeight)}`}
            preserveAspectRatio="none"
            aria-label="显式因果连线"
          >
            <defs>
              <marker id="timeline-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 Z" />
              </marker>
            </defs>
            {projection.room.map((message, index) => {
              const anchorX = percent(message.occurredAt) * 10;
              const labelX = ((roomLabelCenters[index] ?? 0) / plotWidth) * 1_000;
              return (
                <path
                  className={`room-label-guide ${actorToneClass(snapshot, message.actorId)}`}
                  d={`M ${String(anchorX)} ${String(roomAnchorY)} L ${String(anchorX)} ${String(roomLabelTop + 32)} L ${String(labelX)} ${String(roomLabelTop + 32)}`}
                  key={`guide:${message.id}`}
                />
              );
            })}
            {projection.edges.map((edge) => {
              const x1 = percent(edge.source.occurredAt) * 10;
              const x2 = percent(edge.target.occurredAt) * 10;
              const y1 = yForEndpoint(edge.source);
              const y2 = yForEndpoint(edge.target);
              const middle = (x1 + x2) / 2;
              const path = edge.kind === "reply"
                ? `M ${String(x1)} ${String(y1)} Q ${String(middle)} ${String(axisHeight + 2)} ${String(x2)} ${String(y2)}`
                : `M ${String(x1)} ${String(y1)} C ${String(middle)} ${String(y1)} ${String(middle)} ${String(y2)} ${String(x2)} ${String(y2)}`;
              return (
                <path
                  className={`${edge.kind}${edgeSelected(edge) ? " selected" : ""}`}
                  d={path}
                  key={edge.id}
                  markerEnd={edge.kind === "reply" ? undefined : "url(#timeline-arrow)"}
                />
              );
            })}
          </svg>
          {projection.room.map((message) => (
            <i
              aria-hidden="true"
              className={`timeline-room-anchor ${actorToneClass(snapshot, message.actorId)}${message.traceMissing ? " missing" : ""}`}
              key={`anchor:${message.id}`}
              style={{
                left: `${percent(message.occurredAt)}%`,
                top: roomAnchorY - 4,
              }}
            />
          ))}
          {projection.room.map((message, index) => {
            const selected = selection?.kind === "room" && selection.id === message.id;
            const related = relatedIds.has(message.id);
            return (
              <button
                type="button"
                className={`timeline-room-node ${actorToneClass(snapshot, message.actorId)}${selected ? " selected" : ""}${related ? " related" : ""}${message.traceMissing ? " missing" : ""}`}
                key={message.id}
                style={{
                  left: `${((roomLabelCenters[index] ?? 0) / plotWidth) * 100}%`,
                  top: roomLabelTop,
                }}
                onClick={() => onSelect({ kind: "room", id: message.id })}
                title={`${participantName(snapshot, message.actorId)} · #${String(message.sequence)} ${message.text}`}
                aria-label={`${participantName(snapshot, message.actorId)} Room 消息 #${String(message.sequence)}`}
              >
                <i aria-hidden="true" />
                <span>#{message.sequence}</span>
              </button>
            );
          })}
          {projection.lanes.flatMap((lane, index) => [
            ...lane.turns.map((turn) => {
              const left = percent(turn.startedAt);
              const width = Math.max(.55, percent(turn.endedAt) - left);
              const selected = selection?.kind === "turn" && selection.id === turn.id;
              const related = relatedIds.has(turn.id);
              return (
                <button
                  type="button"
                  className={`timeline-turn ${turn.status} ${actorToneClass(snapshot, turn.actorId)}${selected ? " selected" : ""}${related ? " related" : ""}${turn.overlapsPrevious ? " overlapping" : ""}`}
                  key={turn.id}
                  style={{
                    left: `${left}%`,
                    width: `max(12px, ${width}%)`,
                    top: axisHeight + rowHeight * (index + 1) + rowHeight / 2 - 21,
                  }}
                  onClick={() => onSelect({ kind: "turn", id: turn.id })}
                  title={`${participantName(snapshot, turn.actorId)} · ${formatDuration(turn.endedAt - turn.startedAt)}`}
                  aria-label={`${participantName(snapshot, turn.actorId)} Agent turn`}
                >
                  <span className="turn-heading">
                    <span>{turnBarLabel(turn)}</span>
                    <small>{formatDuration(turn.endedAt - turn.startedAt)}</small>
                  </span>
                  <TurnPhaseBand turn={turn} />
                  <TurnMilestones turn={turn} />
                </button>
              );
            }),
            ...lane.standaloneRecords.map((record) => (
              <i
                className={`timeline-standalone ${record.status}`}
                key={record.id}
                style={{
                  left: `${percent(record.occurredAt)}%`,
                  top: axisHeight + rowHeight * (index + 1) + rowHeight / 2 - 3,
                }}
                title={traceLabel(record)}
              />
            )),
          ])}
        </div>
      </div>
    </div>
  );
}

function LaneLabel({
  title,
  detail,
  room = false,
  tone = "actor-neutral",
}: {
  readonly title: string;
  readonly detail: string;
  readonly room?: boolean;
  readonly tone?: string;
}): React.JSX.Element {
  return (
    <div className={`timeline-lane-label ${room ? "room" : tone}`}>
      <i>{room ? "R" : title.slice(0, 1)}</i>
      <div><strong>{title}</strong><span>{detail}</span></div>
    </div>
  );
}

function TurnMilestones({ turn }: { readonly turn: TraceTimelineTurn }): React.JSX.Element {
  const duration = Math.max(1, turn.endedAt - turn.startedAt);
  const milestones = turn.records.filter(
    (record) =>
      record.kind.startsWith("agent.tool.") ||
      record.kind === "agent.turn.dirty" ||
      record.kind === "agent.reconciliation.started" ||
      record.kind === "agent.draft.committed" ||
      record.kind === "agent.draft.expired",
  );
  return (
    <span className="turn-milestones" aria-hidden="true">
      {milestones.map((record) => (
        <i
          className={milestoneTone(record)}
          key={record.id}
          style={{ left: `${((record.occurredAt - turn.startedAt) / duration) * 100}%` }}
        />
      ))}
    </span>
  );
}

function TurnPhaseBand({
  turn,
  compact = false,
}: {
  readonly turn: TraceTimelineTurn;
  readonly compact?: boolean;
}): React.JSX.Element {
  const duration = Math.max(1, turn.endedAt - turn.startedAt);
  return (
    <span className={`turn-phases${compact ? " compact" : ""}`} aria-hidden="true">
      {turn.phases.map((phase) => (
        <span
          className={`turn-phase ${phase.kind}`}
          key={phase.id}
          style={{
            left: `${((phase.startedAt - turn.startedAt) / duration) * 100}%`,
            width: `${((phase.endedAt - phase.startedAt) / duration) * 100}%`,
          }}
          title={`${phase.label} · ${formatDuration(phase.endedAt - phase.startedAt)}`}
        >
          {compact ? null : phase.label}
        </span>
      ))}
    </span>
  );
}

function TimelineInspector({
  snapshot,
  projection,
  selection,
  onSelect,
}: {
  readonly snapshot: RoomSnapshot;
  readonly projection: TraceTimelineProjection;
  readonly selection: Selection | undefined;
  readonly onSelect: (selection: Selection) => void;
}): React.JSX.Element {
  if (selection === undefined) {
    return (
      <aside className="timeline-inspector">
        <div className="inspector-empty"><strong>选择一个节点</strong><p>查看 Room 消息或 Agent turn 的确定性上下游关系。</p></div>
      </aside>
    );
  }
  if (selection.kind === "room") {
    const message = projection.room.find((candidate) => candidate.id === selection.id);
    return message === undefined ? <aside className="timeline-inspector" /> : (
      <RoomNodeInspector
        snapshot={snapshot}
        projection={projection}
        message={message}
        onSelect={onSelect}
      />
    );
  }
  const turn = projection.turns.find((candidate) => candidate.id === selection.id);
  return turn === undefined ? <aside className="timeline-inspector" /> : (
    <TurnInspector snapshot={snapshot} projection={projection} turn={turn} onSelect={onSelect} />
  );
}

function RoomNodeInspector({
  snapshot,
  projection,
  message,
  onSelect,
}: {
  readonly snapshot: RoomSnapshot;
  readonly projection: TraceTimelineProjection;
  readonly message: TraceTimelineRoomNode;
  readonly onSelect: (selection: Selection) => void;
}): React.JSX.Element {
  const parents = message.respondingTo
    .map((id) => projection.room.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is TraceTimelineRoomNode => candidate !== undefined);
  const sourceTurns = message.sourceTurnIds
    .map((id) => projection.turns.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is TraceTimelineTurn => candidate !== undefined);
  const triggeredTurns = projection.edges
    .filter((edge) => edge.kind === "trigger" && edge.source.id === message.id)
    .map((edge) => projection.turns.find((turn) => turn.id === edge.target.id))
    .filter((turn): turn is TraceTimelineTurn => turn !== undefined);
  const changedTurns = projection.edges
    .filter((edge) => edge.kind === "change" && edge.source.id === message.id)
    .map((edge) => projection.turns.find((turn) => turn.id === edge.target.id))
    .filter((turn): turn is TraceTimelineTurn => turn !== undefined);
  return (
    <aside className="timeline-inspector">
      <header>
        <span>ROOM MESSAGE</span>
        <strong>消息 #{message.sequence}</strong>
        <time>{formatTraceClock(message.occurredAt)}</time>
      </header>
      <div className="inspector-body">
        <dl className="inspector-facts">
          <div><dt>发布者</dt><dd>{participantName(snapshot, message.actorId)} · {participantLabel(snapshot, message.actorId)}</dd></div>
          <div><dt>Room 顺序</dt><dd>sequence {message.sequence}</dd></div>
        </dl>
        <p className="inspector-message">{renderMentions(message.text)}</p>
        {message.traceMissing ? (
          <p className="inspector-warning">消息已存在于 Room，但对应 Agent turn 轨迹缺失。</p>
        ) : null}
        <InspectorRelations
          title="由以下执行提交"
          empty="Human 消息或没有可关联的执行轨迹"
          items={sourceTurns.map((turn) => ({
            id: turn.id,
            label: `${participantName(snapshot, turn.actorId)} · ${formatDuration(turn.endedAt - turn.startedAt)}`,
            onClick: () => onSelect({ kind: "turn", id: turn.id }),
          }))}
        />
        <InspectorRelations
          title="声明回复"
          empty="没有 respondingTo 引用"
          items={parents.map((parent) => ({
            id: parent.id,
            label: `#${String(parent.sequence)} ${truncate(parent.text, 34)}`,
            onClick: () => onSelect({ kind: "room", id: parent.id }),
          }))}
        />
        <InspectorRelations
          title="唤醒的执行"
          empty="没有 Agent turn 由此消息直接触发"
          items={triggeredTurns.map((turn) => ({
            id: turn.id,
            label: `${participantName(snapshot, turn.actorId)} · turn ${shortId(turn.id)}`,
            onClick: () => onSelect({ kind: "turn", id: turn.id }),
          }))}
        />
        <InspectorRelations
          title="作为运行增量"
          empty="没有运行显式纳入此消息"
          items={changedTurns.map((turn) => ({
            id: turn.id,
            label: `${participantName(snapshot, turn.actorId)} · 调和输入`,
            onClick: () => onSelect({ kind: "turn", id: turn.id }),
          }))}
        />
      </div>
    </aside>
  );
}

function TurnInspector({
  snapshot,
  projection,
  turn,
  onSelect,
}: {
  readonly snapshot: RoomSnapshot;
  readonly projection: TraceTimelineProjection;
  readonly turn: TraceTimelineTurn;
  readonly onSelect: (selection: Selection) => void;
}): React.JSX.Element {
  const roomNodes = (ids: readonly string[]): TraceTimelineRoomNode[] => ids
    .map((id) => projection.room.find((message) => message.id === id))
    .filter((message): message is TraceTimelineRoomNode => message !== undefined);
  const triggers = roomNodes(turn.triggerIds);
  const changes = roomNodes(turn.changeEventIds);
  const replies = roomNodes(turn.replyEventIds);
  const generated = turn.records.find(
    (record) => record.kind === "agent.draft.generated" && record.content !== undefined,
  );
  const finalCandidate = turn.records
    .slice()
    .reverse()
    .find((record) => record.content !== undefined) ?? generated;
  const observedVersion = turn.records.find(
    (record) => typeof record.data?.observedVersion === "number",
  )?.data?.observedVersion;
  return (
    <aside className="timeline-inspector">
      <header>
        <span>AGENT TURN</span>
        <strong>{participantName(snapshot, turn.actorId)}</strong>
        <time>{formatTraceClock(turn.startedAt)} · {formatDuration(turn.endedAt - turn.startedAt)}</time>
      </header>
      <div className="inspector-body">
        <dl className="inspector-facts">
          <div><dt>状态</dt><dd><span className={`trace-status ${turn.status}`}>{traceStatusLabel(turn.status)}</span></dd></div>
          <div><dt>尝试</dt><dd>第 {turn.attempt} 次{typeof observedVersion === "number" ? ` · 基于 v${String(observedVersion)}` : ""}</dd></div>
          <div><dt>turnId</dt><dd><code>{shortId(turn.id, 18)}</code></dd></div>
        </dl>
        {turn.overlapsPrevious ? <p className="inspector-warning">检测到同一 Agent 的 turn 时间重叠。</p> : null}
        <section className="inspector-section">
          <strong>阶段耗时 · {turn.phases.length}</strong>
          <div className="inspector-phase-list">
            {turn.phases.map((phase) => (
              <p key={phase.id}>
                <i className={phase.kind} aria-hidden="true" />
                <span>{phase.label}</span>
                <time>{formatDuration(phase.endedAt - phase.startedAt)}</time>
              </p>
            ))}
          </div>
        </section>
        <InspectorRelations title="初始触发" empty="没有 triggerIds" items={roomRelationItems(triggers, onSelect)} />
        <InspectorRelations title="运行期间纳入" empty="没有显式 changeEventIds" items={roomRelationItems(changes, onSelect)} />
        <InspectorRelations title="最终提交" empty="本次执行没有 Room 回复" items={roomRelationItems(replies, onSelect)} />
        {finalCandidate?.content === undefined ? null : (
          <section className="inspector-section">
            <strong>{generated?.content !== finalCandidate.content ? "调和后候选" : "候选内容"}</strong>
            <pre>{finalCandidate.content}</pre>
          </section>
        )}
        <section className="inspector-section">
          <strong>状态机事件 · {turn.records.length}</strong>
          <div className="inspector-event-list">
            {turn.records.map((record) => (
              <p key={record.id}>
                <time>{formatTraceClock(record.occurredAt)}</time>
                <span>{traceLabel(record)}</span>
                <code>T{record.sequence}</code>
              </p>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
}

function InspectorRelations({
  title,
  empty,
  items,
}: {
  readonly title: string;
  readonly empty: string;
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly onClick: () => void;
  }[];
}): React.JSX.Element {
  return (
    <section className="inspector-section">
      <strong>{title}</strong>
      {items.length === 0 ? <p className="inspector-muted">{empty}</p> : (
        <div className="inspector-links">
          {items.map((item) => <button type="button" key={item.id} onClick={item.onClick}>{item.label}</button>)}
        </div>
      )}
    </section>
  );
}

function RawTraceView({
  snapshot,
  records,
}: {
  readonly snapshot: RoomSnapshot;
  readonly records: readonly TraceRecord[];
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const visible = normalized.length === 0
    ? records
    : records.filter((record) =>
        [
          record.kind,
          record.actorId,
          record.detail,
          record.content,
          `t${String(record.sequence)}`,
          typeof record.data?.roomSequence === "number"
            ? `#${String(record.data.roomSequence)}`
            : undefined,
        ].some((value) => value?.toLowerCase().includes(normalized) === true),
      );
  return (
    <div className="raw-trace-workspace">
      <header className="raw-trace-toolbar">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索 Agent、事件、#Room 序号或 T轨迹序号"
          aria-label="搜索原始事件"
        />
        <span>{visible.length} / {records.length}</span>
      </header>
      {visible.length === 0 ? (
        <div className="trajectory-empty"><strong>没有匹配的原始事件</strong><p>尝试输入 Agent 名称、事件类型、#36 或 T106。</p></div>
      ) : (
        <div className="raw-trace-list">
          {visible.map((record) => {
            const detail = traceVisibleDetail(record);
            return (
              <article className={`raw-trace-entry ${record.status}`} key={record.id}>
                <i aria-hidden="true" />
                <div>
                  <header>
                    <strong>{traceLabel(record)}</strong>
                    <span className={`trace-status ${record.status}`}>{traceStatusLabel(record.status)}</span>
                  </header>
                  <p className="trace-meta">{traceMeta(snapshot, record)}</p>
                  {record.content === undefined ? null : (
                    <details className={`trace-content ${record.status}`} open={record.status === "expired" || record.status === "failed"}>
                      <summary>{traceContentLabel(record)}</summary>
                      <pre>{record.content}</pre>
                    </details>
                  )}
                  {detail === undefined ? null : <p className="trace-detail">{detail}</p>}
                  <details className="trace-data">
                    <summary>事件详情</summary>
                    <pre>{JSON.stringify(traceDebugData(record), undefined, 2)}</pre>
                  </details>
                  <footer><time>{formatTraceClock(record.occurredAt)}</time><code>T{record.sequence}</code></footer>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function validSelection(
  selection: Selection | undefined,
  projection: TraceTimelineProjection,
): selection is Selection {
  if (selection === undefined) return false;
  return selection.kind === "room"
    ? projection.room.some((message) => message.id === selection.id)
    : projection.turns.some((turn) => turn.id === selection.id);
}

function roomRelationItems(
  messages: readonly TraceTimelineRoomNode[],
  onSelect: (selection: Selection) => void,
): readonly { readonly id: string; readonly label: string; readonly onClick: () => void }[] {
  return messages.map((message) => ({
    id: message.id,
    label: `#${String(message.sequence)} ${truncate(message.text, 34)}`,
    onClick: () => onSelect({ kind: "room", id: message.id }),
  }));
}

function turnBarLabel(turn: TraceTimelineTurn): string {
  if (turn.status === "failed") return "失败";
  if (turn.status === "expired") return "候选过期";
  if (turn.changeEventIds.length > 0) return `调和 ${String(turn.changeEventIds.length)} 条增量`;
  if (turn.replyEventIds.length > 0) return "生成并提交";
  return "处理中";
}

function milestoneTone(record: TraceRecord): string {
  if (record.kind.startsWith("agent.tool.")) return "tool";
  if (record.kind === "agent.turn.dirty" || record.kind === "agent.reconciliation.started") return "change";
  if (record.kind === "agent.draft.committed") return "commit";
  if (record.kind === "agent.draft.expired") return "expired";
  return "info";
}

function traceSessionTransition(record: TraceRecord): string | undefined {
  const from = record.data?.fromStatus;
  const to = record.data?.toStatus;
  if (typeof from === "string" && typeof to === "string") {
    return `${presenceLabel(from)} → ${presenceLabel(to)}`;
  }
  if (record.kind === "agent.session.status" && typeof record.detail === "string") {
    const [legacyFrom, legacyTo] = record.detail.split(" -> ");
    if (legacyFrom !== undefined && legacyTo !== undefined) {
      return `${presenceLabel(legacyFrom)} → ${presenceLabel(legacyTo)}`;
    }
  }
  return undefined;
}

function traceLabel(record: TraceRecord): string {
  if (record.kind === "room.event.committed") {
    const action = record.data?.action;
    return typeof action === "string" ? activityLabel(action) : "提交了房间事件";
  }
  if (record.kind === "agent.session.status") return traceSessionTransition(record) ?? "会话状态变化";
  const labels: Readonly<Record<string, string>> = {
    "agent.session.starting": "正在启动 Agent 会话",
    "agent.session.ready": "Agent 会话已就绪",
    "agent.session.stopping": "正在停止 Agent 会话",
    "agent.session.stopped": "Agent 会话已停止",
    "agent.session.failed": "Agent 会话启动失败",
    "agent.session.error": "Agent 会话异常",
    "agent.turn.started": "开始处理房间状态",
    "agent.turn.dirty": "检测到相关 Room 变化",
    "agent.turn.result": "生成过程已结束",
    "agent.turn.completed": "一次处理已结束",
    "agent.turn.failed": "一次处理失败",
    "agent.draft.generated": "生成了候选回复",
    "agent.draft.expired": "候选回复已过期",
    "agent.draft.committed": "候选回复已提交",
    "agent.reconciliation.started": "开始调和候选",
    "agent.reconciliation.decided": "候选调和已完成",
    "agent.tool.started": "开始调用工具",
    "agent.tool.completed": "工具调用完成",
    "agent.tool.failed": "工具调用失败",
  };
  return labels[record.kind] ?? record.kind;
}

function traceStatusLabel(status: TraceRecord["status"]): string {
  const labels: Record<TraceRecord["status"], string> = {
    info: "信息",
    running: "进行中",
    dirty: "待调和",
    pending: "待提交",
    committed: "已提交",
    completed: "已完成",
    expired: "已过期",
    cancelled: "已取消",
    failed: "失败",
  };
  return labels[status];
}

function traceContentLabel(record: TraceRecord): string {
  if (record.status === "expired") return "未发送内容";
  if (record.kind === "agent.reconciliation.decided" && record.data?.decision === "patch") {
    return "修正后候选";
  }
  return "候选内容";
}

function traceVisibleDetail(record: TraceRecord): string | undefined {
  if (record.kind === "agent.session.status" || record.kind === "room.event.committed") return undefined;
  if (record.kind === "agent.turn.started" && typeof record.data?.observedVersion === "number") {
    return `读取房间 v${String(record.data.observedVersion)} 后开始生成。`;
  }
  if (record.kind === "agent.turn.dirty") return "检测到相关 Room 变化；当前生成继续。";
  if (record.kind === "agent.reconciliation.started") return "正在用候选和 Room 增量进行轻量调和。";
  if (record.kind === "agent.reconciliation.decided") {
    const decision = record.data?.decision;
    const reason = record.data?.reason;
    const summary = typeof decision === "string" ? `调和结论：${reconciliationDecisionLabel(decision)}。` : "候选调和已结束。";
    return typeof reason === "string" ? `${summary} ${reason}` : summary;
  }
  if (record.kind === "agent.draft.generated") return "候选回复生成完成，尚未提交。";
  if (record.kind === "agent.draft.expired") return "此候选没有进入 Room，并将基于最新状态重算。";
  if (record.kind === "agent.draft.committed") {
    const sequence = record.data?.roomSequence;
    return typeof sequence === "number" ? `已提交为 Room 消息 #${String(sequence)}。` : "已提交为 Room 消息。";
  }
  return record.detail;
}

function traceMeta(snapshot: RoomSnapshot, record: TraceRecord): string {
  const parts = [participantLabel(snapshot, record.actorId)];
  if (typeof record.data?.roomSequence === "number") parts.push(`Room #${String(record.data.roomSequence)}`);
  if (record.attempt !== undefined) parts.push(`第 ${String(record.attempt)} 次`);
  const observed = record.data?.observedVersion ?? record.data?.basedOnVersion;
  const current = record.data?.currentVersion ?? record.data?.targetVersion;
  if (typeof observed === "number") parts.push(typeof current === "number" ? `v${String(observed)} → v${String(current)}` : `基于 v${String(observed)}`);
  const duration = record.data?.durationMs ?? record.data?.statusDurationMs;
  if (typeof duration === "number" && Number.isFinite(duration)) parts.push(formatDuration(duration));
  return parts.join(" · ");
}

function traceDebugData(record: TraceRecord): Readonly<Record<string, unknown>> {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    actorId: record.actorId,
    ...(record.correlationId === undefined ? {} : { correlationId: record.correlationId }),
    ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
    ...(record.attempt === undefined ? {} : { attempt: record.attempt }),
    ...(record.data === undefined ? {} : { data: record.data }),
  };
}

function reconciliationDecisionLabel(decision: string): string {
  return ({
    keep: "确认候选不变",
    patch: "局部修正候选",
    regenerate: "决定完整重算",
    drop: "确认无需回复",
  } as Readonly<Record<string, string>>)[decision] ?? decision;
}

function activityLabel(action: string): string {
  switch (action) {
    case CoreAction.threadMessageAppend: return "发送了消息";
    case CoreAction.threadReplyCommit: return "提交了回复";
    case CoreAction.participantPresenceSet: return "更新了在线状态";
    case CoreAction.agentTurnComplete: return "完成了一次工作";
    case CoreAction.taskCreate: return "创建了任务";
    case CoreAction.taskClaim: return "领取了任务";
    case CoreAction.taskUpdate: return "更新了任务";
    case CoreAction.decisionPropose: return "提出了决策";
    case CoreAction.artifactPublish: return "发布了产物";
    default: return action;
  }
}

function participantLabel(snapshot: RoomSnapshot, id: string): string {
  if (id === "human") return "@human";
  const agent = snapshot.agents.find((candidate) => candidate.id === id);
  return agent === undefined ? id : `@${agent.handle}`;
}

function participantName(snapshot: RoomSnapshot, id: string): string {
  if (id === "human") return "你";
  return snapshot.agents.find((candidate) => candidate.id === id)?.name ?? id;
}

function actorToneClass(snapshot: RoomSnapshot, id: string): string {
  if (id === "human") return "actor-human";
  const handle = snapshot.agents.find((candidate) => candidate.id === id)?.handle.toLowerCase();
  if (handle?.startsWith("o") === true) return "actor-opencode";
  if (handle?.startsWith("c") === true) return "actor-codex";
  return "actor-neutral";
}

function presenceLabel(state: string): string {
  return ({
    idle: "空闲",
    waiting: "等待中",
    working: "工作中",
    starting: "启动中",
    ready: "就绪",
    stopping: "停止中",
    stopped: "已停止",
    offline: "离线",
    error: "异常",
  } as Readonly<Record<string, string>>)[state] ?? state;
}

function renderMentions(text: string): React.ReactNode {
  return text.split(/(@[A-Za-z0-9][A-Za-z0-9:._-]*[A-Za-z0-9_-]?)/g).map((part, index) =>
    part.startsWith("@") ? <mark key={`${part}-${String(index)}`}>{part}</mark> : part,
  );
}

function timelineActivityTimestamps(projection: TraceTimelineProjection): readonly number[] {
  return [
    ...projection.room.map((message) => message.occurredAt),
    ...projection.turns.flatMap((turn) => [turn.startedAt, turn.endedAt]),
    ...projection.lanes.flatMap((lane) => lane.standaloneRecords.map((record) => record.occurredAt)),
  ];
}

function activityTickIndices(anchorCount: number): readonly number[] {
  if (anchorCount <= 0) return Object.freeze([]);
  if (anchorCount <= 5) {
    return Object.freeze(Array.from({ length: anchorCount }, (_value, index) => index));
  }
  return Object.freeze([
    ...new Set([0, .25, .5, .75, 1].map((ratio) => Math.round((anchorCount - 1) * ratio))),
  ]);
}

function formatDuration(milliseconds: number): string {
  const duration = Math.max(0, milliseconds);
  if (duration < 1_000) return `${String(Math.round(duration))} ms`;
  if (duration < 10_000) return `${(duration / 1_000).toFixed(2)} s`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(duration / 60_000);
  const seconds = Math.round((duration % 60_000) / 1_000);
  return `${String(minutes)}m ${String(seconds)}s`;
}

function formatTraceClock(timestamp: number): string {
  return `${new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp)}.${String(new Date(timestamp).getMilliseconds()).padStart(3, "0")}`;
}

function formatAxisClock(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function shortId(id: string, limit = 10): string {
  const simplified = id.replace(/^turn:/, "");
  return simplified.length <= limit ? simplified : `${simplified.slice(0, limit)}…`;
}
