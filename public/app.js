let appData = null;
let activeSession = null;
let refreshTimer = null;
let mode = "admin";
let responseContext = null;

function safeJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const student = {
  id: localStorage.getItem("olimpiadasStudentId") || makeId(),
  code: "",
  name: localStorage.getItem("olimpiadasStudentName") || "",
  rut: localStorage.getItem("olimpiadasStudentRut") || "",
  joined: false,
  answeredQuestion: null,
  answers: safeJson(localStorage.getItem("olimpiadasStudentAnswers"), {}),
};
localStorage.setItem("olimpiadasStudentId", student.id);
let draftSelection = safeJson(localStorage.getItem("olimpiadasDraftSelection"), null);

const $ = (id) => document.getElementById(id);

function authKey(role) {
  return role === "projection" ? "olimpiadasAuthProjection" : "olimpiadasAuthAdmin";
}

function currentAuthForRole(role) {
  return safeJson(localStorage.getItem(authKey(role)), null) || safeJson(localStorage.getItem("olimpiadasAuth"), null);
}

function authHeaders() {
  const expectedRole = mode === "projection" ? "projection" : "admin";
  const current = currentAuthForRole(expectedRole);
  return current?.token ? { Authorization: `Bearer ${current.token}` } : {};
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Error de conexion");
    error.status = response.status;
    throw error;
  }
  return data;
}

function adminAuthExpired(error) {
  return error?.status === 403 && String(error.message || "").includes("administradora");
}

function requireFreshAdminLogin(error) {
  if (!adminAuthExpired(error)) return false;
  localStorage.removeItem(authKey("admin"));
  localStorage.removeItem("olimpiadasAuth");
  clearInterval(refreshTimer);
  activeSession = null;
  setView("loginView");
  setRoleLabel("Administrador");
  $("loginUser").value = "";
  $("loginPass").value = "";
  $("loginTitle").textContent = "Cuenta administradora";
  $("loginHint").textContent = "La sesión guardada no era válida. Ingresa nuevamente con tu cuenta autorizada.";
  return true;
}

function setView(view) {
  document.body.dataset.view = view;
  ["loginView", "adminView", "projectionView", "studentView"].forEach((id) => {
    $(id).classList.toggle("active", id === view);
  });
}

function setRoleLabel(text) {
  document.querySelectorAll(".role-nav a").forEach((link) => link.classList.remove("active"));
  if (text === "Administrador") $("navAdmin")?.classList.add("active");
  if (text === "Proyección") $("navProjection")?.classList.add("active");
  if (text === "Estudiante") $("navStudent")?.classList.add("active");
}

function fmt(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function fillSelectors() {
  $("sectionSelect").innerHTML = appData.sections
    .map((item) => {
      const label = `${item.section} | ${item.subject} | ${item.teacher || "Sin docente"}`;
      return `<option value="${item.id}">${escapeHtml(label)}</option>`;
    })
    .join("");

  $("bankSelect").innerHTML = appData.banks
    .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`)
    .join("");
  renderQuestions();
  renderUploadManager();
}

function selectedBank() {
  return appData.banks.find((item) => item.id === $("bankSelect").value);
}

function renderQuestions() {
  const bank = selectedBank();
  if (!bank) return;
  $("questionList").innerHTML = bank.questions
    .map(
      (question, index) => `
        <article class="question-item">
          <label class="question-check">
            <input type="checkbox" class="question-select" value="${index}" checked />
            <span><strong>${index + 1}.</strong> ${escapeHtml(question.text.replace(/^\d+\.\s*/, ""))}</span>
          </label>
          <div class="answer-key">
            ${question.answers
              .map((answer) => `<span>${escapeHtml(answer.text)} <strong>${answer.points} pts</strong></span>`)
              .join("")}
          </div>
          <button type="button" data-question="${index}">Publicar solo esta</button>
        </article>
      `
    )
    .join("");
  document.querySelectorAll("[data-question]").forEach((button) => {
    button.addEventListener("click", () => launchQuestion(Number(button.dataset.question)));
  });
}

function selectedResponseContext() {
  const section = appData.sections.find((item) => item.id === $("sectionSelect").value) || null;
  const bank = appData.banks.find((item) => item.id === $("bankSelect").value) || null;
  const activeMatches =
    activeSession?.section?.id === section?.id && activeSession?.bank?.id === bank?.id;
  return {
    section,
    bank,
    expectedParticipants: activeMatches ? Number(activeSession.expectedParticipants || 0) : 0,
    participants: [],
  };
}

async function loadResponsesForSelected() {
  if (!appData || mode !== "admin") return;
  const sectionId = $("sectionSelect").value;
  const bankId = $("bankSelect").value;
  if (!sectionId || !bankId) return;
  try {
    responseContext = await api(`/api/responses?sectionId=${encodeURIComponent(sectionId)}&bankId=${encodeURIComponent(bankId)}`);
    renderResponses(responseContext.participants || [], responseContext);
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    responseContext = selectedResponseContext();
    renderResponses([], responseContext);
    $("currentQuestion").textContent = `No se pudieron cargar respuestas filtradas: ${error.message}`;
  }
}

function handleBankChange() {
  renderQuestions();
  loadResponsesForSelected();
}

async function deleteCurrentBank() {
  await deleteBankById($("bankSelect").value);
}

async function deleteBankById(bankId) {
  try {
    const bank = appData.banks.find((item) => item.id === bankId);
    if (!bank) return;
    if (!confirm(`Eliminar banco de preguntas: ${bank.name}?`)) return;
    const result = await api(`/api/banks/${encodeURIComponent(bank.id)}`, { method: "DELETE" });
    appData.banks = result.banks;
    fillSelectors();
    $("selectionStatus").textContent = "Banco de preguntas eliminado.";
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("selectionStatus").textContent = `No se pudo eliminar el banco: ${error.message}`;
  }
}

function renderUploadManager() {
  const manager = $("uploadManager");
  if (!manager) return;
  const uploaded = appData.banks.filter((bank) => String(bank.id).startsWith("word-"));
  manager.innerHTML = uploaded.length
    ? `
      <strong>Cargas de preguntas</strong>
      ${uploaded
        .map(
          (bank) => `
            <div class="upload-row">
              <span>${escapeHtml(bank.name)} · ${bank.questions.length} preguntas</span>
              <button type="button" data-use-upload="${bank.id}">Usar</button>
              <button type="button" data-delete-upload="${bank.id}">Eliminar</button>
            </div>
          `
        )
        .join("")}
    `
    : "<p class='hint'>Aun no hay cuestionarios Word cargados.</p>";
  document.querySelectorAll("[data-use-upload]").forEach((button) => {
    button.addEventListener("click", () => {
      $("bankSelect").value = button.dataset.useUpload;
      renderQuestions();
      $("selectionStatus").textContent = "Banco cargado seleccionado.";
    });
  });
  document.querySelectorAll("[data-delete-upload]").forEach((button) => {
    button.addEventListener("click", () => deleteBankById(button.dataset.deleteUpload));
  });
}

function selectedQuestionValues() {
  return [...document.querySelectorAll(".question-select:checked")].map((input) => Number(input.value));
}

function currentDraft() {
  return {
    sectionId: $("sectionSelect").value,
    bankId: $("bankSelect").value,
    durationSeconds: Number($("durationMinutes").value || 10) * 60,
    expectedParticipants: Number($("expectedParticipants").value || 0),
    selectedQuestions: selectedQuestionValues(),
  };
}

function saveDraftSelection() {
  draftSelection = currentDraft();
  localStorage.setItem("olimpiadasDraftSelection", JSON.stringify(draftSelection));
  $("selectionStatus").textContent = `Selección guardada: ${draftSelection.selectedQuestions.length} preguntas. Aún no se genera código.`;
}

async function login() {
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: { username: $("loginUser").value, password: $("loginPass").value },
    });
    localStorage.setItem(authKey(result.role), JSON.stringify(result));
    localStorage.removeItem("olimpiadasAuth");
    $("loginHint").textContent = "";
    if (result.role === "admin") showAdmin();
    if (result.role === "projection") showProjection();
  } catch (error) {
    $("loginHint").textContent = error.message;
  }
}

function currentAuth(expectedRole) {
  const current = currentAuthForRole(expectedRole);
  if (!current?.token) return null;
  try {
    const decoded = atob(current.token.replaceAll("-", "+").replaceAll("_", "/"));
    if (decoded.split(":").length !== 3) return null;
  } catch {
    return null;
  }
  return current;
}

function requireLogin(expectedRole) {
  const current = currentAuth(expectedRole);
  if (current?.role === expectedRole) return true;
  setView("loginView");
  $("loginUser").value = "";
  $("loginPass").value = "";
  $("loginTitle").textContent = expectedRole === "admin" ? "Cuenta administradora" : "Cuenta de proyección";
  $("loginHint").textContent = "Ingresa con la cuenta autorizada para este perfil.";
  setRoleLabel(expectedRole === "admin" ? "Administrador" : "Proyección");
  return false;
}

async function showAdmin() {
  mode = "admin";
  if (!requireLogin("admin")) return;
  $("pageTitle").textContent = "Panel administrador";
  setRoleLabel("Administrador");
  setView("adminView");
  const savedCode = localStorage.getItem("olimpiadasEvaluatorCode");
  if (savedCode) {
    try {
      activeSession = await api(`/api/session/${savedCode}`);
      restoreSessionSelectors();
      showSessionInvite(activeSession);
      renderAdmin(activeSession);
      startRefresh();
    } catch {
      localStorage.removeItem("olimpiadasEvaluatorCode");
    }
  }
  loadResponsesForSelected();
}

async function showProjection() {
  mode = "projection";
  $("pageTitle").textContent = "Pantalla de proyección";
  setRoleLabel("Proyección");
  setView("projectionView");
  const code = new URLSearchParams(location.search).get("code") || localStorage.getItem("olimpiadasEvaluatorCode");
  if (code) {
    activeSession = await api(`/api/session/${code.toUpperCase()}`);
    renderProjection(activeSession);
    startRefresh();
  } else {
    $("projectionQuestion").textContent = "Abre esta pantalla desde el enlace que entrega el administrador.";
  }
}

function showStudent() {
  mode = "student";
  $("pageTitle").textContent = "Cuestionario estudiantes";
  setRoleLabel("Estudiante");
  setView("studentView");
  const code = new URLSearchParams(location.search).get("code");
  $("studentName").value = code ? "" : student.name;
  $("studentRut").value = code ? "" : student.rut;
  if (code) {
    document.querySelector(".role-nav").classList.add("hidden");
    $("studentCode").value = code.toUpperCase();
    $("studentCodeLabel").classList.add("hidden");
    student.code = code.toUpperCase();
    student.joined = false;
    $("joinBox").classList.add("compact-identity");
    $("joinSession").classList.remove("hidden");
    $("joinSession").textContent = "Comenzar";
    $("answerBox").classList.add("hidden");
    $("answerResult").textContent = "";
    $("quizQuestions").innerHTML = "";
  }
}

function restoreSessionSelectors() {
  if (activeSession?.section?.id) $("sectionSelect").value = activeSession.section.id;
  if (activeSession?.bank?.id) $("bankSelect").value = activeSession.bank.id;
  if (activeSession?.expectedParticipants !== undefined) $("expectedParticipants").value = activeSession.expectedParticipants || 0;
  renderQuestions();
}

async function createSession() {
  try {
    $("createSession").disabled = true;
    const draft = currentDraft();
    if (!draft.sectionId || !draft.bankId) throw new Error("Selecciona una sección y un banco de preguntas.");
    if (!draft.selectedQuestions.length) throw new Error("Selecciona al menos una pregunta.");
    saveDraftSelection();
    $("selectionStatus").textContent = "Generando código QR...";
    activeSession = await api("/api/session", {
      method: "POST",
      body: {
        sectionId: draft.sectionId,
        bankId: draft.bankId,
        durationSeconds: draft.durationSeconds,
        expectedParticipants: draft.expectedParticipants,
      },
    });
    localStorage.setItem("olimpiadasEvaluatorCode", activeSession.code);
    showSessionInvite(activeSession);
    activeSession = await api(`/api/session/${activeSession.code}/publish`, {
      method: "POST",
      body: { selectedQuestions: draft.selectedQuestions, durationSeconds: draft.durationSeconds },
    });
    $("selectionStatus").textContent = `Código ${activeSession.code} generado. QR listo para proyectar.`;
    renderAdmin(activeSession);
    startRefresh();
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("selectionStatus").textContent = `No se pudo generar el QR: ${error.message}`;
  } finally {
    $("createSession").disabled = false;
  }
}

function showSessionInvite(session) {
  $("sessionCard").classList.remove("hidden");
  $("sessionCode").textContent = session.code;
  $("joinUrl").textContent = session.joinUrl;
  $("projectionLink").href = `/proyeccion?code=${session.code}`;
  $("qrImage").alt = "Generando QR para estudiantes";
  $("qrImage").onload = () => {
    $("qrImage").alt = `QR listo para el código ${session.code}`;
  };
  $("qrImage").onerror = () => {
    $("qrImage").alt = "No se pudo cargar el QR. Usa el código o el enlace mostrado.";
    $("selectionStatus").textContent = `Código ${session.code} generado. Si el QR no aparece, usa el enlace: ${session.joinUrl}`;
  };
  $("qrImage").src = `${session.qrUrl}?t=${Date.now()}`;
}

function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshSession, 1000);
}

async function refreshSession() {
  if (!activeSession?.code) return;
  try {
    activeSession = await api(`/api/session/${activeSession.code}`);
    if (mode === "admin") renderAdmin(activeSession);
    if (mode === "projection") renderProjection(activeSession);
    if (mode === "student") renderStudentSession(activeSession);
  } catch (error) {
    if (mode === "admin") $("currentQuestion").textContent = `Sesión no disponible: ${error.message}`;
    activeSession = null;
    localStorage.removeItem("olimpiadasEvaluatorCode");
    $("sessionCard").classList.add("hidden");
    clearInterval(refreshTimer);
  }
}

async function ensureActiveSession() {
  if (activeSession?.code) {
    try {
      activeSession = await api(`/api/session/${activeSession.code}`);
      showSessionInvite(activeSession);
      return activeSession;
    } catch {
      activeSession = null;
      localStorage.removeItem("olimpiadasEvaluatorCode");
      $("sessionCard").classList.add("hidden");
    }
  }
  const savedCode = localStorage.getItem("olimpiadasEvaluatorCode");
  if (savedCode) {
    try {
      activeSession = await api(`/api/session/${savedCode}`);
      showSessionInvite(activeSession);
      return activeSession;
    } catch {
      localStorage.removeItem("olimpiadasEvaluatorCode");
    }
  }
  await createSession();
  return activeSession;
}

async function launchQuestion(questionIndex) {
  try {
    if (!activeSession) await createSession();
    activeSession = await api(`/api/session/${activeSession.code}/question`, {
      method: "POST",
      body: { questionIndex },
    });
    renderAdmin(activeSession);
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("currentQuestion").textContent = `No se pudo publicar la pregunta: ${error.message}`;
  }
}

async function publishQuiz() {
  try {
    saveDraftSelection();
    if (!activeSession) {
      renderAdmin({
        quizPublished: false,
        quizQuestions: [],
        acceptingAnswers: false,
        winnersPublished: false,
        participants: [],
        elapsedSeconds: 0,
      });
      return;
    }
    activeSession = await api(`/api/session/${activeSession.code}/publish`, {
      method: "POST",
      body: currentDraft(),
    });
    renderAdmin(activeSession);
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("selectionStatus").textContent = `No se pudo guardar la selección: ${error.message}`;
  }
}

async function closeQuestion() {
  if (!activeSession) return;
  activeSession = await api(`/api/session/${activeSession.code}/settings`, {
    method: "POST",
    body: { acceptingAnswers: false },
  });
  renderAdmin(activeSession);
}

async function startTimer() {
  if (!activeSession) return;
  activeSession = await api(`/api/session/${activeSession.code}/timer`, {
    method: "POST",
    body: { start: true },
  });
  renderAdmin(activeSession);
}

async function updateExpectedParticipants() {
  if (!activeSession?.code) return;
  try {
    activeSession = await api(`/api/session/${activeSession.code}/settings`, {
      method: "POST",
      body: { expectedParticipants: Number($("expectedParticipants").value || 0) },
    });
    renderAdmin(activeSession);
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("selectionStatus").textContent = `No se pudo guardar la cantidad esperada: ${error.message}`;
  }
}

async function toggleRanking() {
  try {
    $("toggleRanking").disabled = true;
    await ensureActiveSession();
    activeSession = await api(`/api/session/${activeSession.code}/settings`, {
      method: "POST",
      body: { showRanking: !activeSession.showRanking },
    });
    renderAdmin(activeSession);
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("currentQuestion").textContent = `No se pudo cambiar el ranking: ${error.message}`;
  } finally {
    $("toggleRanking").disabled = false;
  }
}

async function toggleAnswers() {
  try {
    $("toggleAnswers").disabled = true;
    $("currentQuestion").textContent = "Preparando apertura de respuestas...";
    await ensureActiveSession();
    if (!activeSession.quizPublished) {
      activeSession = await api(`/api/session/${activeSession.code}/publish`, {
        method: "POST",
        body: currentDraft(),
      });
    }
    const opening = !activeSession.acceptingAnswers;
    activeSession = await api(`/api/session/${activeSession.code}/settings`, {
      method: "POST",
      body: {
        acceptingAnswers: opening,
        expectedParticipants: Number($("expectedParticipants").value || 0),
        ...(opening ? { durationSeconds: Number($("durationMinutes").value || 10) * 60 } : {}),
      },
    });
    renderAdmin(activeSession);
    startRefresh();
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("currentQuestion").textContent = `No se pudo abrir/cerrar respuestas: ${error.message}`;
  } finally {
    $("toggleAnswers").disabled = false;
  }
}

async function publishWinners() {
  try {
    $("publishWinners").disabled = true;
    await ensureActiveSession();
    activeSession = await api(`/api/session/${activeSession.code}/settings`, {
      method: "POST",
      body: { winnersPublished: true, showRanking: true },
    });
    renderAdmin(activeSession);
    startRefresh();
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("currentQuestion").textContent = `No se pudo publicar ganadores: ${error.message}`;
  } finally {
    $("publishWinners").disabled = false;
  }
}

function studentAnswerFor(session, questionIndex) {
  const rut = normalizeRut(student.rut);
  const name = normalizeText(student.name);
  const me = session.participants.find((p) => p.id === student.id)
    || session.participants.find((p) => rut && normalizeRut(p.rut) === rut)
    || session.participants.find((p) => !rut && name && normalizeText(p.name) === name);
  const localAnswer = student.answers[studentAnswerKey(session.code, questionIndex)];
  if (localAnswer !== undefined) return localAnswer;
  return me?.answerMap?.[questionIndex];
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeRut(value) {
  return String(value || "").trim().toLowerCase().replace(/[^0-9k]/g, "");
}

function studentIdFromRut(rut) {
  const rutKey = normalizeRut(rut);
  return rutKey ? `rut-${rutKey}` : makeId();
}

function studentAnswerKey(code, questionIndex) {
  return `${student.id}:${code}:${questionIndex}`;
}

function renderStudentReview(session) {
  $("answerReview").classList.remove("hidden");
  $("answerReview").innerHTML = session.quizQuestions
    .map((question, idx) => {
      const chosen = studentAnswerFor(session, question.index);
      const selected = question.answers[chosen];
      const correct = [...question.answers].sort((a, b) => b.points - a.points)[0];
      return `
        <article class="review-item">
          <h3>${idx + 1}. ${escapeHtml(question.text.replace(/^\d+\.\s*/, ""))}</h3>
          <p>Tu respuesta: <strong>${selected ? escapeHtml(selected.text) : "Sin responder"}</strong>${selected ? ` · ${selected.points} pts` : ""}</p>
          <p>Respuesta de mayor puntaje: <strong>${escapeHtml(correct.text)}</strong> (${correct.points} pts)</p>
        </article>
      `;
    })
    .join("");
}

function renderAdmin(session) {
  $("currentQuestion").textContent = session.quizPublished
    ? `Cuestionario publicado: ${session.quizQuestions.length} preguntas. ${session.acceptingAnswers ? "Respuestas abiertas." : "Respuestas cerradas."}`
    : "Selecciona preguntas y publica el cuestionario.";
  $("toggleAnswers").textContent = session.acceptingAnswers ? "Cerrar respuestas" : "Abrir respuestas";
  $("toggleRanking").textContent = session.showRanking ? "Ocultar ranking" : "Mostrar ranking";
  $("rankingStatus").textContent = session.winnersPublished ? "Ganadores publicados" : session.showRanking ? "Ranking visible" : "Ranking oculto";
  $("adminElapsed").textContent = fmt(session.remainingSeconds ?? session.durationSeconds);
  if (document.activeElement !== $("expectedParticipants")) $("expectedParticipants").value = session.expectedParticipants || 0;
  if (session.showRanking && !session.winnersPublished) renderLeaderboard("leaderboard", session.participants);
  else $("leaderboard").innerHTML = "";
  $("podium").classList.toggle("hidden", !session.winnersPublished);
  if (session.winnersPublished) renderPodium("podium", session.participants);
  const selectedMatchesSession = $("sectionSelect").value === session.section?.id && $("bankSelect").value === session.bank?.id;
  if (selectedMatchesSession) {
    responseContext = session;
    renderResponses(session.participants || [], session);
  } else if (responseContext) {
    renderResponses(responseContext.participants || [], responseContext);
  }
}

function participationStats(session) {
  const participants = session.participants || [];
  const completed = participants.filter((p) => p.answeredCurrent).length;
  const inProgress = participants.filter((p) => p.answers > 0 && !p.answeredCurrent).length;
  const arrived = participants.length;
  const expected = Math.max(Number(session.expectedParticipants || 0), arrived);
  const pending = Math.max(0, expected - completed);
  const percent = expected ? Math.round((completed / expected) * 100) : 0;
  return { expected, arrived, completed, inProgress, pending, percent };
}

function renderParticipationStats(id, session) {
  const stats = participationStats(session);
  $(id).innerHTML = `
    <div>
      <span>Deben responder</span>
      <strong>${stats.expected}</strong>
    </div>
    <div>
      <span>Llegaron</span>
      <strong>${stats.arrived}</strong>
    </div>
    <div>
      <span>Completaron</span>
      <strong>${stats.completed}/${stats.expected}</strong>
    </div>
  `;
}

function renderProjection(session) {
  $("projectionCode").textContent = `Código ${session.code}`;
  $("projectionJoin").textContent = session.joinUrl;
  $("projectionQr").src = `${session.qrUrl}?t=${Math.floor(Date.now() / 30000)}`;
  $("projectionElapsed").textContent = session.timerStartedAt ? fmt(session.remainingSeconds) : fmt(session.durationSeconds);
  $("projectionQuestion").textContent = session.quizPublished
    ? session.acceptingAnswers
      ? `Cuestionario abierto con ${session.quizQuestions.length} preguntas. Escanea el QR para responder.`
      : `Código listo. El cuestionario se mostrará cuando el administrador abra respuestas.`
    : "Esperando que el administrador publique el cuestionario.";
  renderParticipationStats("projectionStats", session);
  $("projectionQuestion").classList.toggle("hidden", !session.acceptingAnswers);
  $("projectionQuestion").textContent = session.acceptingAnswers
    ? `Cuestionario abierto: ${session.quizQuestions.length} preguntas`
    : "";
  $("projectionRanking").classList.toggle("hidden", !session.showRanking || session.winnersPublished);
  if (session.showRanking && !session.winnersPublished) renderLeaderboard("projectionRanking", session.participants);
  $("projectionPodium").classList.toggle("hidden", !session.winnersPublished);
  if (session.winnersPublished) renderPodium("projectionPodium", session.participants);
}

function renderLeaderboard(id, participants) {
  $(id).innerHTML = participants.length
    ? participants
        .map(
          (p) => `
          <li>
            <span class="rank">${p.place}</span>
            <span>${escapeHtml(p.name)}${p.answeredCurrent ? " ✓" : ""}</span>
            <span class="score">${p.score} pts</span>
          </li>`
        )
        .join("")
    : "<li><span class='rank'>-</span><span>Esperando estudiantes</span><span class='score'>0 pts</span></li>";
}

function renderResponses(participants, context = activeSession) {
  const sectionLabel = activeSession?.section?.section || "Sin sección";
  const bankLabel = activeSession?.bank?.name || "Sin banco";
  const search = normalizeText($("responsesSearch")?.value || "");
  const stats = participationStats(activeSession || { participants });
  $("responsesSummary").innerHTML = `
    <span>Seccion: <strong>${escapeHtml(sectionLabel)}</strong></span>
    <span>Banco: <strong>${escapeHtml(bankLabel)}</strong></span>
    <span>Esperados: <strong>${stats.expected}</strong></span>
    <span>Llegaron: <strong>${stats.arrived}</strong></span>
    <span>Completaron: <strong>${stats.completed}</strong></span>
    <span>Pendientes: <strong>${stats.pending}</strong></span>
  `;
  const filtered = participants.filter((p) => {
    if (!search) return true;
    return normalizeText(`${p.name} ${p.rut}`).includes(search);
  });
  $("responsesList").innerHTML = filtered.length
    ? filtered
        .map(
          (p) => `
            <div class="response-row">
              <div>
                <strong>${escapeHtml(p.name)}</strong>
                <span>${escapeHtml(p.rut || "Sin RUT")} · ${escapeHtml(sectionLabel)} · ${escapeHtml(bankLabel)}</span>
                <span>${p.answers} respuestas · ${p.score} pts</span>
              </div>
              <button type="button" data-delete-student="${p.id}">Eliminar</button>
            </div>
          `
        )
        .join("")
    : "<p class='hint'>Aún no hay respuestas registradas en esta sección.</p>";
  if (!filtered.length) {
    $("responsesList").innerHTML = "<p class='hint'>No hay participantes para esa busqueda en esta seccion y banco.</p>";
  }
  document.querySelectorAll("[data-delete-student]").forEach((button) => {
    button.addEventListener("click", () => deleteStudent(button.dataset.deleteStudent));
  });
}

async function deleteStudent(studentId) {
  try {
    if (!activeSession) return;
    activeSession = await api(`/api/session/${activeSession.code}/student-delete`, {
      method: "POST",
      body: { studentId },
    });
    renderAdmin(activeSession);
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("currentQuestion").textContent = `No se pudo eliminar la respuesta: ${error.message}`;
  }
}

function renderResponses(participants, context = activeSession) {
  const sectionLabel = context?.section?.section || "Sin seccion";
  const bankLabel = context?.bank?.name || "Sin banco";
  const search = normalizeText($("responsesSearch")?.value || "");
  const stats = participationStats({ ...(context || {}), participants });
  $("responsesSummary").innerHTML = `
    <span>Seccion: <strong>${escapeHtml(sectionLabel)}</strong></span>
    <span>Banco: <strong>${escapeHtml(bankLabel)}</strong></span>
    <span>Esperados: <strong>${stats.expected}</strong></span>
    <span>Llegaron: <strong>${stats.arrived}</strong></span>
    <span>Completaron: <strong>${stats.completed}</strong></span>
    <span>Pendientes: <strong>${stats.pending}</strong></span>
  `;
  const filtered = participants.filter((p) => {
    if (!search) return true;
    return normalizeText(`${p.name} ${p.rut}`).includes(search);
  });
  $("responsesList").innerHTML = filtered.length
    ? filtered
        .map(
          (p) => `
            <div class="response-row">
              <div>
                <strong>${escapeHtml(p.name)}</strong>
                <span>${escapeHtml(p.rut || "Sin RUT")} - ${escapeHtml(sectionLabel)} - ${escapeHtml(bankLabel)}</span>
                <span>${p.answers} respuestas - ${p.score} pts</span>
              </div>
              <button type="button" data-delete-student="${p.id}">Eliminar</button>
            </div>
          `
        )
        .join("")
    : "<p class='hint'>No hay participantes para esa busqueda en esta seccion y banco.</p>";
  document.querySelectorAll("[data-delete-student]").forEach((button) => {
    button.addEventListener("click", () => deleteStudent(button.dataset.deleteStudent));
  });
}

async function deleteStudent(studentId) {
  try {
    const sectionId = $("sectionSelect").value;
    const bankId = $("bankSelect").value;
    if (!sectionId || !bankId) return;
    const result = await api("/api/responses/student-delete", {
      method: "POST",
      body: { sectionId, bankId, studentId },
    });
    responseContext = { ...selectedResponseContext(), participants: result.participants || [] };
    renderResponses(responseContext.participants, responseContext);
    if (activeSession?.section?.id === sectionId && activeSession?.bank?.id === bankId) {
      activeSession.participants = responseContext.participants;
      renderAdmin(activeSession);
    }
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("currentQuestion").textContent = `No se pudo eliminar la respuesta: ${error.message}`;
  }
}

function renderPodium(id, participants) {
  const top = participants.slice(0, 3);
  const ordered = [top[1], top[0], top[2]];
  const labels = ["2°", "1°", "3°"];
  $(id).innerHTML = ordered
    .map(
      (p, idx) => `
        <div class="podium-card">
          <span>${labels[idx]}</span>
          <strong>${p ? escapeHtml(p.name) : "Sin lugar"}</strong>
          <span>${p ? `${p.score} pts` : ""}</span>
        </div>
      `
    )
    .join("");
}

async function joinSession() {
  try {
  student.code = $("studentCode").value.trim().toUpperCase();
  student.name = $("studentName").value.trim();
  student.rut = $("studentRut").value.trim();
  if (!student.code) throw new Error("Ingresa el código.");
  if (!student.name) throw new Error("Ingresa tu nombre.");
  if (!normalizeRut(student.rut)) throw new Error("Ingresa tu RUT.");
  student.id = studentIdFromRut(student.rut);
  student.joined = true;
  localStorage.setItem("olimpiadasStudentId", student.id);
  localStorage.setItem("olimpiadasStudentName", student.name);
  localStorage.setItem("olimpiadasStudentRut", student.rut);
  $("joinBox").classList.add("hidden");
  $("answerBox").classList.remove("hidden");
  activeSession = await api(`/api/session/${student.code}`);
  renderStudentSession(activeSession);
  startRefresh();
  } catch (error) {
    $("answerBox").classList.remove("hidden");
    $("studentQuestion").textContent = "";
    $("quizQuestions").innerHTML = "";
    $("answerResult").textContent = error.message;
  }
}

function renderStudentSession(session) {
  if (!student.joined) return;
  student.name = $("studentName").value.trim() || student.name;
  student.rut = $("studentRut").value.trim() || student.rut;
  localStorage.setItem("olimpiadasStudentName", student.name);
  localStorage.setItem("olimpiadasStudentRut", student.rut);
  const me = session.participants.find((p) => p.id === student.id);
  $("studentStatus").textContent = `${session.section?.section || "Sección"} | ${session.bank?.name || ""}`;
  $("studentElapsed").textContent = session.timerStartedAt ? fmt(session.remainingSeconds) : fmt(session.durationSeconds);

  if (session.winnersPublished) {
    $("studentQuestion").textContent = "Resultados publicados";
    $("answerOptions").innerHTML = "";
    $("quizQuestions").innerHTML = "";
    $("finishQuiz").classList.add("hidden");
    renderStudentReview(session);
    $("answerResult").textContent = me
      ? `Terminaste en el lugar ${me.place} con ${me.score} puntos. Revisa tus respuestas abajo.`
      : "Se publicaron los resultados. No registramos una participación con este dispositivo.";
    return;
  }

  if (!session.quizPublished) {
    $("studentQuestion").textContent = "Espera a que el administrador publique el cuestionario.";
    $("answerOptions").innerHTML = "";
    $("quizQuestions").innerHTML = "";
    $("finishQuiz").classList.add("hidden");
    $("answerResult").textContent = me ? `Tiempo transcurrido: ${fmt(session.elapsedSeconds)}. Puntaje: ${me.score} pts.` : "";
    student.answeredQuestion = null;
    return;
  }

  $("studentQuestion").textContent = session.acceptingAnswers
    ? "Responde el cuestionario"
    : "El cuestionario está cerrado";
  $("answerOptions").innerHTML = "";
  if (!session.acceptingAnswers) {
    $("studentQuestion").textContent = "Espera a que el administrador abra las respuestas.";
    $("answerOptions").innerHTML = "";
    $("quizQuestions").innerHTML = "";
    $("finishQuiz").classList.add("hidden");
    $("answerResult").textContent = session.timerStartedAt
      ? `Tiempo restante: ${fmt(session.remainingSeconds)}.`
      : "El temporizador aún no se inicia.";
    return;
  }

  const visibleQuestions = session.studentQuestions.length ? session.studentQuestions : session.quizQuestions;
  if (!visibleQuestions.length) {
    $("studentQuestion").textContent = "Las respuestas estan abiertas, pero no hay preguntas publicadas para este codigo.";
    $("quizQuestions").innerHTML = "";
    $("finishQuiz").classList.add("hidden");
    $("answerResult").textContent = "Pide al administrador que guarde o publique la seleccion de preguntas.";
    return;
  }

  $("quizQuestions").innerHTML = visibleQuestions
    .map((question, idx) => {
      const chosen = studentAnswerFor(session, question.index);
      const answered = chosen !== undefined;
      return `
        <article class="student-question ${answered ? "answered" : ""}">
          <h3>${idx + 1}. ${escapeHtml(question.text.replace(/^\d+\.\s*/, ""))}</h3>
          <div class="answers">
            ${question.answers
              .map(
                (answer, answerIndex) => `
                  <button type="button" data-question-index="${question.index}" data-answer="${answerIndex}" ${!session.acceptingAnswers || answered ? "disabled" : ""}>
                    <span>${escapeHtml(answer.text)}</span>
                    ${answered && Number(chosen) === answerIndex ? " ✓" : ""}
                  </button>`
              )
              .join("")}
          </div>
        </article>
      `;
    })
    .join("");
  document.querySelectorAll("[data-answer]").forEach((button) => {
    button.addEventListener("click", () => answerQuestion(Number(button.dataset.questionIndex), Number(button.dataset.answer)));
  });
  if (!session.acceptingAnswers) {
    $("answerResult").textContent = "La pregunta está cerrada.";
  } else {
    $("answerResult").textContent = session.timerStartedAt
      ? `Tiempo restante: ${fmt(session.remainingSeconds)}.`
      : "El temporizador aún no se inicia.";
  }
  $("finishQuiz").classList.remove("hidden");
}

async function importWordQuestionnaire() {
  try {
    const file = $("wordUpload").files[0];
    if (!file) {
      $("selectionStatus").textContent = "Selecciona un archivo Word antes de cargar el banco.";
      return;
    }
    $("uploadWordButton").disabled = true;
    $("uploadWordButton").textContent = "Cargando...";
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
    $("selectionStatus").textContent = "Importando cuestionario Word...";
    const result = await api("/api/banks/import-word", {
      method: "POST",
      body: { filename: file.name, content: btoa(binary) },
    });
    appData.banks = result.allBanks;
    fillSelectors();
    $("bankSelect").value = result.banks[0].id;
    renderQuestions();
    renderUploadManager();
    $("wordUpload").value = "";
    $("uploadWordButton").textContent = "Cargar banco de preguntas";
    $("uploadWordButton").disabled = true;
    $("selectionStatus").textContent = `Word importado: ${result.banks[0].questions.length} preguntas.`;
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("uploadWordButton").textContent = "Cargar banco de preguntas";
    $("uploadWordButton").disabled = false;
    $("selectionStatus").textContent = `No se pudo importar Word: ${error.message}`;
  }
}

function handleWordFileSelection() {
  const file = $("wordUpload").files[0];
  $("uploadWordButton").disabled = !file;
  $("uploadWordButton").textContent = file ? "Cargar banco de preguntas" : "Cargar banco de preguntas";
  if (file) $("selectionStatus").textContent = `Archivo seleccionado: ${file.name}. Presiona cargar banco de preguntas.`;
}

async function answerQuestion(questionIndex, answerIndex) {
  try {
    document.querySelectorAll(`[data-question-index="${questionIndex}"]`).forEach((button) => (button.disabled = true));
    const result = await api(`/api/session/${student.code}/answer`, {
      method: "POST",
      body: { studentId: student.id, name: student.name, rut: student.rut, questionIndex, answerIndex },
    });
    student.id = result.studentId || student.id;
    localStorage.setItem("olimpiadasStudentId", student.id);
    student.answeredQuestion = questionIndex;
    student.answers[studentAnswerKey(student.code, questionIndex)] = answerIndex;
    localStorage.setItem("olimpiadasStudentAnswers", JSON.stringify(student.answers));
    $("answerResult").textContent = "Respuesta registrada. No se puede editar.";
    await refreshSession();
  } catch (error) {
    $("answerResult").textContent = error.message;
    await refreshSession();
  }
}

function finishQuiz() {
  if (!activeSession) return;
  renderStudentReview(activeSession);
  $("answerResult").textContent = "Respuestas publicadas para tu participación.";
  document.querySelectorAll("[data-answer]").forEach((button) => (button.disabled = true));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function downloadInterventionRecord() {
  let context = responseContext;
  const sectionId = $("sectionSelect")?.value || "";
  const bankId = $("bankSelect")?.value || "";

  if (sectionId && bankId) {
    try {
      context = await api(`/api/responses?sectionId=${encodeURIComponent(sectionId)}&bankId=${encodeURIComponent(bankId)}`);
      responseContext = context;
      renderResponses(context.participants || [], context);
    } catch (error) {
      if (requireFreshAdminLogin(error)) return;
      $("selectionStatus").textContent = `No se pudo cargar el filtro para el registro: ${error.message}`;
      return;
    }
  }

  if (!context && activeSession) context = activeSession;
  if (!context) {
    $("selectionStatus").textContent = "Selecciona una sección y un banco para generar el registro.";
    return;
  }

  const participants = context.participants || [];
  const stats = participationStats({ ...context, participants });
  const sectionLabel = context.section?.section || "Sin sección";
  const bankLabel = context.bank?.name || "Sin banco";
  const activeMatchesContext =
    activeSession?.section?.id === context.section?.id && activeSession?.bank?.id === context.bank?.id;
  const codeLabel = activeMatchesContext ? activeSession.code : "Registro por filtro";
  const now = new Date();
  const interventions = $("interventionLog").value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rows = participants
    .map(
      (p) => `
        <tr>
          <td>${p.place}</td>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.rut || "Sin RUT")}</td>
          <td>${p.answers}</td>
          <td>${p.score}</td>
        </tr>`
    )
    .join("");
  const interventionRows = interventions.length
    ? interventions
        .map((item, index) => {
          const done = /^\s*(\[x\]|x\b|ok\b|si\b|sí\b|cumplida\b)/i.test(item);
          return `<tr><td>${index + 1}</td><td>${done ? "Cumplida" : "Registrada"}</td><td>${escapeHtml(item)}</td></tr>`;
        })
        .join("")
    : "<tr><td colspan='3'>Sin intervenciones registradas.</td></tr>";
  const html = `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: Arial, sans-serif; color: #241139; }
          h1 { color: #5b21b6; }
          table { width: 100%; border-collapse: collapse; margin: 12px 0 22px; }
          th, td { border: 1px solid #ded1ef; padding: 7px; font-size: 11pt; }
          th { background: #f5f0ff; color: #4c1d95; }
          .meta p { margin: 4px 0; }
        </style>
      </head>
      <body>
        <h1>Registro de intervención - Olimpiadas Tecnológicas 2026</h1>
        <div class="meta">
          <p><strong>Fecha y hora:</strong> ${escapeHtml(now.toLocaleString("es-CL"))}</p>
          <p><strong>Sección:</strong> ${escapeHtml(sectionLabel)}</p>
          <p><strong>Banco de preguntas:</strong> ${escapeHtml(bankLabel)}</p>
          <p><strong>Código:</strong> ${escapeHtml(codeLabel)}</p>
          <p><strong>Esperados:</strong> ${stats.expected} | <strong>Llegaron:</strong> ${stats.arrived} | <strong>Completaron:</strong> ${stats.completed} | <strong>Pendientes:</strong> ${stats.pending}</p>
        </div>
        <h2>Cumplimiento de intervenciones</h2>
        <table>
          <thead><tr><th>N°</th><th>Estado</th><th>Intervención</th></tr></thead>
          <tbody>${interventionRows}</tbody>
        </table>
        <h2>Participantes y ranking</h2>
        <table>
          <thead><tr><th>Lugar</th><th>Nombre</th><th>RUT</th><th>Respuestas</th><th>Puntaje</th></tr></thead>
          <tbody>${rows || "<tr><td colspan='5'>Sin participantes registrados.</td></tr>"}</tbody>
        </table>
      </body>
    </html>`;
  const blob = new Blob(["\ufeff", html], { type: "application/msword;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const fileLabel = `${sectionLabel}-${bankLabel}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  link.download = `registro-${fileLabel || "filtro"}.doc`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function init() {
  try {
    if (location.protocol === "file:") {
      document.body.innerHTML = `
        <main class="shell">
          <section class="login-card">
            <p class="eyebrow">Olimpiadas</p>
            <h1>Abre la app desde el servidor</h1>
            <p class="hint">Este archivo no funciona abierto directo. Ejecuta iniciar_olimpiadas.bat y entra a http://127.0.0.1:8788/admin</p>
          </section>
        </main>
      `;
      return;
    }
    appData = await api("/api/data");
    fillSelectors();
    const path = location.pathname.toLowerCase();
    if (path.includes("estudiante")) showStudent();
    else if (path.includes("proyeccion")) await showProjection();
    else await showAdmin();

    $("loginButton").addEventListener("click", login);
    $("loginPass").addEventListener("keydown", (event) => {
      if (event.key === "Enter") login();
    });
    $("sectionSelect").addEventListener("change", loadResponsesForSelected);
    $("bankSelect").addEventListener("change", handleBankChange);
    $("expectedParticipants").addEventListener("change", updateExpectedParticipants);
    $("responsesSearch").addEventListener("input", () => {
      if (responseContext) renderResponses(responseContext.participants || [], responseContext);
      else if (activeSession) renderResponses(activeSession.participants || [], activeSession);
    });
    $("downloadRecord").addEventListener("click", downloadInterventionRecord);
    $("deleteBank").addEventListener("click", deleteCurrentBank);
    $("wordUpload").addEventListener("change", handleWordFileSelection);
    $("uploadWordButton").addEventListener("click", importWordQuestionnaire);
    $("createSession").addEventListener("click", createSession);
    $("publishQuiz").addEventListener("click", publishQuiz);
    $("toggleAnswers").addEventListener("click", toggleAnswers);
    $("toggleRanking").addEventListener("click", toggleRanking);
    $("publishWinners").addEventListener("click", publishWinners);
    $("joinSession").addEventListener("click", joinSession);
    $("finishQuiz").addEventListener("click", finishQuiz);
  } catch (error) {
    setView("studentView");
    $("pageTitle").textContent = "Cuestionario estudiantes";
    document.querySelector(".role-nav").classList.add("hidden");
    $("joinBox").classList.remove("hidden");
    $("answerBox").classList.remove("hidden");
    $("studentQuestion").textContent = "No se pudo cargar el cuestionario. Actualiza la página o pide un QR nuevo.";
    $("answerResult").textContent = error.message;
  }
}

init();
