import { useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  WorkspaceAgentConfig,
  WorkspaceConfig,
  WorkspaceConfigPreview,
  WorkspaceConfigSaveInput,
  WorkspaceConfigWriteResult,
} from "@ai-mesh/application";

import type { DesktopAgentProbe } from "../shared/api.js";

export interface ConfigurationViewProps {
  readonly preview: WorkspaceConfigPreview | undefined;
  readonly probes: readonly DesktopAgentProbe[];
  readonly busy: string | undefined;
  readonly onSave: (
    input: WorkspaceConfigSaveInput,
  ) => Promise<WorkspaceConfigWriteResult | undefined>;
  readonly onReload: () => Promise<boolean>;
}

export function ConfigurationView({
  preview,
  probes,
  busy,
  onSave,
  onReload,
}: ConfigurationViewProps): React.JSX.Element {
  const [draft, setDraft] = useState<WorkspaceConfig | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const availability = useMemo(() => new Map(probes.map((probe) => [probe.id, probe])), [probes]);

  useEffect(() => {
    setDraft(preview === undefined ? undefined : cloneConfig(preview.config));
  }, [preview]);

  if (preview === undefined || draft === undefined) {
    return (
      <section className="configuration-view configuration-loading">
        <strong>正在读取有效配置…</strong>
      </section>
    );
  }

  const normalized = normalizeConfig(draft);
  const validationError = configDraftError(normalized);
  const dirty = JSON.stringify(normalized) !== JSON.stringify(preview.config);
  const saving = busy === "save-config";
  const reloading = busy === "reload-config";

  const updateAgent = (index: number, patch: Partial<WorkspaceAgentConfig>): void => {
    setNotice(undefined);
    setDraft((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        agents: current.agents.map((agent, agentIndex) =>
          agentIndex === index ? { ...agent, ...patch } : agent,
        ),
      };
    });
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!dirty || validationError !== undefined || busy !== undefined) return;
    setNotice(undefined);
    const result = await onSave({
      expectedRevision: preview.revision,
      config: normalized,
    });
    if (result !== undefined) {
      setNotice(result.changed ? "配置已保存并重新加载工作区。" : "配置内容没有变化。");
    }
  };

  const reload = async (): Promise<void> => {
    setNotice(undefined);
    if (await onReload()) {
      setNotice("已重新加载磁盘上的最新配置。");
    }
  };

  return (
    <form className="configuration-view" onSubmit={(event) => void submit(event)}>
      <header className="configuration-heading">
        <div>
          <div className="configuration-title-row">
            <h1>工作区配置</h1>
            <span className="editable-pill">可编辑 · v{preview.config.version}</span>
          </div>
          <p>整份配置会先校验，再原子保存并安全重载当前工作区。</p>
        </div>
        <div className="configuration-heading-actions">
          <button
            type="button"
            className="ghost compact"
            disabled={busy !== undefined}
            onClick={() => {
              setDraft(cloneConfig(preview.config));
              setNotice(undefined);
            }}
          >撤销</button>
          <button
            type="button"
            className="ghost compact"
            disabled={busy !== undefined}
            onClick={() => void reload()}
          >{reloading ? "正在重载…" : "重新加载"}</button>
          <button
            type="submit"
            className="primary compact configuration-save"
            disabled={!dirty || validationError !== undefined || busy !== undefined}
          >{saving ? "正在保存…" : "保存配置"}</button>
        </div>
      </header>
      <div className="configuration-scroll">
        <section className="configuration-callout">
          <div>
            <span className="eyebrow">配置来源与版本</span>
            <strong>{configurationSourceLabel(preview.source)}</strong>
            <p>
              revision <code>{revisionLabel(preview.revision)}</code>
              {dirty ? " · 有尚未保存的修改" : " · 当前表单与已加载配置一致"}
            </p>
            {notice === undefined ? null : <p className="configuration-notice">{notice}</p>}
            {validationError === undefined ? null : (
              <p className="configuration-validation" role="alert">{validationError}</p>
            )}
          </div>
          <span className={`source-badge ${preview.source}`}>{preview.source}</span>
        </section>

        <section className="configuration-section">
          <div className="configuration-section-heading">
            <div><span className="eyebrow">WORKSPACE</span><h2>工作区与存储</h2></div>
            <code>{normalized.roomId}</code>
          </div>
          <div className="configuration-room-editor">
            <label>
              <span>Room ID</span>
              <input
                required
                value={draft.roomId}
                onChange={(event) => {
                  setNotice(undefined);
                  setDraft({ ...draft, roomId: event.target.value });
                }}
              />
              <small>修改后会切换逻辑 Room；原 Room 历史仍保留在本地数据库中。</small>
            </label>
          </div>
          <dl className="configuration-paths">
            <div><dt>项目根目录</dt><dd><code title={preview.root}>{preview.root}</code></dd></div>
            <div><dt>Mesh 数据目录</dt><dd><code title={preview.dataDirectory}>{preview.dataDirectory}</code></dd></div>
            <div><dt>配置文件</dt><dd><code title={preview.configPath}>{preview.configPath}</code></dd></div>
            <div><dt>SQLite 数据库</dt><dd><code title={preview.databasePath}>{preview.databasePath}</code></dd></div>
          </dl>
        </section>

        <section className="configuration-section">
          <div className="configuration-section-heading">
            <div><span className="eyebrow">AGENTS</span><h2>Agent 运行配置</h2></div>
            <span>{draft.agents.length} 个 Agent</span>
          </div>
          <div className="configuration-agents">
            {draft.agents.map((agent, index) => {
              const probe = availability.get(agent.id);
              return (
                <article className={`configuration-agent avatar-${agent.handle.slice(0, 1)}`} key={`${String(index)}:${agent.id}`}>
                  <header>
                    <div className="configuration-agent-avatar">{agent.name.trim().slice(0, 1) || "A"}</div>
                    <div>
                      <strong>{agent.name || "未命名 Agent"}</strong>
                      <span>@{agent.handle || "handle"} · {agent.id || "participant-id"}</span>
                    </div>
                    <span className={`availability-badge ${probe === undefined ? "checking" : probe.available ? "available" : "unavailable"}`}>
                      {probe === undefined ? "保存后检测" : probe.available ? "可用" : "不可用"}
                    </span>
                  </header>
                  <div className="configuration-agent-form">
                    <label><span>名称</span><input required value={agent.name} onChange={(event) => updateAgent(index, { name: event.target.value })} /></label>
                    <label><span>Handle</span><input required value={agent.handle} onChange={(event) => updateAgent(index, { handle: event.target.value })} /></label>
                    <label className="wide"><span>参与者 ID</span><input required value={agent.id} onChange={(event) => updateAgent(index, { id: event.target.value })} /></label>
                    <label>
                      <span>适配器</span>
                      <select value={agent.adapter} onChange={(event) => updateAgent(index, { adapter: event.target.value as WorkspaceAgentConfig["adapter"] })}>
                        <option value="opencode-acp">OpenCode ACP</option>
                        <option value="codex-native">Codex Native</option>
                      </select>
                    </label>
                    <label>
                      <span>权限策略</span>
                      <select value={agent.permissionPolicy ?? "deny"} onChange={(event) => updateAgent(index, { permissionPolicy: event.target.value as NonNullable<WorkspaceAgentConfig["permissionPolicy"]> })}>
                        <option value="deny">拒绝工具权限</option>
                        <option value="allow-once">单次允许</option>
                        <option value="allow-always">始终允许</option>
                      </select>
                    </label>
                    <label className="wide">
                      <span>命令覆盖</span>
                      <input value={agent.command ?? ""} placeholder={agent.adapter === "opencode-acp" ? "opencode（默认）" : "codex（默认）"} onChange={(event) => updateAgent(index, { command: event.target.value })} />
                    </label>
                    <label className="configuration-toggle wide">
                      <input type="checkbox" checked={agent.respondToTeam === true} onChange={(event) => updateAgent(index, { respondToTeam: event.target.checked })} />
                      <span>响应发送给团队的消息</span>
                    </label>
                    <label className="wide">
                      <span>系统提示词</span>
                      <textarea rows={4} value={agent.systemPrompt ?? ""} placeholder="留空以使用 Mesh 运行时默认提示" onChange={(event) => updateAgent(index, { systemPrompt: event.target.value })} />
                    </label>
                  </div>
                  {probe?.reason === undefined ? null : <p className="configuration-agent-error">{probe.reason}</p>}
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </form>
  );
}

function cloneConfig(config: WorkspaceConfig): WorkspaceConfig {
  return {
    ...config,
    agents: config.agents.map((agent) => ({ ...agent })),
  };
}

function normalizeConfig(config: WorkspaceConfig): WorkspaceConfig {
  return {
    version: config.version,
    roomId: config.roomId.trim(),
    agents: config.agents.map((agent) => {
      const command = agent.command?.trim();
      const systemPrompt = agent.systemPrompt?.trim();
      return {
        id: agent.id.trim(),
        name: agent.name.trim(),
        handle: agent.handle.trim().replace(/^@/, "").toLowerCase(),
        adapter: agent.adapter,
        ...(command === undefined || command.length === 0 ? {} : { command }),
        ...(agent.permissionPolicy === undefined
          ? {}
          : { permissionPolicy: agent.permissionPolicy }),
        ...(agent.respondToTeam === undefined
          ? {}
          : { respondToTeam: agent.respondToTeam }),
        ...(systemPrompt === undefined || systemPrompt.length === 0 ? {} : { systemPrompt }),
      };
    }),
  };
}

function configDraftError(config: WorkspaceConfig): string | undefined {
  if (config.roomId.length === 0) return "Room ID 不能为空。";
  const ids = new Set<string>();
  const handles = new Set<string>();
  for (const [index, agent] of config.agents.entries()) {
    if (agent.id.length === 0 || agent.name.length === 0 || agent.handle.length === 0) {
      return `Agent ${String(index + 1)} 的名称、Handle 和参与者 ID 均不能为空。`;
    }
    if (!/^[a-z0-9][a-z0-9:._-]*$/.test(agent.handle)) {
      return `Agent ${String(index + 1)} 的 Handle 格式无效。`;
    }
    if (ids.has(agent.id) || handles.has(agent.handle)) {
      return `Agent ${String(index + 1)} 的参与者 ID 或 Handle 与其他 Agent 重复。`;
    }
    ids.add(agent.id);
    handles.add(agent.handle);
  }
  return undefined;
}

function configurationSourceLabel(source: WorkspaceConfigPreview["source"]): string {
  const labels: Readonly<Record<WorkspaceConfigPreview["source"], string>> = {
    default: "内置默认配置（首次保存将创建文件）",
    file: "工作区配置文件",
    provided: "启动时提供的配置",
  };
  return labels[source];
}

function revisionLabel(revision: string | null): string {
  return revision === null ? "尚未落盘" : `${revision.slice(0, 18)}…`;
}
