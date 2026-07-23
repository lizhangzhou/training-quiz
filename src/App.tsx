"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import questionsData from "./questions.json";

type Option = { key: string; text: string };
type Question = { id: number; category: string; type: string; question: string; options: Option[]; answer: string | string[]; basis: string; explanation: string; source: string };
type Stats = { answered: number; correct: number; wrong: number[]; wrongCounts: Record<string, number>; favorites: number[]; lastId: number; dates: string[] };
type PracticeSession = { queue: number[]; cursor: number; label: string; updatedAt: number };
type DrawStrategy = "wrong" | "random" | "favorite";
type ExamReview = { id: number; response: string[]; correct: boolean | null };
type ExamSummary = { correct: number; objectiveTotal: number; reviews: ExamReview[] };
type PracticeResponse = { response: string[]; correct: boolean };
type ExamSubmitStage = "confirm" | "unanswered" | null;
type View = "home" | "quiz" | "wrong" | "favorites" | "questionBank" | "records" | "practiceSetup" | "examSetup" | "examResult";
type AuthUser = { id: string; username: string; nickname: string };
type AuthConfig = { registrationEnabled: boolean };
type CaptchaChallenge = { captchaId: string; imageUrl: string; expiresIn: number };
type LocalSnapshot = { stats: Stats; session: PracticeSession | null; nickname: string };
type CloudStateResponse = { user: AuthUser; hasState: boolean; version: number; stats: Stats | null; session: PracticeSession | null };
type CloudStatus = "idle" | "syncing" | "synced" | "error";

const questions = questionsData as Question[];
const emptyStats: Stats = { answered: 0, correct: 0, wrong: [], wrongCounts: {}, favorites: [], lastId: 1, dates: [] };
const emptyAuthConfig: AuthConfig = { registrationEnabled: false };
const availableQuestionTypes = ["单选题", "多选题", "判断题", "简答题"].filter(type => questions.some(item => item.type === type));
const questionTypes = ["全部题型", ...availableQuestionTypes];
const questionTypeOrder = availableQuestionTypes;
const examObjectiveTypeOrder = ["判断题", "单选题", "多选题"] as const;
type ExamObjectiveType = (typeof examObjectiveTypeOrder)[number];
const examQuestionTypeOrder = [...examObjectiveTypeOrder, "简答题"];
const examTypeWeights: Record<ExamObjectiveType, number> = { "判断题": 3, "单选题": 4, "多选题": 3 };
const examTypeCapacities: Record<ExamObjectiveType, number> = {
  "判断题": questions.filter(item => item.type === "判断题").length,
  "单选题": questions.filter(item => item.type === "单选题").length,
  "多选题": questions.filter(item => item.type === "多选题").length,
};
const examObjectiveCapacity = Object.values(examTypeCapacities).reduce((sum, value) => sum + value, 0);
const examShortCapacity = questions.filter(item => item.type === "简答题").length;
const questionsById = new Map(questions.map(item => [item.id, item]));

function questionTypeRank(type: string, order: readonly string[] = questionTypeOrder) {
  const rank = order.indexOf(type);
  return rank === -1 ? order.length : rank;
}

function sortQuestionIdsByType(ids: number[], order: readonly string[] = questionTypeOrder) {
  return [...ids].sort((firstId, secondId) => {
    const first = questionsById.get(firstId);
    const second = questionsById.get(secondId);
    return questionTypeRank(first?.type || "", order) - questionTypeRank(second?.type || "", order);
  });
}

function sortQuestionsByType(items: Question[], order: readonly string[] = questionTypeOrder) {
  return [...items].sort((first, second) => questionTypeRank(first.type, order) - questionTypeRank(second.type, order));
}

function groupQuestionsByType(items: Question[], order: readonly string[] = questionTypeOrder) {
  const grouped = new Map<string, Question[]>();
  for (const item of sortQuestionsByType(items, order)) {
    const type = item.type || "其他题型";
    grouped.set(type, [...(grouped.get(type) || []), item]);
  }
  return Array.from(grouped, ([type, groupedItems]) => ({ type, items: groupedItems }));
}

function allocateExamTypeCounts(requestedTotal: number) {
  const total = Math.max(0, Math.min(Math.floor(requestedTotal), examObjectiveCapacity));
  const counts: Record<ExamObjectiveType, number> = { "判断题": 0, "单选题": 0, "多选题": 0 };
  if (!total) return counts;

  const allocations = examObjectiveTypeOrder.map(type => {
    const exact = total * examTypeWeights[type] / 10;
    const base = Math.floor(exact);
    counts[type] = base;
    return { type, remainder: exact - base };
  });

  let unassigned = total - Object.values(counts).reduce((sum, value) => sum + value, 0);
  while (unassigned > 0) {
    let best = allocations[0];
    for (const allocation of allocations.slice(1)) {
      if (allocation.remainder > best.remainder) best = allocation;
    }
    counts[best.type] += 1;
    best.remainder = -1;
    unassigned -= 1;
  }

  let overflow = 0;
  for (const type of examObjectiveTypeOrder) {
    if (counts[type] > examTypeCapacities[type]) {
      overflow += counts[type] - examTypeCapacities[type];
      counts[type] = examTypeCapacities[type];
    }
  }

  while (overflow > 0) {
    const available = examObjectiveTypeOrder.filter(type => counts[type] < examTypeCapacities[type]);
    if (!available.length) break;
    let best = available[0];
    for (const type of available.slice(1)) {
      const bestDeficit = examTypeWeights[best] / 10 - counts[best] / total;
      const currentDeficit = examTypeWeights[type] / 10 - counts[type] / total;
      if (currentDeficit > bestDeficit) best = type;
    }
    counts[best] += 1;
    overflow -= 1;
  }

  return counts;
}

function normalizeSearchText(text: string) {
  return text.toLowerCase().replace(/[\s，。！？、；：,.!?;:（）()“”"']/g, "");
}

function fuzzyMatches(text: string, query: string) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  const normalizedText = normalizeSearchText(text);
  if (normalizedText.includes(normalizedQuery)) return true;
  let queryIndex = 0;
  for (const character of normalizedText) {
    if (character === normalizedQuery[queryIndex]) queryIndex += 1;
    if (queryIndex === normalizedQuery.length) return true;
  }
  return false;
}

function matchesQuestionFilters(item: Question, type: string, category: string, query: string) {
  return (type === "全部题型" || item.type === type)
    && (category === "全部分类" || item.category === category)
    && fuzzyMatches(item.question, query);
}

function hasMeaningfulLocalData(snapshot: LocalSnapshot) {
  return snapshot.stats.answered > 0
    || snapshot.stats.wrong.length > 0
    || snapshot.stats.favorites.length > 0
    || snapshot.session !== null;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const data = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function readLocalSnapshot(): LocalSnapshot {
  let stats = { ...emptyStats };
  let session: PracticeSession | null = null;
  let nickname = "同学";
  try {
    const savedStats = localStorage.getItem("training-quiz-stats");
    if (savedStats) {
      const parsed = JSON.parse(savedStats);
      const migratedCounts = { ...(parsed.wrongCounts || {}) };
      for (const id of parsed.wrong || []) if (!migratedCounts[String(id)]) migratedCounts[String(id)] = 1;
      stats = { ...emptyStats, ...parsed, wrongCounts: migratedCounts };
    }
    const savedSession = localStorage.getItem("training-quiz-session");
    if (savedSession) session = JSON.parse(savedSession);
    const savedNickname = localStorage.getItem("training-quiz-nickname");
    if (savedNickname) nickname = savedNickname;
  } catch {}
  return { stats, session, nickname };
}

function Icon({ children, tone = "green" }: { children: React.ReactNode; tone?: "green" | "red" | "amber" }) {
  return <span className={`icon icon-${tone}`}>{children}</span>;
}

export default function Home() {
  const [view, setView] = useState<View>("home");
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [ready, setReady] = useState(false);
  const [queue, setQueue] = useState<number[]>([]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [category, setCategory] = useState("全部分类");
  const [filterType, setFilterType] = useState("全部题型");
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [wrongFilter, setWrongFilter] = useState<"all" | "1" | "2" | "3plus">("all");
  const [wrongIncludeShort, setWrongIncludeShort] = useState(false);
  const [greeting, setGreeting] = useState("你好");
  const [nickname, setNickname] = useState("同学");
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [editingNickname, setEditingNickname] = useState(false);
  const [examQuestionCount, setExamQuestionCount] = useState(20);
  const [examIncludeShort, setExamIncludeShort] = useState(false);
  const [practiceQuestionCount, setPracticeQuestionCount] = useState(20);
  const [practiceIncludeShort, setPracticeIncludeShort] = useState(false);
  const [practiceStrategy, setPracticeStrategy] = useState<DrawStrategy>("random");
  const [examStrategy, setExamStrategy] = useState<DrawStrategy>("random");
  const [examActive, setExamActive] = useState(false);
  const [examResponses, setExamResponses] = useState<Record<string, string[]>>({});
  const [examSummary, setExamSummary] = useState<ExamSummary | null>(null);
  const [examSubmitStage, setExamSubmitStage] = useState<ExamSubmitStage>(null);
  const [practiceResponses, setPracticeResponses] = useState<Record<string, PracticeResponse>>({});
  const [sequenceSearch, setSequenceSearch] = useState("");
  const [sequenceCategory, setSequenceCategory] = useState("全部分类");
  const [sequenceType, setSequenceType] = useState("全部题型");
  const [sequenceFilterOpen, setSequenceFilterOpen] = useState(false);
  const [questionBankSearch, setQuestionBankSearch] = useState("");
  const [questionBankCategory, setQuestionBankCategory] = useState("全部分类");
  const [questionBankType, setQuestionBankType] = useState("全部题型");
  const [examResultFilter, setExamResultFilter] = useState<"all" | "wrong">("all");
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [guestMode, setGuestMode] = useState(false);
  const [authConfig, setAuthConfig] = useState<AuthConfig>(emptyAuthConfig);
  const [authReady, setAuthReady] = useState(false);
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>("idle");
  const [localSnapshot, setLocalSnapshot] = useState<LocalSnapshot>({ stats: emptyStats, session: null, nickname: "同学" });
  const [pendingLocalImport, setPendingLocalImport] = useState<LocalSnapshot | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState("");
  const syncChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let greetingClock: number | undefined;
    const timer = window.setTimeout(() => {
      const snapshot = readLocalSnapshot();
      setStats(snapshot.stats);
      setSession(snapshot.session);
      setNickname(snapshot.nickname);
      setLocalSnapshot(snapshot);
      const updateGreeting = () => {
        const hour = new Date().getHours();
        setGreeting(hour < 5 ? "夜深了" : hour < 9 ? "早上好" : hour < 12 ? "上午好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好");
      };
      updateGreeting();
      greetingClock = window.setInterval(updateGreeting, 60000);
      setReady(true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (greetingClock !== undefined) window.clearInterval(greetingClock);
    };
  }, []);
  useEffect(() => { if (ready && guestMode) localStorage.setItem("training-quiz-stats", JSON.stringify(stats)); }, [stats, ready, guestMode]);
  useEffect(() => { if (ready && guestMode) localStorage.setItem("training-quiz-nickname", nickname); }, [nickname, ready, guestMode]);
  useEffect(() => {
    if (!ready || !guestMode) return;
    if (session) localStorage.setItem("training-quiz-session", JSON.stringify(session));
    else localStorage.removeItem("training-quiz-session");
  }, [session, ready, guestMode]);
  useEffect(() => {
    if (!ready || !guestMode) return;
    setLocalSnapshot({ stats, session, nickname });
  }, [stats, session, nickname, ready, guestMode]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      try {
        const config = await apiRequest<AuthConfig>("/api/config");
        if (!cancelled) setAuthConfig({ ...emptyAuthConfig, ...config });
      } catch {
        if (!cancelled) setAuthConfig(emptyAuthConfig);
      }
      try {
        const result = await apiRequest<{ user: AuthUser }>("/api/auth/me");
        if (!result.user) throw new Error("尚未登录");
        if (!cancelled) await hydrateCloudAccount(result.user, localSnapshot);
      } catch {
        if (!cancelled) {
          setAuthUser(null);
          setCloudReady(false);
          setCloudStatus("idle");
        }
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [ready]);
  useEffect(() => {
    if (!authUser || !cloudReady) return;
    const payload = { stats, session, nickname };
    const timer = window.setTimeout(() => {
      setCloudStatus("syncing");
      syncChainRef.current = syncChainRef.current.catch(() => undefined).then(async () => {
        try {
          const result = await apiRequest<{ user?: AuthUser }>("/api/user/state", { method: "PUT", body: JSON.stringify(payload) });
          if (result.user) setAuthUser(result.user);
          setCloudStatus("synced");
        } catch {
          setCloudStatus("error");
        }
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [stats, session, nickname, authUser?.id, cloudReady]);
  useEffect(() => {
    if (!examSubmitStage) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExamSubmitStage(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [examSubmitStage]);

  function saveNickname() {
    const next = nicknameDraft.trim().slice(0, 12) || "同学";
    setNickname(next);
    setAuthUser(current => current ? { ...current, nickname: next } : current);
    setEditingNickname(false);
  }

  async function hydrateCloudAccount(user: AuthUser, snapshot = localSnapshot) {
    setGuestMode(false);
    setAuthUser(user);
    setNickname(user.nickname);
    setCloudReady(false);
    setCloudStatus("syncing");
    const cloud = await apiRequest<CloudStateResponse>("/api/user/state");
    setAuthUser(cloud.user);
    setNickname(cloud.user.nickname);
    if (cloud.hasState && cloud.stats) {
      setStats({ ...emptyStats, ...cloud.stats });
      setSession(cloud.session);
      setPendingLocalImport(null);
      setCloudReady(true);
      setCloudStatus("synced");
      return;
    }
    if (hasMeaningfulLocalData(snapshot)) {
      setStats(snapshot.stats);
      setSession(snapshot.session);
      setPendingLocalImport(snapshot);
      setCloudStatus("idle");
      return;
    }
    setStats({ ...emptyStats });
    setSession(null);
    setPendingLocalImport(null);
    setCloudReady(true);
    setCloudStatus("synced");
  }

  async function handleAuthenticated(user: AuthUser) {
    await hydrateCloudAccount(user, localSnapshot);
  }

  function enterGuestMode() {
    const snapshot = readLocalSnapshot();
    setAuthUser(null);
    setGuestMode(true);
    setStats(snapshot.stats);
    setSession(snapshot.session);
    setNickname(snapshot.nickname);
    setLocalSnapshot(snapshot);
    setCloudReady(false);
    setCloudStatus("idle");
    setPendingLocalImport(null);
    setView("home");
  }

  function exitGuestMode() {
    const snapshot = { stats, session, nickname };
    setLocalSnapshot(snapshot);
    setGuestMode(false);
    setAuthUser(null);
    setCloudReady(false);
    setCloudStatus("idle");
    setPendingLocalImport(null);
    setView("home");
  }

  async function importLocalProgress() {
    if (!pendingLocalImport || !authUser) return;
    setMigrationBusy(true);
    setMigrationError("");
    try {
      await apiRequest("/api/user/import", {
        method: "POST",
        body: JSON.stringify({ stats: pendingLocalImport.stats, session: pendingLocalImport.session, nickname: authUser.nickname }),
      });
      setStats(pendingLocalImport.stats);
      setSession(pendingLocalImport.session);
      setPendingLocalImport(null);
      setCloudReady(true);
      setCloudStatus("synced");
    } catch (error) {
      setMigrationError(error instanceof Error ? error.message : "导入失败，请重试");
    } finally {
      setMigrationBusy(false);
    }
  }

  function skipLocalProgress() {
    setStats({ ...emptyStats });
    setSession(null);
    setPendingLocalImport(null);
    setCloudReady(true);
    setCloudStatus("syncing");
  }

  async function logout() {
    try { await apiRequest("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
    const snapshot = readLocalSnapshot();
    setStats(snapshot.stats);
    setSession(snapshot.session);
    setNickname(snapshot.nickname);
    setLocalSnapshot(snapshot);
    setAuthUser(null);
    setGuestMode(false);
    setCloudReady(false);
    setCloudStatus("idle");
    setPendingLocalImport(null);
    setView("home");
  }

  const categories = useMemo(() => ["全部分类", ...Array.from(new Set(questions.map(q => q.category))).filter(Boolean)], []);
  const today = new Date().toISOString().slice(0, 10);
  const todayDone = stats.dates.filter(d => d === today).length;
  const accuracy = stats.answered ? Math.round(stats.correct / stats.answered * 100) : 0;
  const progress = Math.round(stats.answered / questions.length * 100);
  const streak = new Set(stats.dates.slice(-30)).size;
  const totalWrongAttempts = Object.values(stats.wrongCounts).reduce((sum, value) => sum + value, 0);
  const eligibleWrongIds = stats.wrong.filter(id => wrongIncludeShort || questions.find(item => item.id === id)?.type !== "简答题");
  const wrongGroups = {
    all: eligibleWrongIds.length,
    "1": eligibleWrongIds.filter(id => (stats.wrongCounts[String(id)] || 1) === 1).length,
    "2": eligibleWrongIds.filter(id => stats.wrongCounts[String(id)] === 2).length,
    "3plus": eligibleWrongIds.filter(id => stats.wrongCounts[String(id)] >= 3).length
  };
  const activeWrongIds = eligibleWrongIds.filter(id => {
    const count = stats.wrongCounts[String(id)] || 1;
    return wrongFilter === "all" || (wrongFilter === "1" && count === 1) || (wrongFilter === "2" && count === 2) || (wrongFilter === "3plus" && count >= 3);
  });
  const examEligibleCapacity = examObjectiveCapacity + (examIncludeShort ? examShortCapacity : 0);
  const examPreviewTotal = Math.max(1, Math.min(examQuestionCount, examEligibleCapacity));
  const examPreviewObjectiveTotal = examIncludeShort
    ? Math.min(Math.max(examPreviewTotal - 1, 0), examObjectiveCapacity)
    : Math.min(examPreviewTotal, examObjectiveCapacity);
  const examPreviewDistribution = allocateExamTypeCounts(examPreviewObjectiveTotal);
  const examPreviewShortCount = examPreviewTotal - examPreviewObjectiveTotal;

  function resetSequenceFilters() {
    setSequenceSearch("");
    setSequenceCategory("全部分类");
    setSequenceType("全部题型");
    setSequenceFilterOpen(false);
  }

  function start(mode: "sequence" | "random" | "category" | "wrong" | "favorites", focusId?: number) {
    let ids = questions.map(q => q.id);
    if (mode === "sequence") ids = ids.filter(id => id >= stats.lastId).concat(ids.filter(id => id < stats.lastId));
    if (mode === "random") ids = [...ids].sort(() => Math.random() - .5);
    if (mode === "category") ids = questions.filter(q => (category === "全部分类" || q.category === category) && (filterType === "全部题型" || q.type === filterType)).map(q => q.id);
    if (mode === "wrong") ids = stats.wrong.filter(id => {
      const count = stats.wrongCounts[String(id)] || 1;
      const item = questions.find(question => question.id === id);
      const matchesType = wrongIncludeShort || item?.type !== "简答题";
      const matchesCount = wrongFilter === "all" || (wrongFilter === "1" && count === 1) || (wrongFilter === "2" && count === 2) || (wrongFilter === "3plus" && count >= 3);
      return matchesType && matchesCount;
    });
    if (mode === "favorites") ids = stats.favorites;
    if (!ids.length) return;
    ids = sortQuestionIdsByType(ids);
    const nextCursor = focusId === undefined ? 0 : Math.max(0, ids.indexOf(focusId));
    const labels = { sequence: "顺序练习", random: "随机练习", category: "专项练习", wrong: "错题复习", favorites: "收藏练习" };
    const nextSession = { queue: ids, cursor: nextCursor, label: labels[mode], updatedAt: Date.now() };
    setSession(nextSession); setQueue(ids); setCursor(nextCursor); setSelected([]); setSubmitted(false); setPracticeResponses({}); resetSequenceFilters(); setView("quiz");
  }

  function resumePractice() {
    if (!session || !session.queue.length) return;
    const currentId = session.queue[Math.min(session.cursor, session.queue.length - 1)];
    const sortedQueue = sortQuestionIdsByType(session.queue);
    const nextCursor = Math.max(0, sortedQueue.indexOf(currentId));
    const nextSession = { ...session, queue: sortedQueue, cursor: nextCursor, updatedAt: Date.now() };
    setSession(nextSession); setQueue(sortedQueue); setCursor(nextCursor); setSelected([]); setSubmitted(false); setPracticeResponses({}); resetSequenceFilters(); setView("quiz");
  }

  function discardSession() { setSession(null); setQueue([]); setCursor(0); setSelected([]); setSubmitted(false); }

  function weightedSample(pool: Question[], count: number, strategy: DrawStrategy) {
    const remaining = [...pool];
    const picked: Question[] = [];
    while (picked.length < count && remaining.length) {
      const weights = remaining.map(item => {
        if (strategy === "wrong") {
          const wrongCount = stats.wrongCounts[String(item.id)] || 0;
          return 1 + wrongCount * wrongCount * 3;
        }
        if (strategy === "favorite") return stats.favorites.includes(item.id) ? 9 : 1;
        return 1;
      });
      const total = weights.reduce((sum, value) => sum + value, 0);
      let target = Math.random() * total;
      let index = 0;
      for (; index < weights.length - 1; index++) {
        target -= weights[index];
        if (target <= 0) break;
      }
      picked.push(remaining[index]);
      remaining.splice(index, 1);
    }
    return picked;
  }

  function startSmartPractice() {
    const pool = questions.filter(item => practiceIncludeShort || item.type !== "简答题");
    const count = Math.max(1, Math.min(practiceQuestionCount, pool.length));
    let selectedQuestions: Question[];
    if (practiceIncludeShort) {
      const shortPool = questions.filter(item => item.type === "简答题");
      const requiredShort = shortPool[Math.floor(Math.random() * shortPool.length)];
      const remaining = weightedSample(pool.filter(item => item.id !== requiredShort.id), count - 1, practiceStrategy);
      selectedQuestions = [requiredShort, ...remaining].sort(() => Math.random() - .5);
    } else {
      selectedQuestions = weightedSample(pool, count, practiceStrategy);
    }
    const ids = sortQuestionIdsByType(selectedQuestions.map(item => item.id));
    const strategyNames = { wrong: "错题优先", random: "随机抽题", favorite: "收藏优先" };
    const nextSession = { queue: ids, cursor: 0, label: `${strategyNames[practiceStrategy]}练习`, updatedAt: Date.now() };
    setSession(nextSession); setQueue(ids); setCursor(0); setSelected([]); setSubmitted(false); setPracticeResponses({}); resetSequenceFilters(); setView("quiz");
  }

  function startExam() {
    const eligibleCapacity = examObjectiveCapacity + (examIncludeShort ? examShortCapacity : 0);
    const count = Math.max(1, Math.min(examQuestionCount, eligibleCapacity));
    const objectiveCount = examIncludeShort
      ? Math.min(Math.max(count - 1, 0), examObjectiveCapacity)
      : Math.min(count, examObjectiveCapacity);
    const distribution = allocateExamTypeCounts(objectiveCount);
    const selectedQuestions: Question[] = [];

    for (const type of examObjectiveTypeOrder) {
      const typePool = questions.filter(item => item.type === type);
      selectedQuestions.push(...weightedSample(typePool, distribution[type], examStrategy));
    }

    if (examIncludeShort) {
      const shortCount = count - selectedQuestions.length;
      const shortPool = questions.filter(item => item.type === "简答题");
      selectedQuestions.push(...weightedSample(shortPool, shortCount, examStrategy));
    }

    const ids = sortQuestionIdsByType(selectedQuestions.map(item => item.id), examQuestionTypeOrder);
    discardSession();
    setQueue(ids); setCursor(0); setSelected([]); setSubmitted(false);
    setExamActive(true); setExamResponses({}); setExamSummary(null); setExamSubmitStage(null); setExamResultFilter("all");
    setView("quiz");
  }

  function nav(next: View) { setView(next); setSelected([]); setSubmitted(false); }
  const q = queue.length ? questions.find(item => item.id === queue[cursor]) : undefined;
  const answerKeys = q ? (Array.isArray(q.answer) ? q.answer : q.answer.split("")) : [];
  const currentAnswerCorrect = !!q && [...selected].sort().join("") === [...answerKeys].sort().join("");
  const sequenceSearchResults = useMemo(() => {
    return sortQuestionsByType(questions.filter(item => matchesQuestionFilters(item, sequenceType, sequenceCategory, sequenceSearch)));
  }, [sequenceType, sequenceCategory, sequenceSearch]);
  const sequenceFilterActive = sequenceType !== "全部题型" || sequenceCategory !== "全部分类" || normalizeSearchText(sequenceSearch).length > 0;
  const filteredQuestionBank = useMemo(() => {
    return sortQuestionsByType(questions.filter(item => matchesQuestionFilters(item, questionBankType, questionBankCategory, questionBankSearch)));
  }, [questionBankType, questionBankCategory, questionBankSearch]);
  const questionBankGroups = useMemo(() => groupQuestionsByType(filteredQuestionBank), [filteredQuestionBank]);
  const filteredExamReviews = examSummary ? (examResultFilter === "wrong" ? examSummary.reviews.filter(review => review.correct === false) : examSummary.reviews) : [];
  const examScore = examSummary?.objectiveTotal ? Math.round(examSummary.correct / examSummary.objectiveTotal * 100) : 0;
  const examPassed = examScore >= 90;
  const hasExamResponse = (id: number) => {
    const response = examResponses[String(id)] || [];
    const item = questions.find(question => question.id === id);
    return item?.type === "简答题" ? response.some(answer => answer.trim().length > 0) : response.length > 0;
  };
  const unansweredExamIds = examActive ? queue.filter(id => !hasExamResponse(id)) : [];
  function toggle(key: string) {
    if (!q || submitted) return;
    const next = q.type === "多选题" ? (selected.includes(key) ? selected.filter(x => x !== key) : [...selected, key]) : [key];
    setSelected(next);
    if (examActive) setExamResponses(current => ({ ...current, [q.id]: next }));
  }
  function submit() {
    if (!q || !selected.length || submitted) return;
    const ok = [...selected].sort().join("") === [...answerKeys].sort().join("");
    setSubmitted(true);
    setPracticeResponses(current => ({ ...current, [q.id]: { response: [...selected], correct: ok } }));
    setStats(s => ({
      ...s,
      answered: s.answered + 1,
      correct: s.correct + (ok ? 1 : 0),
      wrong: ok ? s.wrong : Array.from(new Set([...s.wrong, q.id])),
      wrongCounts: ok ? s.wrongCounts : { ...s.wrongCounts, [q.id]: (s.wrongCounts[String(q.id)] || 0) + 1 },
      lastId: q.id + 1,
      dates: [...s.dates, today]
    }));
  }
  function requestExamSubmission() {
    if (!examActive || !queue.length) return;
    setExamSubmitStage("confirm");
  }
  function continueExamSubmission() {
    if (unansweredExamIds.length) {
      setExamSubmitStage("unanswered");
      return;
    }
    finalizeExamSubmission();
  }
  function finalizeExamSubmission() {
    if (!examActive || !queue.length) return;
    const reviews = queue.map(id => {
      const item = questions.find(question => question.id === id)!;
      const savedResponse = examResponses[String(id)] || [];
      const response = item.type === "简答题" && !hasExamResponse(id) ? [] : savedResponse;
      const keys = Array.isArray(item.answer) ? item.answer : item.answer.split("");
      const correct = item.type === "简答题" ? null : [...response].sort().join("") === [...keys].sort().join("");
      return { id, response, correct } satisfies ExamReview;
    });
    const objectiveReviews = reviews.filter(review => review.correct !== null);
    const correct = objectiveReviews.filter(review => review.correct).length;
    const wrongIds = objectiveReviews.filter(review => !review.correct).map(review => review.id);

    setStats(s => {
      const nextWrongCounts = { ...s.wrongCounts };
      for (const id of wrongIds) nextWrongCounts[String(id)] = (nextWrongCounts[String(id)] || 0) + 1;
      return {
        ...s,
        answered: s.answered + objectiveReviews.length,
        correct: s.correct + correct,
        wrong: Array.from(new Set([...s.wrong, ...wrongIds])),
        wrongCounts: nextWrongCounts,
        dates: [...s.dates, ...Array(objectiveReviews.length).fill(today)]
      };
    });
    setExamSummary({ correct, objectiveTotal: objectiveReviews.length, reviews });
    setExamSubmitStage(null); setExamActive(false); setQueue([]); setSelected([]); setView("examResult");
  }
  function jumpToQuestion(index: number) {
    if (index < 0 || index >= queue.length) return;
    const id = queue[index];
    setCursor(index);
    setSession(current => current ? { ...current, cursor: index, updatedAt: Date.now() } : current);
    if (examActive) {
      setSelected(examResponses[String(id)] || []);
      setSubmitted(false);
    } else {
      const saved = practiceResponses[String(id)];
      setSelected(saved?.response || []);
      setSubmitted(!!saved);
    }
  }
  function nextQuestion(step = 1) {
    const nextCursor = Math.max(0, Math.min(queue.length - 1, cursor + step));
    jumpToQuestion(nextCursor);
  }
  function finishPractice() { discardSession(); nav("home"); }
  function favorite(id: number) { setStats(s => ({ ...s, favorites: s.favorites.includes(id) ? s.favorites.filter(x => x !== id) : [...s.favorites, id] })); }
  function formatAnswer(item: Question, answers: string[]) {
    if (!answers.length) return "未作答";
    if (item.type === "简答题") return answers[0];
    return answers.map(key => {
      const option = item.options.find(choice => choice.key === key);
      return option ? `${key}. ${option.text}` : key;
    }).join("；");
  }
  function standardAnswer(item: Question) {
    const keys = Array.isArray(item.answer) ? item.answer : item.type === "简答题" ? [item.answer] : item.answer.split("");
    return formatAnswer(item, keys);
  }

  if (!ready || !authReady) return <AuthLoading />;
  if (!authUser && !guestMode) return <AuthScreen config={authConfig} onAuthenticated={handleAuthenticated} onGuest={enterGuestMode} />;

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => nav("home")}><span className="shield">⚡</span><span>培训刷题助手</span></button>
      <nav>
        <button className={view === "home" ? "active" : ""} onClick={() => nav("home")}>首页</button>
        <button className={view === "wrong" ? "active" : ""} onClick={() => nav("wrong")}>错题本 <small>{stats.wrong.length}</small></button>
        <button className={view === "favorites" ? "active" : ""} onClick={() => nav("favorites")}>收藏夹 <small>{stats.favorites.length}</small></button>
        <button className={view === "questionBank" ? "active" : ""} onClick={() => nav("questionBank")}>完整题库</button>
        <button className={view === "records" ? "active" : ""} onClick={() => nav("records")}>学习记录</button>
      </nav>
      <div className="user-panel"><span><b>{nickname}</b>{guestMode ? <small className="local-only">访客 · 仅本地保存</small> : <small className={`cloud-${cloudStatus}`}>{cloudStatus === "syncing" ? "云端同步中" : cloudStatus === "synced" ? "已同步" : cloudStatus === "error" ? "同步失败" : "等待同步"}</small>}</span><button aria-label={guestMode ? "退出访客模式" : "退出登录"} title={guestMode ? "退出访客模式" : "退出登录"} onClick={guestMode ? exitGuestMode : logout}>退出</button></div>
    </header>

    {view === "home" && <main className="dashboard page">
      <section className="welcome"><div><p className="eyebrow">STATE GRID · 培训学习</p><div className="personal-greeting"><h1>{greeting}，{nickname}</h1><button onClick={() => { setNicknameDraft(nickname === "同学" ? "" : nickname); setEditingNickname(true); }}>✎ 修改称呼</button></div><p>系统学习，把每一道题都变成底气</p>{editingNickname && <div className="nickname-editor"><label htmlFor="nickname">希望怎么称呼你？</label><div><input id="nickname" autoFocus maxLength={12} value={nicknameDraft} placeholder="例如：李四、同学" onChange={e => setNicknameDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter") saveNickname(); if (e.key === "Escape") setEditingNickname(false); }} /><button className="primary" onClick={saveNickname}>保存</button><button className="resume-secondary" onClick={() => setEditingNickname(false)}>取消</button></div></div>}</div><div className="streak"><span>▣</span> 连续学习 <strong>{streak}</strong> 天</div></section>
      {session && <section className="resume-card"><div className="resume-icon">↻</div><div><strong>发现未完成的{session.label}</strong><p>上次做到第 {session.cursor + 1} / {session.queue.length} 题，是否继续？</p></div><button className="resume-secondary" onClick={discardSession}>放弃记录</button><button className="primary" onClick={resumePractice}>继续上次练习</button></section>}
      <section className="stats-grid">
        <Stat icon="✓" label="今日完成" value={todayDone} unit="题" />
        <Stat icon="◔" label="总进度" value={progress} unit="%" progress={progress} />
        <Stat icon="◎" label="正确率" value={accuracy} unit="%" />
        <Stat icon="×" label="错题" value={stats.wrong.length} unit="道" red />
      </section>
      <section className="continue-card">
        <div className="continue-copy"><span className="tag">继续上次进度</span><h2>综合培训题库 · 第 {Math.max(1, Math.ceil(stats.lastId / 20))} 组</h2><div className="long-progress"><i style={{ width: `${progress}%` }} /></div><p>题库共 {questions.length} 道，已完成 {stats.answered} 道</p><button className="primary" onClick={() => start("sequence")}>▤　开始刷题</button></div>
      </section>
      <h2 className="section-title">选择练习模式</h2>
      <section className="mode-grid">
        <Mode icon="⌛" title="模拟考试" text="自定义题量，统一交卷评分" onClick={() => setView("examSetup")} />
        <Mode icon="☷" title="顺序练习" text="按题库顺序逐题巩固" onClick={() => start("sequence")} />
        <Mode icon="⤨" title="智能抽题" text="错题、随机或收藏优先" onClick={() => setView("practiceSetup")} />
        <Mode icon="◎" title="专项练习" text="集中突破薄弱知识点" onClick={() => setView("records")} />
      </section>
      <p className="update-note">◷　题库更新至 2026 年版 · 共 {questions.length} 题</p>
    </main>}

    {view === "quiz" && q && <main className="quiz-page page">
      <div className="quiz-top"><button className="back" onClick={() => { setExamSubmitStage(null); setExamActive(false); nav("home"); }}>← {examActive ? "退出考试" : "返回首页"}</button><div className="quiz-progress"><span>{examActive && "模拟考试 · "}{cursor + 1} / {queue.length}</span><i><b style={{ width: `${(cursor + 1) / queue.length * 100}%` }} /></i></div>{examActive ? <button className="primary exam-submit-top" onClick={requestExamSubmission}>交卷</button> : <button className={`fav ${stats.favorites.includes(q.id) ? "on" : ""}`} onClick={() => favorite(q.id)}>★ {stats.favorites.includes(q.id) ? "已收藏" : "收藏"}</button>}</div>
      {session?.label === "顺序练习" && !examActive && <section className="sequence-filter"><QuestionFilterBar idPrefix="sequence" categories={categories} type={sequenceType} category={sequenceCategory} search={sequenceSearch} resultCount={sequenceSearchResults.length} onTypeChange={value => { setSequenceType(value); setSequenceFilterOpen(true); }} onCategoryChange={value => { setSequenceCategory(value); setSequenceFilterOpen(true); }} onSearchChange={value => { setSequenceSearch(value); setSequenceFilterOpen(true); }} onSearchFocus={() => setSequenceFilterOpen(true)} />{sequenceFilterOpen && sequenceFilterActive && <div className="search-results">{sequenceSearchResults.length ? <>{sequenceSearchResults.slice(0, 50).map(item => { const index = queue.indexOf(item.id); return <button key={item.id} disabled={index < 0} onClick={() => { jumpToQuestion(index); setSequenceFilterOpen(false); }}><b>第 {item.id} 题 · {item.type} · {item.category || "未分类"}</b><span>{item.question}</span></button>; })}{sequenceSearchResults.length > 50 && <p>匹配结果较多，当前显示前 50 道，请继续完善筛选条件。</p>}</> : <p>没有找到匹配的题目，请尝试调整题型、知识点或关键词。</p>}</div>}</section>}
      <div className="quiz-layout">
        <article className="question-card">
          <div className="q-meta"><span>{q.type}</span><span>{q.category || "综合培训题库"}</span>{stats.wrongCounts[String(q.id)] > 0 && <span className="wrong-badge">累计答错 {stats.wrongCounts[String(q.id)]} 次</span>}<em>第 {q.id} 题</em></div>
          <h1>{q.question}</h1>
          {q.type === "简答题" ? <textarea aria-label="简答题作答区" placeholder="请在这里输入你的答案要点……" disabled={submitted} value={selected[0] || ""} onChange={e => { const next = e.target.value ? [e.target.value] : []; setSelected(next); if (examActive) setExamResponses(current => ({ ...current, [q.id]: next })); }} /> : <div className="options">{q.options.map(o => {
            const chosen = selected.includes(o.key), right = submitted && answerKeys.includes(o.key), wrong = submitted && chosen && !right;
            return <button key={o.key} className={`${chosen ? "chosen" : ""} ${right ? "right" : ""} ${wrong ? "wrong" : ""}`} onClick={() => toggle(o.key)}><b>{o.key}</b><span>{o.text}</span>{right && <i>✓</i>}{wrong && <i>×</i>}</button>
          })}</div>}
          {!examActive && (!submitted ? <button className="submit primary" disabled={!selected.length} onClick={submit}>提交答案</button> : <div className={`analysis-box ${currentAnswerCorrect ? "" : "answer-wrong"}`}><h3>{currentAnswerCorrect ? "回答正确" : "回答错误"}</h3><p><b>正确答案：</b>{answerKeys.join("、")}</p>{q.basis && <p><b>题目依据：</b>{q.basis}</p>}{q.explanation && <p><b>解析：</b><HighlightDifferences text={q.explanation} question={q.question} /></p>}</div>)}
          <div className={`quiz-actions ${examActive ? "exam-navigation" : "practice-navigation"}`}><button disabled={cursor === 0} onClick={() => nextQuestion(-1)}>← 上一题</button><button disabled={cursor === queue.length - 1} onClick={() => nextQuestion(1)}>下一题 →</button></div>
          {!examActive && submitted && cursor === queue.length - 1 && <button className="submit primary finish-practice" onClick={finishPractice}>完成练习</button>}
        </article>
        <QuestionNavigator queue={queue} current={cursor} answeredIds={examActive ? queue.filter(hasExamResponse) : Object.keys(practiceResponses).map(Number)} wrongIds={examActive ? [] : Object.entries(practiceResponses).filter(([, response]) => !response.correct).map(([id]) => Number(id))} onJump={jumpToQuestion} examMode={examActive} />
      </div>
    </main>}

    {(view === "wrong" || view === "favorites") && <CollectionPage title={view === "wrong" ? "错题本" : "收藏夹"} count={view === "wrong" ? stats.wrong.length : stats.favorites.length} questionIds={view === "wrong" ? activeWrongIds : stats.favorites} totalWrongAttempts={view === "wrong" ? totalWrongAttempts : undefined} wrongGroups={view === "wrong" ? wrongGroups : undefined} wrongFilter={wrongFilter} onWrongFilter={setWrongFilter} includeShort={wrongIncludeShort} onIncludeShort={setWrongIncludeShort} empty={view === "wrong" ? "暂无错题，继续保持！" : "还没有收藏题目"} onStart={() => start(view === "wrong" ? "wrong" : "favorites")} onOpenQuestion={id => start(view === "wrong" ? "wrong" : "favorites", id)} onBack={() => nav("home")} />}

    {view === "questionBank" && <main className="page question-bank-page">
      <div className="question-bank-head"><div><p className="eyebrow">QUESTION BANK · 全量查阅</p><h1>完整题库</h1><p>按题型分类查看全部 {questions.length} 道题目、选项和标准答案</p></div><button className="back" onClick={() => nav("home")}>← 返回首页</button></div>
      <QuestionFilterBar idPrefix="bank" categories={categories} type={questionBankType} category={questionBankCategory} search={questionBankSearch} resultCount={filteredQuestionBank.length} onTypeChange={setQuestionBankType} onCategoryChange={setQuestionBankCategory} onSearchChange={setQuestionBankSearch} />
      <section className="question-bank-list">{questionBankGroups.length ? questionBankGroups.map(group => <section className="question-bank-group" key={group.type} data-question-type={group.type}>
        <div className="question-type-heading"><div><span>{group.type}</span><small>按题型排序</small></div><b>{group.items.length} 道</b></div>
        <div className="question-bank-group-items">{group.items.map(item => <article className="question-bank-item" key={item.id}><div className="bank-question-meta"><span>第 {item.id} 题</span><span>{item.type}</span><span>{item.category || "未分类"}</span></div><h2>{item.question}</h2>{item.options.length > 0 && <div className="bank-options">{item.options.map(option => <p key={option.key}><b>{option.key}</b><span>{option.text}</span></p>)}</div>}<div className="bank-standard-answer"><b>标准答案</b><p>{standardAnswer(item)}</p></div>{item.basis && <div className="bank-detail"><b>题目依据</b><p>{item.basis}</p></div>}{item.explanation && <div className="bank-detail"><b>解析</b><p>{item.explanation}</p></div>}</article>)}</div>
      </section>) : <div className="bank-empty">没有找到符合条件的题目，请调整筛选条件。</div>}</section>
    </main>}

    {view === "records" && <main className="page records-page"><button className="back" onClick={() => nav("home")}>← 返回首页</button><div className="records-head"><p className="eyebrow">专项突破</p><h1>选择练习范围</h1><p>可以按知识分类和题型精准练习</p></div><div className="filters"><label>知识分类<select value={category} onChange={e => setCategory(e.target.value)}>{categories.map(c => <option key={c}>{c}</option>)}</select></label><label>题型<select value={filterType} onChange={e => setFilterType(e.target.value)}>{questionTypes.map(t => <option key={t}>{t}</option>)}</select></label><button className="primary" onClick={() => start("category")}>开始专项练习</button></div><section className="record-stats"><Stat icon="▤" label="累计答题" value={stats.answered} unit="题" /><Stat icon="◎" label="累计正确" value={stats.correct} unit="题" /><Stat icon="★" label="已收藏" value={stats.favorites.length} unit="题" /></section></main>}

    {view === "practiceSetup" && <main className="page exam-page"><button className="back" onClick={() => nav("home")}>← 返回首页</button><section className="exam-card"><Icon>⤨</Icon><p className="eyebrow">智能抽题</p><h1>设置本次练习</h1><p className="exam-intro">通过加权策略组题，题目不会重复抽取。</p><div className="exam-settings"><label>练习题量<input type="number" min="1" max={practiceIncludeShort ? questions.length : questions.filter(item => item.type !== "简答题").length} value={practiceQuestionCount} onChange={e => setPracticeQuestionCount(Number(e.target.value) || 1)} /></label><div className="quick-counts">{[10, 20, 50, 100].map(count => <button key={count} className={practiceQuestionCount === count ? "active" : ""} onClick={() => setPracticeQuestionCount(count)}>{count} 题</button>)}</div><StrategySelector value={practiceStrategy} onChange={setPracticeStrategy} />{examShortCapacity > 0 && <label className="switch-row"><input type="checkbox" checked={practiceIncludeShort} onChange={e => setPracticeIncludeShort(e.target.checked)} /><span><b>包含简答题</b><small>开启后，本次智能练习至少包含 1 道简答题</small></span></label>}</div><button className="primary exam-start" onClick={startSmartPractice}>开始智能练习</button></section></main>}

    {view === "examSetup" && <main className="page exam-page"><button className="back" onClick={() => nav("home")}>← 返回首页</button><section className="exam-card"><Icon tone="amber">⌛</Icon><p className="eyebrow">模拟考试</p><h1>设置本次试卷</h1><p className="exam-intro">客观题默认按判断题、单选题、多选题的顺序排列，并按照 3:4:3 的比例抽取；交卷后统一评分并逐题复盘。</p><div className="exam-settings"><label>随机抽题数量<input type="number" min="1" max={examIncludeShort ? questions.length : questions.filter(item => item.type !== "简答题").length} value={examQuestionCount} onChange={e => setExamQuestionCount(Number(e.target.value) || 1)} /></label><div className="quick-counts">{[10, 20, 50, 100].map(count => <button key={count} className={examQuestionCount === count ? "active" : ""} onClick={() => setExamQuestionCount(count)}>{count} 题</button>)}</div><div className="exam-ratio-preview" aria-label="本次试卷题型分配"><p><span>判断题</span><b>{examPreviewDistribution["判断题"]} 题</b></p><p><span>单选题</span><b>{examPreviewDistribution["单选题"]} 题</b></p><p><span>多选题</span><b>{examPreviewDistribution["多选题"]} 题</b></p>{examPreviewShortCount > 0 && <p><span>简答题</span><b>{examPreviewShortCount} 题</b></p>}</div><StrategySelector value={examStrategy} onChange={setExamStrategy} />{examShortCapacity > 0 && <label className="switch-row"><input type="checkbox" checked={examIncludeShort} onChange={e => setExamIncludeShort(e.target.checked)} /><span><b>包含简答题</b><small>开启后至少抽取 1 道简答题，并统一排在客观题之后</small></span></label>}</div><button className="primary exam-start" onClick={startExam}>开始模拟考试</button></section></main>}

    {view === "examResult" && examSummary && <main className="page exam-page result-page"><section className={`exam-card result-card ${examPassed ? "exam-passed" : "exam-needs-improvement"}`}><Icon>✓</Icon><p className="eyebrow">考试完成</p><h1>本次模拟考试成绩</h1><div className="score-ring"><strong>{examScore}</strong><span>分</span></div><p className="exam-result-message">{examPassed ? "恭喜你通过模拟考试！" : "革命尚未成功，同志仍需努力！"}</p><div className="result-stats"><div><strong>{examSummary.correct}</strong><span>答对</span></div><div><strong>{examSummary.objectiveTotal - examSummary.correct}</strong><span>答错</span></div><div><strong>{examSummary.objectiveTotal}</strong><span>客观题</span></div>{examSummary.reviews.some(item => item.correct === null) && <div><strong>{examSummary.reviews.filter(item => item.correct === null).length}</strong><span>简答题</span></div>}</div><div className="result-actions"><button className="resume-secondary" onClick={() => nav("home")}>返回首页</button><button className="primary" onClick={() => setView("examSetup")}>再考一次</button></div></section><section className="exam-review-list"><div className="review-title"><p className="eyebrow">逐题复盘</p><h2>{examResultFilter === "wrong" ? `答错的 ${filteredExamReviews.length} 道题` : `全部 ${examSummary.reviews.length} 道题详细解析`}</h2><div className="review-filters"><button className={examResultFilter === "all" ? "active" : ""} onClick={() => setExamResultFilter("all")}>全部题目　{examSummary.reviews.length}</button><button className={examResultFilter === "wrong" ? "active" : ""} onClick={() => setExamResultFilter("wrong")}>只看错题　{examSummary.reviews.filter(review => review.correct === false).length}</button></div></div>{filteredExamReviews.length ? filteredExamReviews.map(review => { const item = questions.find(question => question.id === review.id)!; const originalIndex = examSummary.reviews.findIndex(candidate => candidate.id === review.id); const explanation = item.explanation || item.basis || "本题暂无补充解析，请结合标准答案巩固记忆。"; return <article key={review.id} className={`review-item ${review.correct === true ? "review-correct" : review.correct === false ? "review-wrong" : "review-short"}`}><div className="review-meta"><span>第 {originalIndex + 1} 题 · {item.type}</span><b>{review.correct === true ? "回答正确" : review.correct === false ? "回答错误" : "简答题自评"}</b></div><h3>{item.question}</h3><div className="answer-compare"><p><b>你的答案</b><span>{formatAnswer(item, review.response)}</span></p><p><b>标准答案</b><span>{standardAnswer(item)}</span></p></div><div className="review-analysis"><b>解析</b><p><HighlightDifferences text={explanation} question={item.question} /></p></div></article>}) : <div className="no-wrong-result">本次考试没有答错的客观题，继续保持！</div>}</section></main>}

    {pendingLocalImport && <div className="dialog-backdrop"><section className="submit-dialog migration-dialog" role="dialog" aria-modal="true" aria-labelledby="migration-title"><div className="dialog-icon">↥</div><h2 id="migration-title">检测到本机学习记录</h2><p>这个账号还没有云端记录。你可以把当前浏览器里的学习进度一次性导入账号。</p><div className="migration-stats"><span><b>{pendingLocalImport.stats.answered}</b>累计答题</span><span><b>{pendingLocalImport.stats.wrong.length}</b>错题</span><span><b>{pendingLocalImport.stats.favorites.length}</b>收藏</span></div>{migrationError && <p className="form-error" role="alert">{migrationError}</p>}<div className="dialog-actions"><button className="resume-secondary" disabled={migrationBusy} onClick={skipLocalProgress}>不导入</button><button className="primary" disabled={migrationBusy} onClick={importLocalProgress}>{migrationBusy ? "正在导入…" : "导入到云端"}</button></div></section></div>}

    {examSubmitStage && <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setExamSubmitStage(null); }}><section className="submit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="submit-dialog-title" aria-describedby="submit-dialog-description"><div className={`dialog-icon ${examSubmitStage === "unanswered" ? "warning" : ""}`}>{examSubmitStage === "unanswered" ? "!" : "✓"}</div><h2 id="submit-dialog-title">{examSubmitStage === "unanswered" ? "还有题目未完成" : "确认交卷吗？"}</h2><p id="submit-dialog-description">{examSubmitStage === "unanswered" ? `还有 ${unansweredExamIds.length} 道题未完成，未答题将按答错计分。确定仍要交卷吗？` : "交卷后将统一提交所有答案并立即评分，且无法继续修改。"}</p><div className="dialog-actions"><button className="resume-secondary" autoFocus onClick={() => setExamSubmitStage(null)}>继续答题</button><button className={`primary ${examSubmitStage === "unanswered" ? "danger-submit" : ""}`} onClick={examSubmitStage === "unanswered" ? finalizeExamSubmission : continueExamSubmission}>{examSubmitStage === "unanswered" ? "仍要交卷" : "确认交卷"}</button></div></section></div>}
  </div>;
}

function AuthLoading() {
  return <main className="auth-shell"><section className="auth-card auth-loading"><span className="shield">⚡</span><h1>培训刷题助手</h1><p>正在安全连接账号服务…</p><i aria-hidden="true" /></section></main>;
}

function AuthScreen({ config, onAuthenticated, onGuest }: { config: AuthConfig; onAuthenticated: (user: AuthUser) => Promise<void>; onGuest: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [captchaId, setCaptchaId] = useState("");
  const [captchaCode, setCaptchaCode] = useState("");
  const [captchaImage, setCaptchaImage] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [captchaError, setCaptchaError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function loadCaptcha() {
    setCaptchaLoading(true);
    setCaptchaError("");
    setCaptchaCode("");
    try {
      const challenge = await apiRequest<CaptchaChallenge>("/api/captcha");
      setCaptchaId(challenge.captchaId);
      setCaptchaImage(challenge.imageUrl);
    } catch (caught) {
      setCaptchaId("");
      setCaptchaImage("");
      setCaptchaError(caught instanceof Error ? caught.message : "验证码加载失败");
    } finally {
      setCaptchaLoading(false);
    }
  }

  useEffect(() => {
    if (mode === "register" && config.registrationEnabled) void loadCaptcha();
  }, [mode, config.registrationEnabled]);

  function switchMode(nextMode: "login" | "register") {
    setMode(nextMode);
    setError("");
    setPassword("");
    setConfirmPassword("");
    setCaptchaCode("");
    setCaptchaError("");
  }

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (mode === "register" && password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    if (mode === "register" && (!captchaId || captchaCode.trim().length !== 5)) {
      setError("请输入图中的 5 位验证码");
      return;
    }
    setBusy(true);
    try {
      const result = await apiRequest<{ user: AuthUser }>(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, nickname, password, captchaId, captchaCode }),
      });
      await onAuthenticated(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败，请稍后重试");
      if (mode === "register") await loadCaptcha();
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span className="shield">⚡</span><div><p>STATE GRID · 培训学习</p><h1>培训刷题助手</h1></div></div><p className="auth-intro">登录账号可在不同设备间同步学习记录；访客进入时，数据只保存在当前浏览器。</p><div className="auth-tabs" role="tablist"><button className={mode === "login" ? "active" : ""} onClick={() => switchMode("login")}>账号登录</button><button className={mode === "register" ? "active" : ""} disabled={!config.registrationEnabled} onClick={() => switchMode("register")}>注册账号</button></div><form className="auth-form" onSubmit={submitAuth}><label>用户名<input autoComplete="username" required minLength={3} maxLength={24} value={username} onChange={event => setUsername(event.target.value)} placeholder="3–24 位中文、字母或数字" /></label>{mode === "register" && <label>昵称<input autoComplete="nickname" required maxLength={12} value={nickname} onChange={event => setNickname(event.target.value)} placeholder="在首页显示的称呼" /></label>}<label>密码<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder="至少 8 个字符" /></label>{mode === "register" && <><label>确认密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="再次输入密码" /></label><label>图形验证码<div className="captcha-row"><input autoComplete="off" inputMode="text" required maxLength={5} value={captchaCode} onChange={event => setCaptchaCode(event.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase())} placeholder="输入 5 位验证码" /><button className="captcha-image" type="button" onClick={() => void loadCaptcha()} disabled={captchaLoading} aria-label="刷新图形验证码">{captchaImage ? <img src={captchaImage} alt="字母数字图形验证码" /> : <span>{captchaLoading ? "加载中…" : "重新加载"}</span>}</button><button className="captcha-refresh" type="button" onClick={() => void loadCaptcha()} disabled={captchaLoading}>换一张</button></div></label>{captchaError && <p className="form-error" role="alert">{captchaError}</p>}</>}{error && <p className="form-error" role="alert">{error}</p>}<button className="primary auth-submit" disabled={busy}>{busy ? (mode === "login" ? "正在登录…" : "正在注册…") : (mode === "login" ? "登录并继续" : "创建账号")}</button></form>{!config.registrationEnabled && <p className="registration-note">账号注册服务暂时不可用，仍可使用访客模式。</p>}<div className="guest-divider"><span>或</span></div><button className="guest-entry" type="button" onClick={onGuest}><b>访客进入</b><small>无需注册，学习数据仅保存在当前浏览器</small></button><p className="auth-security">账号密码经过单向加密保存；图形验证码仅用于防止批量注册。</p></section></main>;
}

function QuestionFilterBar({ idPrefix, categories, type, category, search, resultCount, onTypeChange, onCategoryChange, onSearchChange, onSearchFocus }: { idPrefix: string; categories: string[]; type: string; category: string; search: string; resultCount: number; onTypeChange: (value: string) => void; onCategoryChange: (value: string) => void; onSearchChange: (value: string) => void; onSearchFocus?: () => void }) {
  return <div className="question-filter-bar"><div className="question-filter-fields"><label htmlFor={`${idPrefix}-type`}>题目类型<select id={`${idPrefix}-type`} value={type} onChange={event => onTypeChange(event.target.value)}>{questionTypes.map(item => <option key={item}>{item}</option>)}</select></label><label htmlFor={`${idPrefix}-category`}>知识点类型<select id={`${idPrefix}-category`} value={category} onChange={event => onCategoryChange(event.target.value)}>{categories.map(item => <option key={item}>{item}</option>)}</select></label><label className="question-search-field" htmlFor={`${idPrefix}-search`}>题干模糊搜索<input id={`${idPrefix}-search`} value={search} onFocus={onSearchFocus} onChange={event => onSearchChange(event.target.value)} placeholder="输入关键词或连续字符，例如：工作票、有限空间" /></label></div><p className="question-filter-summary">找到 <strong>{resultCount}</strong> 道题</p></div>;
}

function QuestionNavigator({ queue, current, answeredIds, wrongIds, onJump, examMode = false }: { queue: number[]; current: number; answeredIds: number[]; wrongIds: number[]; onJump: (index: number) => void; examMode?: boolean }) {
  const answered = new Set(answeredIds);
  const wrong = new Set(wrongIds);
  const positionById = new Map(queue.map((id, index) => [id, index]));
  const groups = groupQuestionsByType(queue.map(id => questionsById.get(id)).filter((item): item is Question => !!item), examMode ? examQuestionTypeOrder : questionTypeOrder);
  return <aside className="question-navigator"><div className="navigator-head"><div><small>题目列表 · 按题型分类</small><h2>{queue.length} 道题</h2></div><span>{answered.size} 已答</span></div><div className="navigator-groups">{groups.map(group => <section className="navigator-type-group" key={group.type} data-question-type={group.type}><div className="navigator-type-head"><span>{group.type}</span><b>{group.items.length} 道</b></div><div className="question-number-grid">{group.items.map(item => { const index = positionById.get(item.id)!; return <button key={`${item.id}-${index}`} title={`第 ${index + 1} 题 · ${item.type} · 题库编号 ${item.id}`} aria-label={`第 ${index + 1} 题，${item.type}`} className={`${index === current ? "current" : ""} ${answered.has(item.id) ? "answered" : ""} ${wrong.has(item.id) ? "answered-wrong" : ""}`} onClick={() => onJump(index)}>{index + 1}</button>; })}</div></section>)}</div><div className="navigator-legend"><span><i className="legend-current" />当前</span><span><i className="legend-answered" />已答</span>{wrongIds.length > 0 && <span><i className="legend-wrong" />答错</span>}</div></aside>;
}

function HighlightDifferences({ text, question }: { text: string; question: string }) {
  const normalizedQuestion = question.toLocaleLowerCase().replace(/\s+/g, "");
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  return <>{Array.from(segmenter.segment(text)).map((part, index) => {
    const normalizedPart = part.segment.toLocaleLowerCase().replace(/\s+/g, "");
    const isDifferent = part.isWordLike && normalizedPart.length > 0 && !normalizedQuestion.includes(normalizedPart);
    return isDifferent ? <strong className="analysis-difference" key={`${index}-${part.segment}`}>{part.segment}</strong> : <span key={`${index}-${part.segment}`}>{part.segment}</span>;
  })}</>;
}

function Stat({ icon, label, value, unit, progress, red }: { icon: string; label: string; value: number; unit: string; progress?: number; red?: boolean }) { return <article className={`stat-card ${red ? "red" : ""}`}><Icon tone={red ? "red" : "green"}>{icon}</Icon><div><p>{label}</p><strong>{value}<small>{unit}</small></strong>{progress !== undefined && <span className="mini-progress"><i style={{ width: `${progress}%` }} /></span>}</div></article> }
function Mode({ icon, title, text, onClick }: { icon: string; title: string; text: string; onClick: () => void }) { return <button className="mode-card" onClick={onClick}><Icon>{icon}</Icon><span><strong>{title}</strong><small>{text}</small></span><b>›</b></button> }
function StrategySelector({ value, onChange }: { value: DrawStrategy; onChange: (strategy: DrawStrategy) => void }) {
  const strategies: Array<{ key: DrawStrategy; title: string; text: string; icon: string }> = [
    { key: "wrong", title: "错题优先", text: "错误次数越多，抽中概率越高", icon: "×" },
    { key: "random", title: "随机抽题", text: "题库中的题目等概率抽取", icon: "⤨" },
    { key: "favorite", title: "收藏优先", text: "收藏题目的抽中概率更高", icon: "★" }
  ];
  return <fieldset className="strategy-selector"><legend>选题策略</legend>{strategies.map(strategy => <button type="button" key={strategy.key} className={value === strategy.key ? "active" : ""} onClick={() => onChange(strategy.key)}><i>{strategy.icon}</i><span><b>{strategy.title}</b><small>{strategy.text}</small></span><em>{value === strategy.key ? "✓" : ""}</em></button>)}</fieldset>
}
function CollectionPage({ title, count, questionIds, totalWrongAttempts, wrongGroups, wrongFilter, onWrongFilter, includeShort, onIncludeShort, empty, onStart, onOpenQuestion, onBack }: { title: string; count: number; questionIds: number[]; totalWrongAttempts?: number; wrongGroups?: Record<"all" | "1" | "2" | "3plus", number>; wrongFilter: "all" | "1" | "2" | "3plus"; onWrongFilter: (filter: "all" | "1" | "2" | "3plus") => void; includeShort: boolean; onIncludeShort: (include: boolean) => void; empty: string; onStart: () => void; onOpenQuestion: (id: number) => void; onBack: () => void }) {
  const activeCount = questionIds.length;
  const questionGroups = groupQuestionsByType(questionIds.map(id => questionsById.get(id)).filter((item): item is Question => !!item));
  const filters: Array<{ key: "all" | "1" | "2" | "3plus"; label: string }> = [
    { key: "all", label: "全部错题" }, { key: "1", label: "错 1 次" }, { key: "2", label: "错 2 次" }, { key: "3plus", label: "错 3 次及以上" }
  ];
  return <main className="page collection"><button className="back" onClick={onBack}>← 返回首页</button><div className="collection-card"><Icon>{title === "错题本" ? "×" : "★"}</Icon><h1>{title}</h1><p>{count ? `共有 ${count} 道题等待反复巩固` : empty}</p>{totalWrongAttempts !== undefined && count > 0 && <div className="wrong-summary"><strong>{totalWrongAttempts}</strong><span>累计答错次数</span><small>答对后仍保留在错题本中</small></div>}{wrongGroups && count > 0 && <>{examShortCapacity > 0 && <label className="switch-row wrong-short-switch"><input type="checkbox" checked={includeShort} onChange={event => onIncludeShort(event.target.checked)} /><span><b>包含简答题</b><small>{includeShort ? "本次错题练习将包含简答题" : "本次错题练习仅包含客观题"}</small></span></label>}<div className="wrong-filters" aria-label="按错误次数筛选">{filters.map(filter => <button key={filter.key} className={wrongFilter === filter.key ? "active" : ""} onClick={() => onWrongFilter(filter.key)}><span>{filter.label}</span><b>{wrongGroups[filter.key]}</b></button>)}</div></>}{count > 0 && <button className="primary" disabled={activeCount === 0} onClick={onStart}>{activeCount ? `练习这 ${activeCount} 道题` : "该分类暂无错题"}</button>}</div>{questionGroups.length > 0 && <section className="collection-question-list"><div className="collection-list-head"><div><p className="eyebrow">QUESTION LIST · 题型分类</p><h2>题目列表</h2></div><span>点击题目直接开始练习</span></div>{questionGroups.map(group => <section className="collection-type-group" key={group.type} data-question-type={group.type}><div className="question-type-heading"><div><span>{group.type}</span><small>按题型排序</small></div><b>{group.items.length} 道</b></div><div className="collection-question-items">{group.items.map(item => <button key={item.id} onClick={() => onOpenQuestion(item.id)}><span>第 {item.id} 题</span><p>{item.question}</p><b>开始练习 ›</b></button>)}</div></section>)}</section>}</main>
}
