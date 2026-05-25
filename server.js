const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const childProcess = require("child_process");
const QRCode = require("qrcode");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_PATH = process.env.DATA_PATH || path.join(ROOT, "data.json");
const data = loadData();
const sessions = new Map();
const RESPONSES_DB = process.env.RESPONSES_DB_PATH || path.join(ROOT, "responses-db.json");
const responseStore = loadResponseStore();
const accounts = {
  administrador: { password: "admin123", role: "admin", name: "Administrador" },
  proyeccion: { password: "curso123", role: "projection", name: "Proyeccion" },
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
  }
}

function saveData() {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

function loadResponseStore() {
  try {
    return JSON.parse(fs.readFileSync(RESPONSES_DB, "utf8"));
  } catch {
    return {};
  }
}

function saveResponseStore() {
  fs.writeFileSync(RESPONSES_DB, JSON.stringify(responseStore, null, 2), "utf8");
}

function responseKey(session) {
  return `${session.sectionId}::${session.bankId}`;
}

function storeFor(session) {
  const key = responseKey(session);
  if (!responseStore[key]) responseStore[key] = { sectionId: session.sectionId, bankId: session.bankId, students: {} };
  return responseStore[key];
}

function responseStoreForSelection(sectionId, bankId) {
  const key = `${sectionId}::${bankId}`;
  if (!responseStore[key]) responseStore[key] = { sectionId, bankId, students: {} };
  return responseStore[key];
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 15e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function auth(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    const [username, role, password] = Buffer.from(token, "base64url").toString("utf8").split(":");
    const account = accounts[username];
    if (account && account.role === role && account.password === password) {
      return { username, role: account.role, name: account.name };
    }
  } catch {}
  return null;
}

function requireAdmin(req, res) {
  const user = auth(req);
  if (!user || user.role !== "admin") {
    sendJson(res, 403, { error: "Solo la cuenta administradora puede realizar esta accion" });
    return false;
  }
  return true;
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) code += alphabet[crypto.randomInt(alphabet.length)];
  return sessions.has(code) ? makeCode() : code;
}

function localInviteBase() {
  const networks = os.networkInterfaces();
  const candidates = [];
  for (const entries of Object.values(networks)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) candidates.push(item.address);
    }
  }
  const privateAddress =
    candidates.find((address) => address.startsWith("192.168.")) ||
    candidates.find((address) => address.startsWith("10.")) ||
    candidates.find((address) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(address));
  if (privateAddress) return `http://${privateAddress}:${port}`;
  if (candidates[0]) return `http://${candidates[0]}:${port}`;
  return `http://127.0.0.1:${port}`;
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function inviteBase(req) {
  const configured = normalizeBaseUrl(
    process.env.PUBLIC_BASE_URL ||
      process.env.APP_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.RAILWAY_PUBLIC_DOMAIN
  );
  if (configured) return configured;
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (req?.socket?.encrypted ? "https" : "http");
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : localInviteBase();
}

function rankParticipants(session) {
  const selected = selectedQuestionIndexes(session);
  return rankStoredParticipants(session.sectionId, session.bankId, selected);
}

function rankStoredParticipants(sectionId, bankId, selected = []) {
  const stored = Object.values(responseStoreForSelection(sectionId, bankId).students);
  const participants = stored.map((student) => ({
    id: student.id,
    name: student.name,
    rut: student.rut || "",
    score: student.score,
    answers: Object.keys(student.answers).length,
    answerMap: student.answers || {},
    sectionId,
    bankId,
    answeredCurrent: selected.length > 0 && selected.every((index) => student.answers[index] !== undefined),
  }));
  participants.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return participants.map((student, index) => ({ ...student, place: index + 1 }));
}

function currentQuestionFor(session) {
  const bank = data.banks.find((item) => item.id === session.bankId);
  return bank && Number.isInteger(session.currentQuestionIndex)
    ? bank.questions[session.currentQuestionIndex]
    : null;
}

function selectedQuestionIndexes(session) {
  const bank = data.banks.find((item) => item.id === session.bankId);
  if (!bank) return [];
  const source = Array.isArray(session.selectedQuestions) && session.selectedQuestions.length
    ? session.selectedQuestions
    : bank.questions.map((_, index) => index);
  return source
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < bank.questions.length);
}

function publicQuestionsFor(session) {
  const bank = data.banks.find((item) => item.id === session.bankId);
  if (!bank || !session.quizPublished || !session.acceptingAnswers) return [];
  return selectedQuestionIndexes(session).map((index) => ({ index, ...bank.questions[index] }));
}

function recomputeStudentScore(session, student) {
  const bank = data.banks.find((item) => item.id === session.bankId);
  if (!bank) return 0;
  let score = 0;
  for (const [questionIndex, answerIndex] of Object.entries(student.answers)) {
    const answer = bank.questions[Number(questionIndex)]?.answers?.[Number(answerIndex)];
    score += Number(answer?.points || 0);
  }
  student.score = score;
  return score;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeRut(value) {
  return String(value || "").trim().toLowerCase().replace(/[^0-9k]/g, "");
}

function findStoredStudentByIdentity(session, id, rut, name) {
  const stored = storeFor(session).students;
  if (stored[id]) return stored[id];
  const rutKey = normalizeRut(rut);
  const nameKey = normalizeText(name);
  return Object.values(stored).find((student) => {
    if (rutKey && normalizeRut(student.rut) === rutKey) return true;
    return !rutKey && nameKey && normalizeText(student.name) === nameKey;
  });
}

function elapsedSeconds(dateValue) {
  return dateValue ? Math.max(0, Math.floor((Date.now() - new Date(dateValue).getTime()) / 1000)) : 0;
}

function remainingSeconds(session) {
  if (!session.timerStartedAt) return Number(session.durationSeconds || 0);
  return Math.max(0, Number(session.durationSeconds || 0) - elapsedSeconds(session.timerStartedAt));
}

function publicSession(session, req) {
  const bank = data.banks.find((item) => item.id === session.bankId);
  const section = data.sections.find((item) => item.id === session.sectionId);
  const currentQuestion = currentQuestionFor(session);
  const selectedQuestions = selectedQuestionIndexes(session);
  const participants = rankParticipants(session);

  return {
    code: session.code,
    section,
    bank: bank ? { id: bank.id, name: bank.name, area: bank.area, total: bank.questions.length } : null,
    currentQuestionIndex: session.currentQuestionIndex,
    currentQuestion,
    selectedQuestions,
    quizPublished: session.quizPublished,
    quizQuestions: bank ? selectedQuestions.map((index) => ({ index, ...bank.questions[index] })) : [],
    studentQuestions: publicQuestionsFor(session),
    acceptingAnswers: session.acceptingAnswers,
    showRanking: session.showRanking,
    revealPodium: session.revealPodium,
    winnersPublished: session.winnersPublished,
    timerStartedAt: session.timerStartedAt,
    questionStartedAt: session.questionStartedAt,
    durationSeconds: session.durationSeconds,
    expectedParticipants: Number(session.expectedParticipants || 0),
    elapsedSeconds: elapsedSeconds(session.timerStartedAt),
    remainingSeconds: remainingSeconds(session),
    questionElapsedSeconds: elapsedSeconds(session.questionStartedAt),
    joinUrl: `${inviteBase(req)}/estudiante?code=${session.code}`,
    projectionUrl: `${inviteBase(req)}/proyeccion?code=${session.code}`,
    qrUrl: `/api/session/${session.code}/qr`,
    participants,
    createdAt: session.createdAt,
  };
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let file =
    url.pathname === "/" ||
    url.pathname === "/admin" ||
    url.pathname === "/admin/" ||
    url.pathname === "/proyeccion" ||
    url.pathname === "/proyeccion/" ||
    url.pathname === "/estudiante" ||
    url.pathname === "/estudiante/"
      ? "index.html"
      : url.pathname.slice(1);
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(full).toLowerCase();
  const type =
    ext === ".html" ? "text/html; charset=utf-8" :
    ext === ".css" ? "text/css; charset=utf-8" :
    ext === ".js" ? "application/javascript; charset=utf-8" :
    ext === ".png" ? "image/png" :
    "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const account = accounts[username];
    if (!account || account.password !== String(body.password || "")) {
      sendJson(res, 401, { error: "Usuario o clave incorrectos" });
      return;
    }
    const token = Buffer.from(`${username}:${account.role}:${account.password}`, "utf8").toString("base64url");
    sendJson(res, 200, { token, username, role: account.role, name: account.name });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/data") {
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/responses") {
    if (!requireAdmin(req, res)) return;
    const sectionId = url.searchParams.get("sectionId") || "";
    const bankId = url.searchParams.get("bankId") || "";
    const section = data.sections.find((item) => item.id === sectionId) || null;
    const bank = data.banks.find((item) => item.id === bankId) || null;
    if (!section || !bank) {
      sendJson(res, 400, { error: "Selecciona una seccion y un banco valido" });
      return;
    }
    const matchingSession = [...sessions.values()]
      .reverse()
      .find((session) => session.sectionId === sectionId && session.bankId === bankId);
    const selected = matchingSession ? selectedQuestionIndexes(matchingSession) : [];
    sendJson(res, 200, {
      section,
      bank: { id: bank.id, name: bank.name, area: bank.area, total: bank.questions.length },
      expectedParticipants: Number(matchingSession?.expectedParticipants || 0),
      participants: rankStoredParticipants(sectionId, bankId, selected),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/responses/student-delete") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const sectionId = String(body.sectionId || "");
    const bankId = String(body.bankId || "");
    const studentId = String(body.studentId || "");
    if (sectionId && bankId && studentId) {
      delete responseStoreForSelection(sectionId, bankId).students[studentId];
      for (const session of sessions.values()) {
        if (session.sectionId === sectionId && session.bankId === bankId) session.students.delete(studentId);
      }
      saveResponseStore();
    }
    const bank = data.banks.find((item) => item.id === bankId);
    const selected = bank ? bank.questions.map((_, index) => index) : [];
    sendJson(res, 200, { participants: rankStoredParticipants(sectionId, bankId, selected) });
    return;
  }

  const bankDeleteMatch = url.pathname.match(/^\/api\/banks\/([^/]+)$/);
  if (req.method === "DELETE" && bankDeleteMatch) {
    if (!requireAdmin(req, res)) return;
    const id = decodeURIComponent(bankDeleteMatch[1]);
    const index = data.banks.findIndex((bank) => bank.id === id);
    if (index < 0) {
      sendJson(res, 404, { error: "Banco no encontrado" });
      return;
    }
    const inUse = [...sessions.values()].some((session) => session.bankId === id);
    if (inUse) {
      sendJson(res, 409, { error: "No se puede eliminar un banco usado por una sesion activa" });
      return;
    }
    data.banks.splice(index, 1);
    saveData();
    sendJson(res, 200, { banks: data.banks });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/banks/import-word") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const raw = Buffer.from(String(body.content || ""), "base64");
    if (!raw.length) {
      sendJson(res, 400, { error: "Archivo Word vacio" });
      return;
    }
    const safeName = String(body.filename || "cuestionario.docx").replace(/[^\w.-]+/g, "_");
    const tmpPath = path.join(os.tmpdir(), `upload-${Date.now()}-${safeName}`);
    fs.writeFileSync(tmpPath, raw);
    childProcess.execFile(
      process.env.PYTHON_BIN || process.env.PYTHON_PATH || "python",
      [path.join(ROOT, "parse_word.py"), tmpPath],
      { cwd: ROOT, timeout: 30000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
      (error, stdout) => {
        try { fs.unlinkSync(tmpPath); } catch {}
        if (error) {
          sendJson(res, 500, { error: "No se pudo leer el Word" });
          return;
        }
        try {
          const imported = JSON.parse(stdout);
          imported.forEach((bank) => {
            bank.id = `word-${Date.now()}-${crypto.randomInt(10000)}`;
            data.banks.push(bank);
          });
          saveData();
          sendJson(res, 200, { banks: imported, allBanks: data.banks });
        } catch {
          sendJson(res, 500, { error: "El Word no tiene el formato esperado de preguntas" });
        }
      }
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const code = makeCode();
    const now = new Date().toISOString();
    const session = {
      code,
      sectionId: body.sectionId,
      bankId: body.bankId,
      currentQuestionIndex: null,
      acceptingAnswers: false,
      quizPublished: false,
      selectedQuestions: [],
      durationSeconds: Math.max(60, Number(body.durationSeconds || 600)),
      expectedParticipants: Math.max(0, Number(body.expectedParticipants || 0)),
      showRanking: false,
      revealPodium: false,
      winnersPublished: false,
      timerStartedAt: null,
      questionStartedAt: null,
      students: new Map(),
      createdAt: now,
    };
    sessions.set(code, session);
    sendJson(res, 201, publicSession(session, req));
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/session\/([A-Z0-9]+)(?:\/(question|answer|podium|settings|reset|qr|timer|publish|student-delete))?$/);
  if (sessionMatch) {
    const code = sessionMatch[1];
    const action = sessionMatch[2] || "";
    const session = sessions.get(code);
    if (!session) {
      sendJson(res, 404, { error: "Sesion no encontrada" });
      return;
    }

    if (req.method === "GET" && action === "qr") {
      const qr = await QRCode.toBuffer(`${inviteBase(req)}/estudiante?code=${session.code}`, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
      });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(qr);
      return;
    }

    if (req.method === "GET" && !action) {
      sendJson(res, 200, publicSession(session, req));
      return;
    }

    const body = await readBody(req);
    if (req.method === "POST" && action === "question") {
      if (!requireAdmin(req, res)) return;
      session.currentQuestionIndex = Number(body.questionIndex);
      session.acceptingAnswers = true;
      session.quizPublished = true;
      session.selectedQuestions = [Number(body.questionIndex)];
      session.revealPodium = false;
      session.winnersPublished = false;
      session.questionStartedAt = new Date().toISOString();
      sendJson(res, 200, publicSession(session, req));
      return;
    }

    if (req.method === "POST" && action === "publish") {
      if (!requireAdmin(req, res)) return;
      const bank = data.banks.find((item) => item.id === session.bankId);
      const allIndexes = bank ? bank.questions.map((_, index) => index) : [];
      const selected = Array.isArray(body.selectedQuestions) && body.selectedQuestions.length
        ? body.selectedQuestions.map(Number)
        : allIndexes;
      session.selectedQuestions = selected.filter((index) => allIndexes.includes(index));
      session.quizPublished = true;
      session.acceptingAnswers = false;
      session.showRanking = false;
      if (Number(body.durationSeconds) >= 60) session.durationSeconds = Number(body.durationSeconds);
      if (Number(body.expectedParticipants) >= 0) session.expectedParticipants = Number(body.expectedParticipants);
      session.timerStartedAt = null;
      session.currentQuestionIndex = null;
      session.questionStartedAt = null;
      session.revealPodium = false;
      session.winnersPublished = false;
      sendJson(res, 200, publicSession(session, req));
      return;
    }

    if (req.method === "POST" && action === "answer") {
      if (!session.quizPublished || !session.acceptingAnswers) {
        sendJson(res, 409, { error: "El cuestionario no esta abierto" });
        return;
      }
      if (session.timerStartedAt && remainingSeconds(session) <= 0) {
        session.acceptingAnswers = false;
        sendJson(res, 409, { error: "El tiempo se termino" });
        return;
      }
      const bank = data.banks.find((item) => item.id === session.bankId);
      const questionIndex = Number(body.questionIndex);
      if (!selectedQuestionIndexes(session).includes(questionIndex)) {
        sendJson(res, 400, { error: "Pregunta no publicada" });
        return;
      }
      const question = bank?.questions[questionIndex];
      const answerIndex = Number(body.answerIndex);
      const answer = question?.answers[answerIndex];
      if (!answer) {
        sendJson(res, 400, { error: "Respuesta invalida" });
        return;
      }
      let id = String(body.studentId || crypto.randomUUID());
      const name = String(body.name || "Estudiante").trim().slice(0, 60);
      const rut = String(body.rut || "").trim().slice(0, 20);
      const storedStudent = findStoredStudentByIdentity(session, id, rut, name);
      if (storedStudent) id = storedStudent.id;
      let student = session.students.get(id);
      if (!student) {
        student = storedStudent
          ? { ...storedStudent, answers: { ...(storedStudent.answers || {}) } }
          : { id, name, rut, score: 0, answers: {} };
        session.students.set(id, student);
      }
      if (student.answers[questionIndex] !== undefined) {
        sendJson(res, 409, { error: "Ya enviaste una respuesta para esta pregunta. No se puede editar." });
        return;
      }
      student.name = name;
      if (rut) student.rut = rut;
      student.answers[questionIndex] = answerIndex;
      recomputeStudentScore(session, student);
      const stored = storeFor(session);
      stored.students[id] = {
        id,
        name: student.name,
        rut: student.rut || "",
        score: student.score,
        answers: student.answers,
        updatedAt: new Date().toISOString(),
      };
      saveResponseStore();
      const ranking = rankParticipants(session);
      const ranked = ranking.find((item) => item.id === id);
      sendJson(res, 200, { studentId: id, points: answer.points, total: student.score, place: ranked?.place });
      return;
    }

    if (req.method === "POST" && action === "settings") {
      if (!requireAdmin(req, res)) return;
      if (typeof body.showRanking === "boolean") session.showRanking = body.showRanking;
      if (Number(body.expectedParticipants) >= 0) session.expectedParticipants = Number(body.expectedParticipants);
      const isClosingAnswers = body.acceptingAnswers === false;
      if (Number(body.durationSeconds) >= 60 && !isClosingAnswers) {
        session.durationSeconds = Number(body.durationSeconds);
      }
      if (typeof body.acceptingAnswers === "boolean") {
        if (body.acceptingAnswers) {
          session.acceptingAnswers = true;
          if (remainingSeconds(session) <= 0) {
            session.durationSeconds = Math.max(60, Number(body.durationSeconds || session.durationSeconds || 600));
          }
          if (!session.timerStartedAt && remainingSeconds(session) > 0) {
            session.timerStartedAt = new Date().toISOString();
          }
        } else {
          if (session.timerStartedAt) {
            session.durationSeconds = remainingSeconds(session);
            session.timerStartedAt = null;
          }
          session.acceptingAnswers = false;
        }
      }
      if (typeof body.quizPublished === "boolean") session.quizPublished = body.quizPublished;
      if (typeof body.winnersPublished === "boolean") {
        session.winnersPublished = body.winnersPublished;
        session.revealPodium = body.winnersPublished ? true : session.revealPodium;
        if (body.winnersPublished) {
          if (session.timerStartedAt) {
            session.durationSeconds = remainingSeconds(session);
            session.timerStartedAt = null;
          }
          session.acceptingAnswers = false;
        }
      }
      sendJson(res, 200, publicSession(session, req));
      return;
    }

    if (req.method === "POST" && action === "student-delete") {
      if (!requireAdmin(req, res)) return;
      const studentId = String(body.studentId || "");
      if (studentId) {
        session.students.delete(studentId);
        delete storeFor(session).students[studentId];
        saveResponseStore();
      }
      sendJson(res, 200, publicSession(session, req));
      return;
    }

    if (req.method === "POST" && action === "timer") {
      if (!requireAdmin(req, res)) return;
      if (body.start === true) session.timerStartedAt = new Date().toISOString();
      if (body.reset === true) session.timerStartedAt = null;
      sendJson(res, 200, publicSession(session, req));
      return;
    }

    if (req.method === "POST" && action === "podium") {
      if (!requireAdmin(req, res)) return;
      session.revealPodium = Boolean(body.reveal);
      if (session.revealPodium) session.winnersPublished = true;
      sendJson(res, 200, publicSession(session, req));
      return;
    }

    if (req.method === "POST" && action === "reset") {
      if (!requireAdmin(req, res)) return;
      session.acceptingAnswers = false;
      session.quizPublished = false;
      session.currentQuestionIndex = null;
      session.questionStartedAt = null;
      session.revealPodium = false;
      session.winnersPublished = false;
      sendJson(res, 200, publicSession(session, req));
      return;
    }
  }

  serveStatic(req, res);
});

const port = Number(process.env.PORT || 8787);
server.listen(port, "0.0.0.0", () => {
  console.log(`Olimpiadas listo en http://localhost:${port}`);
});
