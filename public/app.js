let appData = null;
let activeSession = null;
let refreshTimer = null;
let mode = "admin";
let responseContext = null;
let managedSessions = [];
let editingSectionId = "";
let editingBankId = "";
let adminQrVisible = false;
let projectionVideoObserver = null;

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

async function apiForm(path, formData) {
  const response = await fetch(path, {
    method: "POST",
    headers: authHeaders(),
    body: formData,
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
  updateNavVisibility();
  closeProfileMenu();
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

function closeProfileMenu() {
  $("roleNav")?.classList.add("hidden");
  $("menuButton")?.setAttribute("aria-expanded", "false");
}

function toggleProfileMenu() {
  const nav = $("roleNav");
  const button = $("menuButton");
  if (!nav || !button) return;
  const willOpen = nav.classList.contains("hidden");
  nav.classList.toggle("hidden", !willOpen);
  button.setAttribute("aria-expanded", String(willOpen));
}

function updateNavVisibility() {
  const isAdmin = currentAuth("admin")?.role === "admin";
  $("navProjection")?.classList.toggle("hidden", !isAdmin);
}

function fmt(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function sectionLabel(item) {
  return `${item.section} | ${item.subject} | ${item.teacher || "Sin docente"}`;
}

function selectedSection() {
  return appData.sections.find((item) => item.id === $("sectionSelect")?.value);
}

function groupedByArea(items, areaGetter) {
  return items.reduce((groups, item) => {
    const area = areaGetter(item) || "Sin área";
    if (!groups[area]) groups[area] = [];
    groups[area].push(item);
    return groups;
  }, {});
}

function fillSectionSelector() {
  const current = $("sectionSelect")?.value || "";
  const search = normalizeText($("sectionSearch")?.value || "");
  const sections = appData.sections.filter((item) => {
    if (!search) return true;
    return normalizeText(`${item.code} ${item.section} ${item.subject} ${item.teacher} ${item.career} ${item.area}`).includes(search);
  });
  $("sectionSelect").innerHTML = sections
    .map((item) => {
      return `<option value="${item.id}">${escapeHtml(sectionLabel(item))}</option>`;
    })
    .join("");
  if (sections.some((item) => item.id === current)) $("sectionSelect").value = current;
  updateSectionEditor();
}

function fillSelectors() {
  fillSectionSelector();
  const bankGroups = groupedByArea(appData.banks, (item) => item.area);
  $("bankSelect").innerHTML = Object.entries(bankGroups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([area, banks]) => `
        <optgroup label="${escapeHtml(area)}">
          ${banks
            .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`)
            .join("")}
        </optgroup>`
    )
    .join("");
  updateBankEditor();
  renderQuestions();
  renderUploadManager();
}

function updateSectionEditor(clear = false) {
  const section = clear ? null : selectedSection();
  editingSectionId = section?.id || "";
  $("sectionCode").value = section?.code || "";
  $("sectionName").value = section?.section || "";
  $("sectionSubject").value = section?.subject || "";
  $("sectionTeacher").value = section?.teacher || "";
  $("sectionCareer").value = section?.career || "";
  $("sectionArea").value = section?.area || "";
  $("sectionDate").value = section?.date || "";
}

function sectionFormPayload() {
  return {
    id: editingSectionId,
    code: $("sectionCode").value,
    section: $("sectionName").value,
    subject: $("sectionSubject").value,
    teacher: $("sectionTeacher").value,
    career: $("sectionCareer").value,
    area: $("sectionArea").value,
    date: $("sectionDate").value,
  };
}

function selectedBank() {
  return appData.banks.find((item) => item.id === $("bankSelect").value);
}

function syncChallengeFromBank(force = false) {
  const bank = selectedBank();
  if (!bank?.challengeText) return;
  const field = $("challengeText");
  if (force || !field.value.trim()) {
    field.value = bank.challengeText;
  }
}

function updateBankEditor() {
  const bank = selectedBank();
  editingBankId = bank?.id || "";
  $("bankNameInput").value = bank?.name || "";
  $("bankAreaInput").value = bank?.area || "";
  $("bankSubjectInput").value = bank?.subject || "";
  $("bankCareerInput").value = bank?.career || "";
}

function clearBankEditor() {
  editingBankId = "";
  $("bankNameInput").value = "";
  $("bankAreaInput").value = "";
  $("bankSubjectInput").value = "";
  $("bankCareerInput").value = "";
  $("challengeText").value = "";
  $("selectionStatus").textContent = "Completa el nombre, área y descripción para crear un banco nuevo.";
}

function renderQuestions() {
  const bank = selectedBank();
  if (!bank) {
    $("questionList").innerHTML = "<p class='hint'>Crea o selecciona un banco de preguntas.</p>";
    return;
  }
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

async function saveSection() {
  try {
    const payload = sectionFormPayload();
    if (!payload.section || !payload.subject) throw new Error("Ingresa sección y asignatura.");
    const result = await api("/api/sections", { method: "POST", body: payload });
    appData.sections = result.sections;
    $("sectionSearch").value = "";
    fillSectionSelector();
    const saved = appData.sections.find((item) =>
      item.section === payload.section && item.subject === payload.subject && item.teacher === payload.teacher
    ) || appData.sections[appData.sections.length - 1];
    if (saved) $("sectionSelect").value = saved.id;
    updateSectionEditor();
    $("sectionStatus").textContent = "Sección guardada.";
    await loadManagedSessions();
    await loadResponsesForSelected();
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("sectionStatus").textContent = `No se pudo guardar: ${error.message}`;
  }
}

async function deleteCurrentSection() {
  try {
    const section = selectedSection();
    if (!section) return;
    if (!confirm(`Eliminar sección ${section.section}? Solo se permite si no tiene formularios ni respuestas.`)) return;
    const result = await api(`/api/sections/${encodeURIComponent(section.id)}`, { method: "DELETE" });
    appData.sections = result.sections;
    fillSectionSelector();
    $("sectionStatus").textContent = "Sección eliminada.";
    await loadResponsesForSelected();
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("sectionStatus").textContent = `No se pudo eliminar: ${error.message}`;
  }
}

async function loadManagedSessions() {
  if (!appData || mode !== "admin") return;
  try {
    const result = await api("/api/sessions");
    managedSessions = result.sessions || [];
    renderSessionManager();
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("sessionManager").innerHTML = `<p class="hint">No se pudieron cargar formularios: ${escapeHtml(error.message)}</p>`;
  }
}

function sessionStateLabel(session) {
  if (session.winnersPublished) return "Ganadores publicados";
  if (session.acceptingAnswers) return "Abierto";
  if (session.quizPublished) return "Cerrado / listo";
  return "Borrador";
}

function renderSessionManager() {
  const currentSectionId = $("sectionSelect")?.value || "";
  const currentBankId = $("bankSelect")?.value || "";
  const selected = managedSessions.filter((session) => {
    const sectionMatch = !currentSectionId || session.section?.id === currentSectionId;
    const bankMatch = !currentBankId || session.bank?.id === currentBankId;
    return sectionMatch && bankMatch;
  });
  const visible = selected;
  const rowFor = (session) => {
    const isActive = activeSession?.code === session.code;
    const created = session.createdAt ? new Date(session.createdAt).toLocaleString("es-CL") : "Sin fecha";
    return `
      <div class="session-row ${isActive ? "active" : ""}">
        <div>
          <strong>${escapeHtml(session.code)}</strong>
          <span>${escapeHtml(session.section?.section || "Sin sección")} - ${escapeHtml(session.bank?.name || "Sin banco")}</span>
          ${session.challengeText ? `<span>${escapeHtml(session.challengeText)}</span>` : ""}
          <span>${sessionStateLabel(session)} - ${fmt(session.remainingSeconds ?? session.durationSeconds)} - ${created}</span>
        </div>
        <div class="session-actions">
          <button type="button" data-load-session="${session.code}">Usar</button>
          <a class="button-link small" href="/proyeccion?code=${session.code}" target="_blank">Proyectar</a>
          <button type="button" data-delete-session="${session.code}">Eliminar</button>
        </div>
      </div>
    `;
  };
  if (!visible.length) {
    $("sessionManager").innerHTML = "<p class='hint'>Aún no hay formularios creados.</p>";
  } else {
    const groups = groupedByArea(visible, (session) => session.bank?.area || session.section?.area);
    $("sessionManager").innerHTML = Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([area, sessions]) => `
          <details class="area-group" open>
            <summary>${escapeHtml(area)} <span>${sessions.length} formulario${sessions.length === 1 ? "" : "s"}</span></summary>
            <div class="area-group-body">${sessions.map(rowFor).join("")}</div>
          </details>`
      )
      .join("");
  }
  document.querySelectorAll("[data-load-session]").forEach((button) => {
    button.addEventListener("click", () => loadSessionByCode(button.dataset.loadSession));
  });
  document.querySelectorAll("[data-delete-session]").forEach((button) => {
    button.addEventListener("click", () => deleteSessionByCode(button.dataset.deleteSession));
  });
}

function syncManagedSession(session) {
  if (!session?.code || mode !== "admin") return;
  const index = managedSessions.findIndex((item) => item.code === session.code);
  if (index >= 0) managedSessions[index] = session;
  else managedSessions.unshift(session);
  renderSessionManager();
}

async function loadSessionByCode(code) {
  try {
    activeSession = await api(`/api/session/${code}`);
    localStorage.setItem("olimpiadasEvaluatorCode", activeSession.code);
    restoreSessionSelectors();
    showSessionInvite(activeSession, { resetQr: true });
    renderAdmin(activeSession);
    await loadManagedSessions();
    startRefresh();
    await loadResponsesForSelected();
    renderSessionManager();
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("selectionStatus").textContent = `No se pudo abrir el formulario: ${error.message}`;
  }
}

async function deleteSessionByCode(code) {
  try {
    if (!confirm(`Eliminar formulario/código ${code}? Las respuestas guardadas por sección y banco se conservan.`)) return;
    await api(`/api/session/${code}`, { method: "DELETE" });
    if (activeSession?.code === code) {
      activeSession = null;
      localStorage.removeItem("olimpiadasEvaluatorCode");
      $("sessionCard").classList.add("hidden");
      clearInterval(refreshTimer);
      renderAdmin({
        quizPublished: false,
        quizQuestions: [],
        acceptingAnswers: false,
        winnersPublished: false,
        participants: [],
        elapsedSeconds: 0,
        durationSeconds: Number($("durationMinutes").value || 10) * 60,
      });
    }
    $("selectionStatus").textContent = `Formulario ${code} eliminado.`;
    await loadManagedSessions();
    await loadResponsesForSelected();
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("selectionStatus").textContent = `No se pudo eliminar el formulario: ${error.message}`;
  }
}

function handleBankChange() {
  updateBankEditor();
  syncChallengeFromBank(true);
  renderQuestions();
  loadResponsesForSelected();
  renderSessionManager();
}

async function deleteCurrentBank() {
  await deleteBankById($("bankSelect").value);
}

async function deleteBankById(bankId) {
  try {
    const bank = appData.banks.find((item) => item.id === bankId);
    if (!bank) return;
    if (!confirm(`Eliminar banco de preguntas: ${bank.name}?`)) return;
    let result;
    try {
      result = await api(`/api/banks/${encodeURIComponent(bank.id)}`, { method: "DELETE" });
    } catch (error) {
      if (error.status !== 409) throw error;
      const force = confirm("Este banco está usado por una sesión activa. Si lo eliminas, esa sesión se cerrará. ¿Deseas continuar?");
      if (!force) return;
      result = await api(`/api/banks/${encodeURIComponent(bank.id)}?force=1`, { method: "DELETE" });
    }
    appData.banks = result.banks;
    fillSelectors();
    await loadManagedSessions();
    if (activeSession?.bank?.id === bank.id || result.removedSessions) {
      activeSession = null;
      localStorage.removeItem("olimpiadasEvaluatorCode");
      $("sessionCard").classList.add("hidden");
      clearInterval(refreshTimer);
    }
    $("selectionStatus").textContent = result.uploadDeleted
      ? "Banco de preguntas y archivo Word eliminados."
      : "Banco de preguntas eliminado.";
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("selectionStatus").textContent = `No se pudo eliminar el banco: ${error.message}`;
  }
}

async function saveBank() {
  try {
    const result = await api("/api/banks", {
      method: "POST",
      body: {
        id: editingBankId,
        name: $("bankNameInput").value.trim(),
        area: $("bankAreaInput").value.trim(),
        subject: $("bankSubjectInput").value.trim(),
        career: $("bankCareerInput").value.trim(),
        challengeText: $("challengeText").value.trim(),
      },
    });
    const previousId = editingBankId;
    appData.banks = result.banks;
    fillSelectors();
    const saved = previousId
      ? appData.banks.find((item) => item.id === previousId)
      : appData.banks[appData.banks.length - 1];
    if (saved) $("bankSelect").value = saved.id;
    updateBankEditor();
    syncChallengeFromBank(true);
    renderQuestions();
    $("selectionStatus").textContent = "Banco de preguntas guardado.";
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("selectionStatus").textContent = `No se pudo guardar el banco: ${error.message}`;
  }
}

async function addQuestionToBank() {
  try {
    const bank = selectedBank();
    if (!bank) throw new Error("Selecciona o crea un banco de preguntas.");
    const answers = [
      { points: 100, text: $("answerText100").value.trim() },
      { points: 75, text: $("answerText75").value.trim() },
      { points: 50, text: $("answerText50").value.trim() },
      { points: 25, text: $("answerText25").value.trim() },
    ].filter((answer) => answer.text);
    const result = await api(`/api/banks/${encodeURIComponent(bank.id)}/questions`, {
      method: "POST",
      body: { text: $("newQuestionText").value.trim(), answers },
    });
    appData.banks = result.banks;
    fillSelectors();
    $("bankSelect").value = result.bank.id;
    updateBankEditor();
    renderQuestions();
    ["newQuestionText", "answerText100", "answerText75", "answerText50", "answerText25"].forEach((id) => ($(id).value = ""));
    $("selectionStatus").textContent = "Pregunta agregada al banco seleccionado.";
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("selectionStatus").textContent = `No se pudo agregar la pregunta: ${error.message}`;
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
              <span>${escapeHtml(bank.name)} · ${bank.questions.length} preguntas${bank.upload?.url ? ` · <a href="${escapeHtml(bank.upload.url)}" target="_blank" rel="noopener">archivo</a>` : ""}</span>
              <button type="button" data-use-upload="${bank.id}">Usar</button>
              <button type="button" data-delete-upload="${bank.id}">Eliminar</button>
            </div>
          `
        )
        .join("")}
    `
    : "<p class='hint'>Aún no hay cuestionarios Word cargados.</p>";
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
    challengeText: $("challengeText").value.trim(),
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
    updateNavVisibility();
    if (result.role === "admin") showAdmin();
    if (result.role === "projection") showProjection();
  } catch (error) {
    $("loginHint").textContent = error.message;
  }
}

function logoutAdmin() {
  localStorage.removeItem(authKey("admin"));
  localStorage.removeItem("olimpiadasAuth");
  clearInterval(refreshTimer);
  activeSession = null;
  responseContext = null;
  $("loginUser").value = "";
  $("loginPass").value = "";
  $("loginTitle").textContent = "Cuenta administradora";
  $("loginHint").textContent = "Sesión cerrada.";
  updateNavVisibility();
  closeProfileMenu();
  setRoleLabel("Administrador");
  setView("loginView");
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
  document.querySelector(".menu-container")?.classList.remove("hidden");
  $("pageTitle").textContent = "Panel administrador";
  updateNavVisibility();
  closeProfileMenu();
  setRoleLabel("Administrador");
  setView("adminView");
  updateProjectionVideoStatus();
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
  await loadManagedSessions();
  loadResponsesForSelected();
}

async function showProjection() {
  mode = "projection";
  document.querySelector(".menu-container")?.classList.remove("hidden");
  $("pageTitle").textContent = "Olimpiadas Tecnológicas 2026";
  setRoleLabel("Proyección");
  setView("projectionView");
  const code = new URLSearchParams(location.search).get("code") || localStorage.getItem("olimpiadasEvaluatorCode");
  if (code) {
    activeSession = await api(`/api/session/${code.toUpperCase()}`);
    renderProjection(activeSession);
    startRefresh();
  } else {
    try {
      activeSession = await api("/api/session/latest");
      renderProjection(activeSession);
      startRefresh();
    } catch {
      renderProjectionVideo(appData?.projectionVideo);
      $("projectionQuestion").textContent = "Abre esta pantalla desde el enlace que entrega el administrador.";
    }
  }
}

function showStudent() {
  mode = "student";
  document.querySelector(".menu-container")?.classList.remove("hidden");
  $("pageTitle").textContent = "Cuestionario estudiantes";
  setRoleLabel("Estudiante");
  setView("studentView");
  const code = new URLSearchParams(location.search).get("code");
  $("studentName").value = code ? "" : student.name;
  $("studentRut").value = code ? "" : student.rut;
  if (code) {
    document.querySelector(".menu-container")?.classList.add("hidden");
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
  $("challengeText").value = activeSession?.challengeText || "";
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
        challengeText: draft.challengeText,
      },
    });
    localStorage.setItem("olimpiadasEvaluatorCode", activeSession.code);
    showSessionInvite(activeSession);
    activeSession = await api(`/api/session/${activeSession.code}/publish`, {
      method: "POST",
      body: { selectedQuestions: draft.selectedQuestions, durationSeconds: draft.durationSeconds, expectedParticipants: draft.expectedParticipants, challengeText: draft.challengeText },
    });
    $("selectionStatus").textContent = `Código ${activeSession.code} generado. Puedes mostrar u ocultar el QR cuando lo necesites.`;
    renderAdmin(activeSession);
    await loadManagedSessions();
    startRefresh();
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("selectionStatus").textContent = `No se pudo generar el QR: ${error.message}`;
  } finally {
    $("createSession").disabled = false;
  }
}

function setAdminQrVisibility(visible, session = activeSession) {
  adminQrVisible = Boolean(visible);
  $("qrPanel").classList.toggle("hidden", !adminQrVisible);
  $("toggleQrVisibility").textContent = adminQrVisible ? "Ocultar QR" : "Mostrar QR";
  $("toggleQrVisibility").setAttribute("aria-expanded", String(adminQrVisible));
  if (adminQrVisible && session?.qrUrl) $("qrImage").src = `${session.qrUrl}?t=${Date.now()}`;
}

function showSessionInvite(session, options = {}) {
  if (session && session.inviteVisible === false) {
    $("sessionCard").classList.add("hidden");
    adminQrVisible = false;
    return;
  }
  $("sessionCard").classList.remove("hidden");
  $("sessionCode").textContent = session.code;
  $("joinUrl").textContent = session.joinUrl;
  $("projectionLink").href = `/proyeccion?code=${session.code}`;
  const codeChanged = $("qrImage").dataset.code !== session.code;
  $("qrImage").dataset.code = session.code;
  if (options.resetQr || codeChanged) {
    adminQrVisible = false;
    $("qrImage").removeAttribute("src");
  }
  $("qrImage").alt = "Generando QR para estudiantes";
  $("qrImage").onload = () => {
    $("qrImage").alt = `QR listo para el código ${session.code}`;
  };
  $("qrImage").onerror = () => {
    $("qrImage").alt = "No se pudo cargar el QR. Usa el código o el enlace mostrado.";
    $("selectionStatus").textContent = `Código ${session.code} generado. Si el QR no aparece, usa el enlace: ${session.joinUrl}`;
  };
  setAdminQrVisibility(adminQrVisible, session);
}

function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshSession, 1000);
}

async function refreshSession() {
  if (!activeSession?.code) return;
  try {
    activeSession = await api(`/api/session/${activeSession.code}`);
    if (mode === "admin") {
      renderAdmin(activeSession);
      syncManagedSession(activeSession);
    }
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
    syncManagedSession(activeSession);
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("currentQuestion").textContent = `No se pudo publicar la pregunta: ${error.message}`;
  }
}

async function publishQuiz() {
  try {
    const selectedQuestions = selectedQuestionValues();
    draftSelection = { ...(draftSelection || currentDraft()), selectedQuestions };
    localStorage.setItem("olimpiadasDraftSelection", JSON.stringify(draftSelection));
    $("selectionStatus").textContent = `Selección guardada: ${selectedQuestions.length} preguntas. No se modificó la configuración del formulario.`;
    if (!activeSession) {
      return;
    }
    await updateExpectedParticipants({ silent: true });
    activeSession = await api(`/api/session/${activeSession.code}/publish`, {
      method: "POST",
      body: { selectedQuestions },
    });
    renderAdmin(activeSession);
    syncManagedSession(activeSession);
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
  syncManagedSession(activeSession);
}

async function startTimer() {
  if (!activeSession) return;
  activeSession = await api(`/api/session/${activeSession.code}/timer`, {
    method: "POST",
    body: { start: true },
  });
  renderAdmin(activeSession);
  syncManagedSession(activeSession);
}

async function updateExpectedParticipants(options = {}) {
  if (!activeSession?.code) return;
  try {
    activeSession = await api(`/api/session/${activeSession.code}/settings`, {
      method: "POST",
      body: { expectedParticipants: Number($("expectedParticipants").value || 0), challengeText: $("challengeText").value.trim() },
    });
    if (!options.silent) {
      renderAdmin(activeSession);
      syncManagedSession(activeSession);
    }
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
    syncManagedSession(activeSession);
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
        challengeText: $("challengeText").value.trim(),
        ...(opening ? { durationSeconds: Number($("durationMinutes").value || 10) * 60 } : {}),
      },
    });
    renderAdmin(activeSession);
    syncManagedSession(activeSession);
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
    syncManagedSession(activeSession);
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
  if (session.expectedParticipants !== undefined && document.activeElement !== $("expectedParticipants")) $("expectedParticipants").value = session.expectedParticipants || 0;
  if (document.activeElement !== $("challengeText")) $("challengeText").value = session.challengeText || "";
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

function renderParticipationRank(id, session) {
  const participants = [...(session.participants || [])]
    .sort((a, b) => (b.answers || 0) - (a.answers || 0) || String(a.name || "").localeCompare(String(b.name || "")))
    .slice(0, 8);
  $(id).innerHTML = `
    <h3>Participación en vivo</h3>
    ${
      participants.length
        ? participants
            .map(
              (p, index) => `
                <div class="participation-rank-row">
                  <strong>${index + 1}</strong>
                  <span>${escapeHtml(p.name || "Participante")}</span>
                  <em>${p.answers || 0} respuestas</em>
                </div>
              `
            )
            .join("")
        : "<p>Esperando participantes...</p>"
    }
  `;
}

function renderProjection(session) {
  const inviteVisible = session.inviteVisible !== false;
  const finished = session.winnersPublished || (session.quizPublished && !session.acceptingAnswers && Number(session.remainingSeconds || 0) <= 0);
  renderProjectionVideo(session.projectionVideo || appData?.projectionVideo);
  $("projectionCode").textContent = inviteVisible ? `Código ${session.code}` : "Sin código activo";
  $("projectionJoin").textContent = inviteVisible ? session.joinUrl : "La competencia anterior ya fue cerrada.";
  $("projectionQr").classList.toggle("hidden", !inviteVisible);
  if (inviteVisible) $("projectionQr").src = `${session.qrUrl}?t=${Math.floor(Date.now() / 30000)}`;
  $("projectionTotalParticipants").textContent = String((session.globalParticipants || []).length);
  $("projectionElapsed").textContent = !inviteVisible ? "Sin actividad" : finished ? "Finalizado" : session.timerStartedAt ? fmt(session.remainingSeconds) : fmt(session.durationSeconds);
  $("projectionQuestion").textContent = session.quizPublished
    ? session.acceptingAnswers
      ? `Cuestionario abierto con ${session.quizQuestions.length} preguntas. Escanea el QR para responder.`
      : "Esperando apertura de respuestas."
    : inviteVisible
      ? "Esperando que el administrador publique el cuestionario."
      : "No hay competencia activa en este momento.";
  $("projectionStats").classList.toggle("hidden", !inviteVisible || finished);
  if (inviteVisible && !finished) renderParticipationStats("projectionStats", session);
  else $("projectionStats").innerHTML = "";
  $("projectionChallenge").classList.toggle("hidden", !session.challengeText || !inviteVisible);
  $("projectionChallenge").innerHTML = session.challengeText && inviteVisible
    ? `<strong>Desafío</strong><span>${escapeHtml(session.challengeText)}</span>`
    : "";
  renderParticipationRank("projectionParticipationRank", session);
  document.querySelector(".projection-side")?.classList.toggle("winners-mode", Boolean(session.winnersPublished));
  $("projectionParticipationRank").classList.toggle("hidden", Boolean(session.winnersPublished) || !inviteVisible);
  $("projectionQuestion").classList.toggle("hidden", false);
  $("projectionRanking").classList.toggle("hidden", !session.showRanking || session.winnersPublished || !inviteVisible);
  if (session.showRanking && !session.winnersPublished && inviteVisible) renderLeaderboard("projectionRanking", session.participants);
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
    $("responsesList").innerHTML = "<p class='hint'>No hay participantes para esa búsqueda en esta sección y banco.</p>";
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
  const sectionLabel = context?.section?.section || "Sin sección";
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
    : "<p class='hint'>No hay participantes para esa búsqueda en esta sección y banco.</p>";
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
          <span class="podium-place">${labels[idx]}</span>
          <strong class="podium-name">${p ? escapeHtml(p.name) : "Sin lugar"}</strong>
          <span class="podium-score">${p ? `${p.score} pts` : ""}</span>
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
  $("studentChallenge").classList.toggle("hidden", !session.challengeText);
  $("studentChallenge").textContent = session.challengeText || "";

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
    $("studentQuestion").textContent = "Las respuestas están abiertas, pero no hay preguntas publicadas para este código.";
    $("quizQuestions").innerHTML = "";
    $("finishQuiz").classList.add("hidden");
    $("answerResult").textContent = "Pide al administrador que guarde o publique la selección de preguntas.";
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
              .map((answer, answerIndex) => {
                const originalIndex = Number.isInteger(answer.originalIndex) ? answer.originalIndex : answerIndex;
                return `
                  <button type="button" data-question-index="${question.index}" data-answer="${originalIndex}" ${!session.acceptingAnswers || answered ? "disabled" : ""}>
                    <span>${escapeHtml(answer.text)}</span>
                    ${answered && Number(chosen) === originalIndex ? " ✓" : ""}
                  </button>`;
              })
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
    $("selectionStatus").textContent = "Importando cuestionario Word...";
    const formData = new FormData();
    formData.append("questionnaire", file);
    const result = await apiForm("/api/banks/import-word", formData);
    appData.banks = result.allBanks;
    fillSelectors();
    $("bankSelect").value = result.banks[0].id;
    updateBankEditor();
    syncChallengeFromBank(true);
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

function updateProjectionVideoStatus(video = appData?.projectionVideo) {
  const status = $("projectionVideoStatus");
  if (!status) return;
  status.textContent = video?.url
    ? `Video cargado: ${video.originalName || video.filename || "video de proyección"}`
    : "Aún no hay video cargado para proyección.";
}

function handleProjectionVideoSelection() {
  const file = $("projectionVideoUpload")?.files?.[0];
  $("uploadProjectionVideo").disabled = !file;
  if (file) $("projectionVideoStatus").textContent = `Archivo seleccionado: ${file.name}. Presiona cargar video de proyección.`;
}

async function uploadProjectionVideo() {
  try {
    const file = $("projectionVideoUpload").files[0];
    if (!file) {
      updateProjectionVideoStatus();
      return;
    }
    $("uploadProjectionVideo").disabled = true;
    $("uploadProjectionVideo").textContent = "Cargando video...";
    const formData = new FormData();
    formData.append("projectionVideo", file);
    const result = await apiForm("/api/projection-video", formData);
    appData.projectionVideo = result.projectionVideo;
    $("projectionVideoUpload").value = "";
    $("uploadProjectionVideo").textContent = "Cargar video de proyección";
    updateProjectionVideoStatus(appData.projectionVideo);
  } catch (error) {
    if (requireFreshAdminLogin(error)) return;
    $("uploadProjectionVideo").textContent = "Cargar video de proyección";
    $("uploadProjectionVideo").disabled = false;
    $("projectionVideoStatus").textContent = `No se pudo cargar el video: ${error.message}`;
  }
}

function renderProjectionVideo(video) {
  const player = $("projectionVideo");
  const placeholder = $("projectionVideoPlaceholder");
  const playButton = $("playProjectionVideo");
  if (!player || !placeholder) return;
  const url = video?.url || "";
  player.classList.toggle("hidden", !url);
  placeholder.classList.toggle("hidden", Boolean(url));
  playButton?.classList.toggle("hidden", !url);
  player.muted = true;
  player.autoplay = true;
  player.loop = true;
  player.playsInline = true;
  if (url && player.dataset.src !== url) {
    player.dataset.src = url;
    player.src = url;
    player.load();
  }
  if (url) requestAnimationFrame(() => player.play().catch(() => {}));
  ensureProjectionVideoAutoplay();
}

function playProjectionVideo() {
  const player = $("projectionVideo");
  if (!player?.src) return;
  player.muted = false;
  player.controls = true;
  player.play().catch(() => {});
}

function ensureProjectionVideoAutoplay() {
  const player = $("projectionVideo");
  if (!player || projectionVideoObserver || !("IntersectionObserver" in window)) return;
  projectionVideoObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.45 && player.src) {
          player.muted = true;
          player.play().catch(() => {});
        } else if (!entry.isIntersecting) {
          player.pause();
        }
      });
    },
    { threshold: [0, 0.45, 0.75] }
  );
  projectionVideoObserver.observe(player);
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
    syncChallengeFromBank(false);
    updateNavVisibility();
    const path = location.pathname.toLowerCase();
    if (path.includes("estudiante")) showStudent();
    else if (path.includes("proyeccion")) await showProjection();
    else await showAdmin();

    $("loginButton").addEventListener("click", login);
    $("logoutAdmin").addEventListener("click", logoutAdmin);
    $("loginPass").addEventListener("keydown", (event) => {
      if (event.key === "Enter") login();
    });
    $("menuButton")?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleProfileMenu();
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".menu-container")) closeProfileMenu();
    });
    $("sectionSearch").addEventListener("input", () => {
      fillSectionSelector();
      loadResponsesForSelected();
      renderSessionManager();
    });
    $("sectionSelect").addEventListener("change", () => {
      updateSectionEditor();
      loadResponsesForSelected();
      renderSessionManager();
    });
    $("saveSection").addEventListener("click", saveSection);
    $("newSection").addEventListener("click", () => {
      updateSectionEditor(true);
      $("sectionStatus").textContent = "Completa los datos y guarda una nueva sección.";
    });
    $("deleteSection").addEventListener("click", deleteCurrentSection);
    $("bankSelect").addEventListener("change", handleBankChange);
    $("expectedParticipants").addEventListener("change", updateExpectedParticipants);
    $("responsesSearch").addEventListener("input", () => {
      if (responseContext) renderResponses(responseContext.participants || [], responseContext);
      else if (activeSession) renderResponses(activeSession.participants || [], activeSession);
    });
    $("downloadRecord").addEventListener("click", downloadInterventionRecord);
    $("newBank").addEventListener("click", clearBankEditor);
    $("saveBank").addEventListener("click", saveBank);
    $("addQuestion").addEventListener("click", addQuestionToBank);
    $("deleteBank").addEventListener("click", deleteCurrentBank);
    $("wordUpload").addEventListener("change", handleWordFileSelection);
    $("uploadWordButton").addEventListener("click", importWordQuestionnaire);
    $("projectionVideoUpload").addEventListener("change", handleProjectionVideoSelection);
    $("uploadProjectionVideo").addEventListener("click", uploadProjectionVideo);
    $("playProjectionVideo")?.addEventListener("click", playProjectionVideo);
    $("projectionVideo")?.addEventListener("canplay", () => {
      if (mode === "projection") {
        $("projectionVideo").muted = true;
        $("projectionVideo").play().catch(() => {});
      }
    });
    $("createSession").addEventListener("click", createSession);
    $("toggleQrVisibility").addEventListener("click", () => setAdminQrVisibility(!adminQrVisible, activeSession));
    $("publishQuiz").addEventListener("click", publishQuiz);
    $("toggleAnswers").addEventListener("click", toggleAnswers);
    $("toggleRanking").addEventListener("click", toggleRanking);
    $("publishWinners").addEventListener("click", publishWinners);
    $("joinSession").addEventListener("click", joinSession);
    $("finishQuiz").addEventListener("click", finishQuiz);
  } catch (error) {
    setView("studentView");
    $("pageTitle").textContent = "Cuestionario estudiantes";
    document.querySelector(".menu-container")?.classList.add("hidden");
    $("joinBox").classList.remove("hidden");
    $("answerBox").classList.remove("hidden");
    $("studentQuestion").textContent = "No se pudo cargar el cuestionario. Actualiza la página o pide un QR nuevo.";
    $("answerResult").textContent = error.message;
  }
}

init();
