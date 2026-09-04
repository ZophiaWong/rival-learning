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
  | {
      type:
        | "generate_plan"
        | "start"
        | "request_ai_answer"
        | "request_next_question"
        | "take_over";
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
    const receiveTimelineEvent = (message: Event) => {
      if (!(message instanceof MessageEvent)) return;
      try {
        const nextEvent = JSON.parse(message.data) as TimelineEvent;
        if (!Number.isSafeInteger(nextEvent.sequence) || typeof nextEvent.type !== "string") {
          return;
        }
        setTimeline((current) => mergeTimelineEvents(current, [nextEvent]));
      } catch {
        // A malformed public event is ignored; reconnect or a detail refresh restores state.
      }
    };
    source.addEventListener("timeline", receiveTimelineEvent);
    return () => {
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
        generate_plan: "InterviewPlan 已生成。",
        start: "Session 已启动并展示首题。",
        request_ai_answer: "Candidate 回答已保存；由你决定何时继续追问。",
        request_next_question: "下一问题已展示。",
        take_over: "你已接管本链，余下问题均由你回答。",
        submit_human_answer: result.session.state.execution?.status === "completed"
          ? "回答已保存，本条 AttackChain 已完成。"
          : "回答已保存；由你决定何时继续追问。",
      };
      setMessage(successMessage[action.type]);
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
                {selectedSession.state.failedOperation.type === "request_next_question" ? (
                  <p className="mt-1">
                    本版本不能恢复失败的追问 operation。请从已确认的 Profile 新建 Session。
                  </p>
                ) : null}
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
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
                <p className="font-semibold">本条 AttackChain 已完成，transcript 现为只读。</p>
                <p className="mt-1">Checkpoint 将在 Step 4 提供。</p>
              </div>
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
