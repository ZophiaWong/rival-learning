"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type {
  PreparationProfile,
  PreparationProfileInput,
  ProviderView,
} from "@/server/preparation-profiles";
import type { SessionView, TimelineEvent } from "@/server/session-engine";
import type { InterviewLanguage } from "@/server/core-loop/domain";

type SessionAction =
  | { type: "calibrate_finding"; findingId: string; calibration: "accurate" | "partial" | "inaccurate" }
  | { type: "add_reflection"; turnId: string; text: string }
  | { type: "submit_rechallenge_answer"; answer: string }

  | {
      type:
        | "generate_plan"
        | "start"
        | "request_ai_answer"
        | "request_next_question"
        | "generate_checkpoint"
        | "take_over"
        | "prepare_rechallenge" | "evaluate_rechallenge" | "generate_hint" | "skip_rechallenge" | "finish_rechallenge" | "extend_budget" | "resume_error";
    }
  | { type: "submit_human_answer"; answer: string };

const emptyInput: PreparationProfileInput = {
  name: "",
  resume: "",
  projectNotes: "",
  jobDescription: "",
  targetRole: "",
  targetLevel: "",
  repoPath: null,
};

async function requestJson<T>(
  input: RequestInfo,
  init?: RequestInit,
  networkRetries = 0,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    if (networkRetries > 0) {
      return requestJson<T>(input, init, networkRetries - 1);
    }
    throw error;
  }
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Request failed with ${response.status}`);
  }
  return body;
}

function mergeTimelineEvents(
  current: TimelineEvent[],
  incoming: TimelineEvent[],
): TimelineEvent[] {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function writeSessionUrl(sessionId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionId);
  window.history.replaceState(null, "", url);
}

export function FoundationDashboard() {
  const [profiles, setProfiles] = useState<PreparationProfile[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [providerView, setProviderView] = useState<ProviderView | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [interviewLanguage, setInterviewLanguage] = useState<InterviewLanguage>("zh-CN");
  const [form, setForm] = useState<PreparationProfileInput>(emptyInput);
  const [message, setMessage] = useState("准备创建第一个 PreparationProfile。");
  const [busy, setBusy] = useState(true);
  const [pendingOperation, setPendingOperation] = useState<SessionAction["type"] | null>(null);
  const [takeOverConfirmationTurnId, setTakeOverConfirmationTurnId] = useState<string | null>(null);
  const [humanAnswer, setHumanAnswer] = useState("");
  const [rechallengeAnswer, setRechallengeAnswer] = useState("");
  const [reflections, setReflections] = useState<Record<string, string>>({});
  const initialLoad = useRef<
    Promise<[{ profiles: PreparationProfile[] }, { sessions: SessionView[] }]> | null
  >(null);

  const loadProfiles = useCallback(async () => {
    const data = await requestJson<{ profiles: PreparationProfile[] }>("/api/profiles");
    setProfiles(data.profiles);
  }, []);

  const loadSessions = useCallback(async () => {
    const data = await requestJson<{ sessions: SessionView[] }>("/api/sessions");
    setSessions(data.sessions);
  }, []);

  const selectProfile = useCallback(async (profile: PreparationProfile) => {
    setSelectedProfileId(profile.id);
    setForm({
      name: profile.name,
      resume: profile.resume,
      projectNotes: profile.projectNotes,
      jobDescription: profile.jobDescription,
      targetRole: profile.targetRole,
      targetLevel: profile.targetLevel,
      repoPath: profile.repoPath,
    });
    const data = await requestJson<{ providerView: ProviderView }>(
      `/api/profiles/${profile.id}/provider-view`,
    );
    setProviderView(data.providerView);
    setMessage(
      data.providerView.confirmedAt
        ? "ProviderView 已确认，可以创建 Session。"
        : "请检查并确认 ProviderView。",
    );
  }, []);

  const loadSessionDetail = useCallback(async (sessionId: string, updateUrl = true) => {
    const data = await requestJson<{ session: SessionView; timeline: TimelineEvent[] }>(
      `/api/sessions/${sessionId}`,
    );
    setSessions((current) => {
      const withoutSelected = current.filter((session) => session.id !== sessionId);
      return [...withoutSelected, data.session].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    });
    setSelectedSessionId(sessionId);
    setTimeline(data.timeline);
    setTakeOverConfirmationTurnId(null);
    setHumanAnswer("");
    if (updateUrl) writeSessionUrl(sessionId);
    return data;
  }, []);

  useEffect(() => {
    if (!selectedSessionId) return;
    const source = new EventSource(`/api/sessions/${selectedSessionId}/events`);
    let cancelled = false;
    const refreshState = () => { void requestJson<{ session: SessionView }>(`/api/sessions/${selectedSessionId}`).then(({ session }) => {
      if (!cancelled) setSessions(current => current.map(item => item.id === session.id && item.version <= session.version ? session : item));
    }).catch(() => { /* EventSource reconnect will retry state synchronization. */ }); };
    source.addEventListener("open", refreshState);
    const receiveTimelineEvent = (message: Event) => {
      if (!(message instanceof MessageEvent)) return;
      try {
        const nextEvent = JSON.parse(message.data) as TimelineEvent;
        if (!Number.isSafeInteger(nextEvent.sequence) || typeof nextEvent.type !== "string") {
          return;
        }
        setTimeline((current) => mergeTimelineEvents(current, [nextEvent]));
        refreshState();
      } catch {
        // A malformed public event is ignored; reconnect or a detail refresh restores state.
      }
    };
    source.addEventListener("timeline", receiveTimelineEvent);
    return () => {
      cancelled = true;
      source.removeEventListener("open", refreshState);
      source.removeEventListener("timeline", receiveTimelineEvent);
      source.close();
    };
  }, [selectedSessionId]);

  useEffect(() => {
    let cancelled = false;
    initialLoad.current ??= Promise.all([
      requestJson<{ profiles: PreparationProfile[] }>("/api/profiles"),
      requestJson<{ sessions: SessionView[] }>("/api/sessions"),
    ]);
    void initialLoad.current
      .then(([profileData, sessionData]) => {
        if (!cancelled) {
          setProfiles(profileData.profiles);
          setSessions(sessionData.sessions);
          const requestedSessionId = new URL(window.location.href).searchParams.get("session");
          if (requestedSessionId) {
            void loadSessionDetail(requestedSessionId, false)
              .catch((error: unknown) => {
                if (!cancelled) {
                  setMessage(
                    `无法恢复 URL 中的 Session（${requestedSessionId}）：${
                      error instanceof Error ? error.message : "加载失败"
                    }。你仍可从历史列表选择其他 Session。`,
                  );
                }
              })
              .finally(() => {
                if (!cancelled) setBusy(false);
              });
          } else {
            setBusy(false);
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : "加载失败");
          setBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadSessionDetail]);

  function updateField(field: keyof PreparationProfileInput, value: string) {
    setForm((current) => ({ ...current, [field]: value || (field === "repoPath" ? null : "") }));
  }

  async function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      if (selectedProfileId) {
        const data = await requestJson<{ profile: PreparationProfile }>(
          `/api/profiles/${selectedProfileId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(form),
          },
        );
        await loadProfiles();
        await selectProfile(data.profile);
        setMessage("Profile 已更新；如资料变化，请重新确认 ProviderView。");
      } else {
        const data = await requestJson<{ profile: PreparationProfile }>("/api/profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        await loadProfiles();
        await selectProfile(data.profile);
        setMessage("Profile 已创建，请确认 ProviderView。");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function confirmProviderView() {
    if (!selectedProfileId) return;
    setBusy(true);
    try {
      const data = await requestJson<{ providerView: ProviderView }>(
        `/api/profiles/${selectedProfileId}/provider-view`,
        { method: "POST" },
      );
      setProviderView(data.providerView);
      setMessage("ProviderView 已确认，可以创建 Session。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "确认失败");
    } finally {
      setBusy(false);
    }
  }

  async function duplicateProfile(profile: PreparationProfile) {
    setBusy(true);
    try {
      const data = await requestJson<{ profile: PreparationProfile }>(
        `/api/profiles/${profile.id}/duplicate`,
        { method: "POST" },
      );
      await loadProfiles();
      await selectProfile(data.profile);
      setMessage("Profile 副本已创建，需要独立确认 ProviderView。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "复制失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteProfile(profile: PreparationProfile) {
    setBusy(true);
    try {
      const details = await requestJson<{
        deletionImpact: { retainedSessionCount: number };
      }>(`/api/profiles/${profile.id}`);
      const confirmed = window.confirm(
        `删除 ${profile.name}？已有 ${details.deletionImpact.retainedSessionCount} 个历史 Session，其快照将继续保留。`,
      );
      if (!confirmed) return;
      await requestJson(`/api/profiles/${profile.id}`, { method: "DELETE" });
      if (selectedProfileId === profile.id) {
        setSelectedProfileId(null);
        setProviderView(null);
        setForm(emptyInput);
      }
      await Promise.all([loadProfiles(), loadSessions()]);
      setMessage("Profile 已删除；历史 Session snapshot 保持可读。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function createSession() {
    if (!selectedProfileId) return;
    setBusy(true);
    try {
      const sessionId = crypto.randomUUID();
      const idempotencyKey = crypto.randomUUID();
      const result = await requestJson<{ status: string; session: SessionView }>(
        "/api/sessions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            sessionId,
            profileId: selectedProfileId,
            interviewLanguage,
          }),
        },
        1,
      );
      await loadSessions();
      await loadSessionDetail(result.session.id);
      setMessage("Session 已从不可变 ProfileSnapshot 创建。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Session 创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function runSessionAction(action: SessionAction) {
    if (!selectedSessionId) return;
    setBusy(true);
    setPendingOperation(action.type);
    try {
      const idempotencyKey = crypto.randomUUID();
      const result = await requestJson<{
        status: "applied";
        session: SessionView;
        events: TimelineEvent[];
      }>(
        `/api/sessions/${selectedSessionId}/actions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(action),
        },
        1,
      );
      setSessions((current) =>
        current.map((session) =>
          session.id === result.session.id ? result.session : session,
        ),
      );
      setTimeline((current) => mergeTimelineEvents(current, result.events));
      setTakeOverConfirmationTurnId(null);
      setHumanAnswer("");
      const successMessage: Record<SessionAction["type"], string> = {
        calibrate_finding: "校准已保存。",
        add_reflection: "复盘已追加；原回答与评价保持不变。",
        submit_rechallenge_answer: "回答已保存，正在评价。",
        prepare_rechallenge: "解释与新情境问题已准备好。",
        evaluate_rechallenge: "Rechallenge 评价已保存。",
        generate_hint: "L1 提示已展示，可以再作答一次。",
        skip_rechallenge: "已暂缓本次 Rechallenge。",
        finish_rechallenge: "本次结果记录为 unresolved。",
        extend_budget: "预算增加 20 次。",
        resume_error: "正在恢复操作。",
        generate_plan: "InterviewPlan 已生成。",
        start: "Session 已启动并展示首题。",
        request_ai_answer: "Candidate 回答已保存；由你决定何时继续追问。",
        request_next_question: "下一问题已展示。",
        generate_checkpoint: "Checkpoint 已生成。",
        take_over: "你已接管本链，余下问题均由你回答。",
        submit_human_answer: result.session.state.execution?.status === "completed"
          ? "回答已保存，本条 AttackChain 已完成。"
          : "回答已保存；由你决定何时继续追问。",
      };
      setMessage(successMessage[action.type]);
      if (action.type === "submit_rechallenge_answer") {
        setRechallengeAnswer("");
        await runSessionAction({ type: "evaluate_rechallenge" });
      } else if (action.type === "resume_error" && selectedSession?.state.failedOperation) {
        await runSessionAction({ type: selectedSession.state.failedOperation.type });
      } else if (action.type === "add_reflection") {
        setReflections(current => ({ ...current, [action.turnId]: "" }));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Session action 失败");
      try {
        await loadSessionDetail(selectedSessionId, false);
      } catch {
        // Preserve the original action error; a later selection or refresh can reload state.
      }
    } finally {
      setPendingOperation(null);
      setBusy(false);
    }
  }

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const visibleOperation = pendingOperation ?? selectedSession?.state.activeOperation ?? null;
  const actionDisabled = busy || visibleOperation !== null;
  useEffect(() => {
    if (!selectedSessionId || !visibleOperation) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void requestJson<{ session: SessionView }>(`/api/sessions/${selectedSessionId}`).then(({ session }) => {
        if (!cancelled) setSessions(current => current.map(item => item.id === session.id && item.version <= session.version ? session : item));
      }).catch(() => { /* The next polling tick or SSE event can restore state. */ });
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selectedSessionId, visibleOperation]);
  const humanTurnCount =
    selectedSession?.state.execution?.turns.filter(
      (turn) => turn.answer?.actor === "human",
    ).length ?? 0;

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-5 py-10">
      <header className="mb-8 flex flex-col gap-2 border-b border-[var(--border)] pb-6">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
          Rival Learning · 02 Core Loop
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">PreparationProfile 工作台</h1>
        <p className="text-[var(--muted)]" role="status">
          {message}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
          <div className="mb-5 flex items-center justify-between gap-4">
            <h2 className="text-xl font-semibold">
              {selectedProfileId ? "编辑 Profile" : "创建 Profile"}
            </h2>
            {selectedProfileId ? (
              <button
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
                onClick={() => {
                  setSelectedProfileId(null);
                  setProviderView(null);
                  setForm(emptyInput);
                }}
                type="button"
              >
                新建 Profile
              </button>
            ) : null}
          </div>
          <form className="grid gap-4" onSubmit={submitProfile}>
            <label className="grid gap-1 text-sm font-medium">
              名称
              <input
                className="rounded-lg border border-[var(--border)] px-3 py-2"
                name="name"
                onChange={(event) => updateField("name", event.target.value)}
                value={form.name}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-sm font-medium">
                目标岗位
                <input
                  className="rounded-lg border border-[var(--border)] px-3 py-2"
                  name="targetRole"
                  onChange={(event) => updateField("targetRole", event.target.value)}
                  value={form.targetRole}
                />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                职级
                <input
                  className="rounded-lg border border-[var(--border)] px-3 py-2"
                  name="targetLevel"
                  onChange={(event) => updateField("targetLevel", event.target.value)}
                  value={form.targetLevel}
                />
              </label>
            </div>
            <label className="grid gap-1 text-sm font-medium">
              Resume
              <textarea
                className="min-h-32 rounded-lg border border-[var(--border)] px-3 py-2"
                name="resume"
                onChange={(event) => updateField("resume", event.target.value)}
                value={form.resume}
              />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Project Notes (Markdown)
              <textarea
                className="min-h-28 rounded-lg border border-[var(--border)] px-3 py-2"
                name="projectNotes"
                onChange={(event) => updateField("projectNotes", event.target.value)}
                value={form.projectNotes}
              />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              JD
              <textarea
                className="min-h-24 rounded-lg border border-[var(--border)] px-3 py-2"
                name="jobDescription"
                onChange={(event) => updateField("jobDescription", event.target.value)}
                value={form.jobDescription}
              />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Repo path（可选）
              <input
                className="rounded-lg border border-[var(--border)] px-3 py-2"
                name="repoPath"
                onChange={(event) => updateField("repoPath", event.target.value)}
                value={form.repoPath ?? ""}
              />
            </label>
            <button
              className="rounded-lg bg-[var(--accent)] px-4 py-3 font-semibold text-white disabled:opacity-50"
              disabled={busy}
              type="submit"
            >
              {selectedProfileId ? "保存 Profile" : "创建 Profile"}
            </button>
          </form>
        </section>

        <div className="grid content-start gap-6">
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
            <h2 className="mb-4 text-xl font-semibold">可复用 Profiles</h2>
            <div className="grid gap-3">
              {profiles.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">尚无 Profile。</p>
              ) : null}
              {profiles.map((profile) => (
                <article className="rounded-xl border border-[var(--border)] p-3" key={profile.id}>
                  <p className="font-semibold">{profile.name}</p>
                  <p className="text-sm text-[var(--muted)]">
                    {profile.targetRole} · {profile.targetLevel}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className="rounded-md border border-[var(--border)] px-2 py-1 text-sm"
                      onClick={() => void selectProfile(profile)}
                      type="button"
                    >
                      选择 {profile.name}
                    </button>
                    <button
                      className="rounded-md border border-[var(--border)] px-2 py-1 text-sm"
                      onClick={() => void duplicateProfile(profile)}
                      type="button"
                    >
                      复制
                    </button>
                    <button
                      className="rounded-md border border-red-200 px-2 py-1 text-sm text-red-700"
                      onClick={() => void deleteProfile(profile)}
                      type="button"
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          {providerView ? (
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold">ProviderView</h2>
                  <p className="text-xs text-[var(--muted)]">
                    {providerView.redactionVersion} · {providerView.confirmedAt ? "已确认" : "待确认"}
                  </p>
                </div>
                <button
                  className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={busy || Boolean(providerView.confirmedAt)}
                  onClick={() => void confirmProviderView()}
                  type="button"
                >
                  确认 ProviderView
                </button>
              </div>
              <div className="grid max-h-80 gap-3 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
                {(
                  [
                    ["Resume", providerView.content.resume],
                    ["Project Notes", providerView.content.projectNotes],
                    ["JD", providerView.content.jobDescription],
                    ["Target role", providerView.content.targetRole],
                    ["Target level", providerView.content.targetLevel],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <h3 className="mb-1 font-semibold text-emerald-300">{label}</h3>
                    <pre className="whitespace-pre-wrap">{value || "(empty)"}</pre>
                  </div>
                ))}
              </div>
              <label className="mt-4 grid gap-1 text-sm font-medium">
                面试语言
                <select
                  className="rounded-lg border border-[var(--border)] px-3 py-2"
                  onChange={(event) =>
                    setInterviewLanguage(event.target.value as InterviewLanguage)
                  }
                  value={interviewLanguage}
                >
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
              </label>
              <button
                className="mt-4 w-full rounded-lg border border-[var(--accent)] px-3 py-2 font-semibold text-[var(--accent)] disabled:opacity-40"
                disabled={busy || !providerView.confirmedAt}
                onClick={() => void createSession()}
                type="button"
              >
                创建 Session
              </button>
            </section>
          ) : null}
        </div>
      </div>

      <section className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold">Session history</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {sessions.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">尚无 Session。</p>
          ) : null}
          {sessions.map((session) => (
            <button
              className="rounded-xl border border-[var(--border)] p-4 text-left"
              key={session.id}
              onClick={() => void loadSessionDetail(session.id)}
              type="button"
            >
              <span className="font-semibold">{session.profileSnapshot.profile.name}</span>
              <span className="ml-2 rounded-full bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                {session.status}
              </span>
              <span className="mt-2 block text-xs text-[var(--muted)]">{session.id}</span>
              <span className="mt-1 block text-xs text-[var(--muted)]">
                {session.state.interviewLanguage}
              </span>
            </button>
          ))}
        </div>

        {selectedSession ? (
          <div className="mt-5 grid gap-4 rounded-xl bg-[#f7f9f6] p-4">
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                disabled={actionDisabled || selectedSession.status !== "draft"}
                onClick={() => void runSessionAction({ type: "generate_plan" })}
                type="button"
              >
                生成 InterviewPlan
              </button>
              <button
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                disabled={
                  actionDisabled ||
                  selectedSession.status !== "planned" ||
                  selectedSession.state.plan?.attackChains[0].status !== "ready"
                }
                onClick={() => void runSessionAction({ type: "start" })}
                type="button"
              >
                启动 Session
              </button>
            </div>
            {selectedSession.state.plan?.attackChains[0].status === "ready" ? (
              <div className="grid gap-2 text-sm">
                <strong>{selectedSession.state.plan.attackChains[0].knowledgeTarget}</strong>
                <p>
                  难度：{selectedSession.state.plan.attackChains[0].initialDifficulty} · 计划深度：
                  {selectedSession.state.plan.attackChains[0].estimatedDepth}
                </p>
                <ul className="list-disc pl-5">
                  {selectedSession.state.plan.attackChains[0].evidenceAnchors.map((anchor) => (
                    <li key={anchor.id}>
                      {anchor.source} L{anchor.startLine}–L{anchor.endLine}: {anchor.excerpt}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {selectedSession.state.plan?.attackChains[0].status === "needs_input" ? (
              <div className="grid gap-2 text-sm">
                <strong>需要补充资料：{selectedSession.state.plan.attackChains[0].reasonCode}</strong>
                <ul className="list-disc pl-5">
                  {selectedSession.state.plan.attackChains[0].requestedEvidence.map((item) => (
                    <li key={item.kind}>{item.prompt}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="rounded-lg bg-slate-100 p-3 text-sm" aria-label="Session usage">
              请求 {selectedSession.usage.requests} / {selectedSession.usage.limit} · 输入 tokens {selectedSession.usage.inputTokens} · 输出 tokens {selectedSession.usage.outputTokens}
              {!selectedSession.usage.usageComplete ? "（部分请求的 token 用量未知）" : ""}
            </p>
            {visibleOperation ? (
              <p
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                aria-label="Current Session operation"
              >
                当前 operation：{visibleOperation}
              </p>
            ) : null}
            {selectedSession.state.failedOperation ? (
              <div
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
                role="alert"
              >
                <p>{selectedSession.state.failedOperation.userMessage}</p>
                {selectedSession.state.failedOperation.type === "request_ai_answer" ? (
                  <p className="mt-1">Candidate 生成失败；当前问题仍可由你 Take Over。</p>
                ) : null}
                {selectedSession.status === "budget_paused" ? (
                  <button className="mt-2 rounded-lg border px-3 py-2" disabled={actionDisabled} onClick={() => void runSessionAction({ type: "extend_budget" })}>增加 20 次预算</button>
                ) : (
                  <button className="mt-2 rounded-lg border px-3 py-2" disabled={actionDisabled} onClick={() => void runSessionAction({ type: "resume_error" })}>恢复并继续</button>
                )}
              </div>
            ) : null}
            {selectedSession.state.execution?.turns.map((turn, index, turns) => {
              const execution = selectedSession.state.execution!;
              const isCurrentTurn = index === turns.length - 1;
              const isPending = isCurrentTurn && turn.status === "awaiting_answer";
              const candidateFailureCanBeTakenOver =
                selectedSession.status === "error" &&
                selectedSession.state.failedOperation?.type === "request_ai_answer";
              const takeOverAvailable =
                isPending &&
                execution.answerMode === "a2a" &&
                (selectedSession.status === "active" || candidateFailureCanBeTakenOver);
              return (
                <article
                  className="rounded-xl border border-[var(--border)] bg-white p-4"
                  key={turn.id}
                >
                  <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
                    Question {turn.ordinal} · {turn.question.difficulty}
                  </p>
                  <p className="mt-1 font-medium">{turn.question.text}</p>
                  {turn.answer ? (
                    <div className="mt-3 rounded-lg bg-slate-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                        {turn.answer.actor === "candidate" ? "Candidate" : "你的回答"}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap">{turn.answer.text}</p>
                    </div>
                  ) : null}
                  {turn.answer?.actor === "human" ? (
                    <details className="mt-3 text-sm">
                      <summary className="cursor-pointer">追加自我复盘</summary>
                      {timeline.filter(event => event.type === "reflection_added" && event.payload.turnId === turn.id).map(event => event.type === "reflection_added" ? <p className="my-2 whitespace-pre-wrap" key={event.sequence}>{event.payload.text}</p> : null)}
                      <textarea aria-label={`Question ${turn.ordinal} Reflection`} className="mt-2 w-full rounded border p-2" value={reflections[turn.id] ?? ""} onChange={event => setReflections(current => ({ ...current, [turn.id]: event.target.value }))} />
                      <button disabled={actionDisabled || !(reflections[turn.id] ?? "").trim()} className="rounded border px-3 py-2" onClick={() => void runSessionAction({ type: "add_reflection", turnId: turn.id, text: reflections[turn.id] })}>保存复盘</button>
                    </details>
                  ) : null}
                  {isPending && execution.answerMode === "a2a" ? (
                    <div className="mt-4 grid gap-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                          disabled={
                            actionDisabled ||
                            selectedSession.status !== "active" ||
                            Boolean(selectedSession.state.failedOperation)
                          }
                          onClick={() =>
                            void runSessionAction({ type: "request_ai_answer" })
                          }
                          type="button"
                        >
                          Candidate 回答
                        </button>
                        <button
                          className="rounded-lg border border-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent)] disabled:opacity-40"
                          disabled={actionDisabled || !takeOverAvailable}
                          onClick={() => setTakeOverConfirmationTurnId(turn.id)}
                          type="button"
                        >
                          Take Over
                        </button>
                      </div>
                      {takeOverConfirmationTurnId === turn.id ? (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                          <p>确认后，本链余下所有问题都由你回答，控制权不会自动切回 Candidate。</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              className="rounded-md bg-slate-900 px-3 py-2 font-semibold text-white disabled:opacity-40"
                              disabled={actionDisabled}
                              onClick={() => void runSessionAction({ type: "take_over" })}
                              type="button"
                            >
                              确认 Take Over
                            </button>
                            <button
                              className="rounded-md border border-[var(--border)] px-3 py-2"
                              disabled={actionDisabled}
                              onClick={() => setTakeOverConfirmationTurnId(null)}
                              type="button"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {isPending && execution.answerMode === "a2h" ? (
                    <div className="mt-4 grid gap-2">
                      <label className="grid gap-1 text-sm font-medium">
                        你的回答（Question {turn.ordinal}）
                        <textarea
                          className="min-h-28 rounded-lg border border-[var(--border)] px-3 py-2"
                          disabled={actionDisabled}
                          onChange={(event) => setHumanAnswer(event.target.value)}
                          value={humanAnswer}
                        />
                      </label>
                      <p className="text-xs text-[var(--muted)]">
                        {Array.from(humanAnswer).length}/4000 Unicode 字符；草稿不会持久化。
                      </p>
                      <button
                        className="justify-self-start rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                        disabled={
                          actionDisabled ||
                          !humanAnswer.trim() ||
                          Array.from(humanAnswer.trim()).length > 4_000
                        }
                        onClick={() =>
                          void runSessionAction({
                            type: "submit_human_answer",
                            answer: humanAnswer,
                          })
                        }
                        type="button"
                      >
                        提交回答
                      </button>
                    </div>
                  ) : null}
                  {isCurrentTurn && execution.status === "ready_for_next_question" ? (
                    <button
                      className="mt-4 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                      disabled={actionDisabled || selectedSession.status !== "active"}
                      onClick={() =>
                        void runSessionAction({ type: "request_next_question" })
                      }
                      type="button"
                    >
                      继续追问
                    </button>
                  ) : null}
                </article>
              );
            })}
            {selectedSession.state.execution?.status === "completed" ? (
              <div className="grid gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
                <p className="font-semibold">本条 AttackChain 已完成，transcript 现为只读。</p>
                {!selectedSession.state.checkpoint && humanTurnCount > 0 ? (
                  <div>
                    <p>Checkpoint 会先独立评价你的回答，再生成 Benchmark 和差异综合。</p>
                    <button
                      className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-2 font-semibold text-white disabled:opacity-40"
                      disabled={actionDisabled || selectedSession.status !== "active"}
                      onClick={() =>
                        void runSessionAction({ type: "generate_checkpoint" })
                      }
                      type="button"
                    >
                      生成 Checkpoint
                    </button>
                  </div>
                ) : null}
                {!selectedSession.state.checkpoint && humanTurnCount === 0 ? (
                  <p>本条链全部由 Candidate 回答；Step 4 不提供观察型 Checkpoint。</p>
                ) : null}
              </div>
            ) : null}
            {selectedSession.state.checkpoint ? (
              <section
                aria-label="Checkpoint"
                className="grid gap-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-slate-950"
              >
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">
                    Rubric-first Checkpoint
                  </p>
                  <h2 className="mt-1 text-xl font-semibold">回答差异与 GapFinding</h2>
                  <p className="mt-1 text-slate-600">
                    默认先看差异；Benchmark 与完整五维 Rubric 可按题展开。
                  </p>
                </div>
                {selectedSession.state.checkpoint.evaluations.map((evaluation) => {
                  const turn = selectedSession.state.execution?.turns.find(
                    (item) => item.id === evaluation.turnId,
                  );
                  const comparison = selectedSession.state.checkpoint?.comparisons.find(
                    (item) => item.turnId === evaluation.turnId,
                  );
                  const benchmark = selectedSession.state.checkpoint?.benchmarkBatch.benchmarks.find(
                    (item) => item.turnId === evaluation.turnId,
                  );
                  const findings = selectedSession.state.checkpoint?.findings.filter(
                    (finding) => finding.sourceTurnIds[0] === evaluation.turnId,
                  ) ?? [];
                  if (!turn || !benchmark || !comparison) return null;
                  return (
                    <article
                      className="grid gap-3 rounded-xl border border-indigo-100 bg-white p-4"
                      key={evaluation.turnId}
                    >
                      <div>
                        <h3 className="font-semibold">Question {turn.ordinal} Checkpoint</h3>
                        <p className="mt-1">{turn.question.text}</p>
                      </div>
                      {comparison.differences.length === 0 ? (
                        <p className="rounded-lg bg-emerald-50 p-3 text-emerald-900">
                          本题五维 Rubric 均无 partial/missing 差异。
                        </p>
                      ) : (
                        <div className="grid gap-2">
                          {comparison.differences.map((difference) => (
                            <div
                              className="rounded-lg border border-amber-200 bg-amber-50 p-3"
                              key={difference.dimension}
                            >
                              <p className="font-semibold">差异：{difference.dimension}</p>
                              <p className="mt-1">{difference.explanation}</p>
                              <p className="mt-2 text-xs text-slate-700">
                                你的原回答摘录：{difference.answerExcerpt ?? "（无适用摘录）"}
                              </p>
                              <p className="mt-1 text-xs text-slate-700">
                                Benchmark 摘录：{difference.benchmarkExcerpt}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                      {findings.map((finding) => (
                        <div
                          className="rounded-lg border border-fuchsia-200 bg-fuchsia-50 p-3"
                          key={finding.id}
                        >
                          <p className="font-semibold">
                            Priority {finding.priority} · {finding.targetDimension} · {finding.calibration}
                          </p>
                          <p className="mt-1">{finding.summary}</p>
                          {finding.calibration === "unreviewed" ? <div className="mt-2 flex gap-2">
                            {([ ["accurate", "准确"], ["partial", "部分准确"], ["inaccurate", "不准确"] ] as const).map(([calibration, label]) => <button key={calibration} disabled={actionDisabled || selectedSession.status !== "active"} className="rounded border border-fuchsia-300 bg-white px-3 py-2" onClick={() => void runSessionAction({ type: "calibrate_finding", findingId: finding.id, calibration })}>{label}</button>)}
                          </div> : null}
                          <p className="mt-1 text-xs text-slate-700">依据：{finding.basis}</p>
                          <p className="mt-1 text-xs text-slate-700">
                            来源问题：
                            {finding.sourceTurnIds
                              .map((turnId) =>
                                selectedSession.state.execution?.turns.find(
                                  (item) => item.id === turnId,
                                )?.ordinal,
                              )
                              .filter((ordinal) => ordinal !== undefined)
                              .map((ordinal) => `Question ${ordinal}`)
                              .join("、")}
                          </p>
                        </div>
                      ))}
                      <details className="rounded-lg border border-[var(--border)] p-3">
                        <summary className="cursor-pointer font-semibold">完整 Benchmark</summary>
                        <p className="mt-2 whitespace-pre-wrap">{benchmark.text}</p>
                      </details>
                      <details className="rounded-lg border border-[var(--border)] p-3">
                        <summary className="cursor-pointer font-semibold">五维 Rubric</summary>
                        <div className="mt-2 grid gap-2">
                          {evaluation.dimensions.map((dimension) => (
                            <div key={dimension.dimension}>
                              <p className="font-medium">
                                {dimension.dimension}：{dimension.verdict}
                              </p>
                              <p className="text-slate-600">{dimension.rationale}</p>
                              {dimension.answerExcerpts.length > 0 ? (
                                <p className="text-xs text-slate-600">
                                  原回答摘录：{dimension.answerExcerpts.join("；")}
                                </p>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </details>
                    </article>
                  );
                })}
                {selectedSession.state.checkpoint.findings.length === 0 ? (
                  <p className="rounded-lg bg-white p-3 font-medium">
                    未发现有充分依据的 GapFinding。
                  </p>
                ) : null}
                <p className="text-xs text-slate-600">
                  请逐项校准差距；只针对你接受的差距进行训练。
                </p>
              </section>
            ) : null}
            {selectedSession.state.checkpoint && selectedSession.state.checkpoint.findings.every(f => f.calibration !== "unreviewed") ? (
              <section aria-label="Rechallenge" className="grid gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm">
                <h3 className="text-lg font-semibold">即时 Rechallenge</h3>
                {selectedSession.state.learning.gaps.length === 0 ? <p>没有已接受的差距，本次复盘完成。</p> : !selectedSession.state.learning.rechallenge ? (
                  <><p>针对最高优先级的已接受差距，先阅读简短解释，再尝试新情境。</p><button disabled={actionDisabled || selectedSession.status !== "active"} className="rounded-lg border bg-white px-3 py-2" onClick={() => void runSessionAction({ type: "prepare_rechallenge" })}>开始即时 Rechallenge</button></>
                ) : (() => {
                  const challenge = selectedSession.state.learning.rechallenge;
                  const last = challenge.attempts.at(-1);
                  const disabled = actionDisabled || selectedSession.status !== "active";
                  return <>
                    <p className="whitespace-pre-wrap"><strong>简短解释：</strong>{challenge.preparation.microExplanation}</p>
                    <p className="text-xs text-slate-600">新情境：{challenge.preparation.scenarioChange}</p>
                    <p className="text-base font-medium">{challenge.preparation.question}</p>
                    {challenge.attempts.map((attempt, index) => <div key={index} className="rounded-lg bg-white p-3">
                      <p className="font-semibold">{attempt.hinted ? "L1 提示后回答" : "第一次无提示回答"}</p>
                      <p className="whitespace-pre-wrap">{attempt.answer}</p>
                      {attempt.evaluation ? <p className="mt-2">{attempt.evaluation.covered ? "已覆盖目标维度" : "尚未覆盖目标维度"}：{attempt.evaluation.explanation}</p> : <button disabled={disabled} className="mt-2 rounded border px-3 py-2" onClick={() => void runSessionAction({ type: "evaluate_rechallenge" })}>评价已保存的回答</button>}
                    </div>)}
                    {challenge.hint ? <p className="rounded-lg bg-amber-100 p-3">L1 提示：{challenge.hint}</p> : null}
                    {challenge.outcome ? <p className="font-semibold">结果：{challenge.outcome}</p> : <>
                      {(!last || (last.evaluation && challenge.hint && challenge.attempts.length < 2)) ? <form onSubmit={event => { event.preventDefault(); void runSessionAction({ type: "submit_rechallenge_answer", answer: rechallengeAnswer }); }} className="grid gap-2">
                        <label htmlFor="rechallenge-answer">{challenge.hint ? "提示后再作答" : "无提示作答"}</label>
                        <textarea id="rechallenge-answer" className="min-h-28 rounded-lg border p-3" value={rechallengeAnswer} onChange={event => setRechallengeAnswer(event.target.value)} disabled={disabled} />
                        <button className="rounded-lg bg-[var(--accent)] px-3 py-2 text-white disabled:opacity-40" disabled={disabled || !rechallengeAnswer.trim()}>提交 Rechallenge 回答</button>
                      </form> : null}
                      {last?.evaluation && !last.evaluation.covered && !challenge.hint ? <div className="flex gap-2">
                        <button className="rounded border bg-white px-3 py-2" disabled={disabled} onClick={() => void runSessionAction({ type: "generate_hint" })}>使用一次 L1 提示</button>
                        <button className="rounded border bg-white px-3 py-2" disabled={disabled} onClick={() => void runSessionAction({ type: "finish_rechallenge" })}>结束并记录未解决</button>
                      </div> : null}
                      {(!last || last.evaluation) ? <button className="justify-self-start rounded border px-3 py-2" disabled={disabled} onClick={() => void runSessionAction({ type: "skip_rechallenge" })}>暂缓 Rechallenge</button> : null}
                    </>}
                  </>;
                })()}
              </section>
            ) : null}
            <ol className="grid gap-2 text-sm" aria-label="Session timeline">
              {timeline.map((event) => (
                <li className="rounded-lg border border-[var(--border)] bg-white px-3 py-2" key={event.sequence}>
                  {event.sequence}. {event.type}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </section>
    </main>
  );
}
