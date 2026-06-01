const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const childProcess = require("child_process");
const zlib = require("zlib");
const multer = require("multer");
const QRCode = require("qrcode");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(PUBLIC, "uploads");
const DATA_PATH = process.env.DATA_PATH || path.join(ROOT, "data.json");
const data = loadData();
const SESSIONS_DB = process.env.SESSIONS_DB_PATH || path.join(ROOT, "sessions-db.json");
const sessions = loadSessionStore();
const RESPONSES_DB = process.env.RESPONSES_DB_PATH || path.join(ROOT, "responses-db.json");
const responseStore = loadResponseStore();
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "administrador").trim().toLowerCase();
const PROJECTION_USERNAME = String(process.env.PROJECTION_USERNAME || "proyeccion").trim().toLowerCase();
const AUTO_RESET_AFTER_SECONDS = 10 * 60;
const generatedAdminPassword = process.env.ADMIN_PASSWORD ? "" : crypto.randomBytes(9).toString("base64url");
const generatedProjectionPassword = process.env.PROJECTION_PASSWORD ? "" : crypto.randomBytes(9).toString("base64url");
const accounts = {
  [ADMIN_USERNAME]: {
    password: String(process.env.ADMIN_PASSWORD || generatedAdminPassword),
    role: "admin",
    name: "Administrador",
  },
  [PROJECTION_USERNAME]: {
    password: String(process.env.PROJECTION_PASSWORD || generatedProjectionPassword),
    role: "projection",
    name: "Proyeccion",
  },
};

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const wordUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOADS_DIR),
    filename: (_req, file, callback) => {
      const ext = path.extname(file.originalname || ".docx").toLowerCase() || ".docx";
      const base = path.basename(file.originalname || "cuestionario", ext).replace(/[^\w.-]+/g, "_").slice(0, 70) || "cuestionario";
      callback(null, `${Date.now()}-${crypto.randomInt(10000)}-${base}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!String(file.originalname || "").toLowerCase().endsWith(".docx")) {
      callback(new Error("Solo se permiten archivos .docx"));
      return;
    }
    callback(null, true);
  },
});

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOADS_DIR),
    filename: (_req, file, callback) => {
      const ext = path.extname(file.originalname || ".mp4").toLowerCase() || ".mp4";
      const base = path.basename(file.originalname || "video-proyeccion", ext).replace(/[^\w.-]+/g, "_").slice(0, 70) || "video-proyeccion";
      callback(null, `${Date.now()}-${crypto.randomInt(10000)}-${base}${ext}`);
    },
  }),
  limits: { fileSize: 250 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (![".mp4", ".webm", ".ogg", ".mov"].includes(ext)) {
      callback(new Error("Solo se permiten videos .mp4, .webm, .ogg o .mov"));
      return;
    }
    callback(null, true);
  },
});

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function loadData() {
  try {
    return readJsonFile(DATA_PATH);
  } catch {
    return readJsonFile(path.join(ROOT, "data.json"));
  }
}

function saveData() {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

function hydrateSession(raw) {
  const students = raw?.students instanceof Map
    ? raw.students
    : new Map(Object.entries(raw?.students || {}));
  return {
    code: String(raw?.code || ""),
    sectionId: raw?.sectionId || "",
    bankId: raw?.bankId || "",
    currentQuestionIndex: Number.isInteger(raw?.currentQuestionIndex) ? raw.currentQuestionIndex : null,
    acceptingAnswers: Boolean(raw?.acceptingAnswers),
    quizPublished: Boolean(raw?.quizPublished),
    selectedQuestions: Array.isArray(raw?.selectedQuestions) ? raw.selectedQuestions.map(Number) : [],
    durationSeconds: Math.max(0, Number(raw?.durationSeconds || 600)),
    initialDurationSeconds: Math.max(60, Number(raw?.initialDurationSeconds || raw?.durationSeconds || 600)),
    expectedParticipants: Math.max(0, Number(raw?.expectedParticipants || 0)),
    challengeText: String(raw?.challengeText || "").slice(0, 600),
    answerOrders: raw?.answerOrders && typeof raw.answerOrders === "object" ? raw.answerOrders : {},
    showRanking: Boolean(raw?.showRanking),
    revealPodium: Boolean(raw?.revealPodium),
    winnersPublished: Boolean(raw?.winnersPublished),
    winnersPublishedAt: raw?.winnersPublishedAt || (raw?.winnersPublished ? raw?.updatedAt || raw?.createdAt || null : null),
    inviteVisible:
      raw?.inviteVisible === undefined
        ? Boolean(raw?.quizPublished || raw?.acceptingAnswers || raw?.winnersPublished)
        : Boolean(raw?.inviteVisible),
    timerStartedAt: raw?.timerStartedAt || null,
    questionStartedAt: raw?.questionStartedAt || null,
    students,
    createdAt: raw?.createdAt || new Date().toISOString(),
    updatedAt: raw?.updatedAt || raw?.createdAt || new Date().toISOString(),
  };
}

function serializeSession(session) {
  return {
    ...session,
    students: Object.fromEntries(session.students || new Map()),
  };
}

function loadSessionStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_DB, "utf8"));
    const items = Array.isArray(raw) ? raw : raw.sessions || [];
    return new Map(items.filter((item) => item?.code).map((item) => [item.code, hydrateSession(item)]));
  } catch {
    return new Map();
  }
}

function saveSessionStore() {
  const payload = {
    sessions: [...sessions.values()].map(serializeSession),
  };
  fs.writeFileSync(SESSIONS_DB, JSON.stringify(payload, null, 2), "utf8");
}

function touchSession(session) {
  session.updatedAt = new Date().toISOString();
  saveSessionStore();
}

function uploadPathForBank(bank) {
  const filename = bank?.upload?.filename;
  if (!filename) return null;
  const full = path.resolve(UPLOADS_DIR, filename);
  return full.startsWith(path.resolve(UPLOADS_DIR)) ? full : null;
}

function removeUploadForBank(bank, remainingBanks) {
  const filename = bank?.upload?.filename;
  const full = uploadPathForBank(bank);
  if (!filename || !full) return false;
  const stillUsed = remainingBanks.some((item) => item.upload?.filename === filename);
  if (stillUsed) return false;
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
    return true;
  } catch {
    return false;
  }
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

function receiveWordUpload(req, res) {
  return new Promise((resolve, reject) => {
    wordUpload.single("questionnaire")(req, res, (error) => {
      if (error) reject(error);
      else resolve(req.file);
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
    sendJson(res, 403, { error: "Solo la cuenta administradora puede realizar esta acción" });
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

function rankAllParticipants() {
  const entries = [];
  for (const record of Object.values(responseStore)) {
    const section = data.sections.find((item) => item.id === record.sectionId);
    const bank = data.banks.find((item) => item.id === record.bankId);
    for (const student of Object.values(record.students || {})) {
      entries.push({
        id: `${record.sectionId}:${record.bankId}:${student.id}`,
        studentId: student.id,
        name: student.name,
        rut: student.rut || "",
        score: Number(student.score || 0),
        answers: Object.keys(student.answers || {}).length,
        sectionId: record.sectionId,
        bankId: record.bankId,
        section: section?.section || "Sin sección",
        bank: bank?.name || "Sin banco",
      });
    }
  }
  entries.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return entries.map((student, index) => ({ ...student, place: index + 1 }));
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
  return selectedQuestionIndexes(session).map((index) => {
    const question = bank.questions[index];
    const answers = Array.isArray(question?.answers) ? question.answers : [];
    const order = shuffledAnswerOrder(session.code, index, answers.length);
    return {
      index,
      text: question.text,
      answers: order.map((answerIndex) => ({
        ...answers[answerIndex],
        originalIndex: answerIndex,
      })),
    };
  });
}

function receiveVideoUpload(req, res) {
  return new Promise((resolve, reject) => {
    videoUpload.single("projectionVideo")(req, res, (error) => {
      if (error) reject(error);
      else resolve(req.file);
    });
  });
}

function shuffledAnswerOrder(code, questionIndex, count) {
  const order = Array.from({ length: count }, (_, index) => index);
  return order.sort((a, b) => {
    const left = crypto.createHash("sha256").update(`${code}:${questionIndex}:${a}`).digest("hex");
    const right = crypto.createHash("sha256").update(`${code}:${questionIndex}:${b}`).digest("hex");
    return left.localeCompare(right);
  });
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

function makeSectionId(section) {
  const base = [
    section.code,
    section.section,
    section.subject,
    crypto.randomInt(10000),
  ]
    .join("-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || `section-${Date.now()}`;
  return data.sections.some((item) => item.id === base) ? `${base}-${crypto.randomInt(10000)}` : base;
}

function makeBankId(name) {
  const base = normalizeText(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "banco";
  return data.banks.some((item) => item.id === base) ? `${base}-${crypto.randomInt(10000)}` : base;
}

function bankPayload(body = {}) {
  return {
    name: String(body.name || "").trim().slice(0, 160),
    area: String(body.area || "Sin área").trim().slice(0, 100) || "Sin área",
    subject: String(body.subject || "").trim().slice(0, 160),
    career: String(body.career || "").trim().slice(0, 160),
    challengeText: String(body.challengeText || "").trim().slice(0, 600),
  };
}

function questionPayload(body = {}) {
  const answers = Array.isArray(body.answers)
    ? body.answers
        .map((answer) => ({
          text: String(answer?.text || "").trim().slice(0, 240),
          points: Math.max(0, Number(answer?.points || 0)),
          justification: String(answer?.justification || "").trim().slice(0, 600),
        }))
        .filter((answer) => answer.text)
    : [];
  return {
    text: String(body.text || "").trim().slice(0, 500),
    answers,
  };
}

function sectionPayload(body) {
  return {
    sectorial: String(body.sectorial || "").trim(),
    area: String(body.area || "").trim(),
    career: String(body.career || "").trim(),
    code: String(body.code || "").trim(),
    subject: String(body.subject || "").trim(),
    section: String(body.section || "").trim(),
    teacher: String(body.teacher || "").trim(),
    date: String(body.date || "").trim(),
  };
}

function normalizeRut(value) {
  return String(value || "").trim().toLowerCase().replace(/[^0-9k]/g, "");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function textFromWordXml(xml) {
  const normalized = String(xml || "").replace(/<w:tab\/?>/g, " ").replace(/<w:br\/?>/g, "\n");
  return [...normalized.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1]))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function readZipEntry(buffer, targetName) {
  let eocd = -1;
  const min = Math.max(0, buffer.length - 65558);
  for (let index = buffer.length - 22; index >= min; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("No se reconocio el archivo .docx");
  const entries = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  for (let entry = 0; entry < entries; entry += 1) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error("Estructura .docx no valida");
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.slice(pos + 46, pos + 46 + nameLength).toString("utf8");
    if (name === targetName) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Entrada .docx no valida");
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed;
      if (method === 8) return zlib.inflateRawSync(compressed);
      throw new Error("Compresion .docx no soportada");
    }
    pos += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("No se encontro el contenido principal del Word");
}

function parseQuestionRows(rows) {
  const questions = [];
  let index = 0;
  while (index < rows.length) {
    const first = String(rows[index]?.[0] || "").trim();
    if (!/^\d+\./.test(first)) {
      index += 1;
      continue;
    }
    const question = first;
    index += 1;
    if (String(rows[index]?.[0] || "").trim().toLowerCase() === "respuesta") index += 1;
    const answers = [];
    while (index < rows.length) {
      const current = String(rows[index]?.[0] || "").trim();
      if (/^\d+\./.test(current)) break;
      if (current) {
        const points = Number.parseInt(String(rows[index]?.[1] || "0").replace(",", "."), 10);
        answers.push({
          text: current,
          points: Number.isFinite(points) ? points : 0,
          justification: String(rows[index]?.[2] || "").trim(),
        });
      }
      index += 1;
    }
    if (answers.length) questions.push({ text: question, answers });
  }
  return questions;
}

function tableRowsFromWordXml(tableXml) {
  return [...tableXml.matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)].map((rowMatch) =>
    [...rowMatch[0].matchAll(/<w:tc[\s\S]*?<\/w:tc>/g)].map((cellMatch) => textFromWordXml(cellMatch[0]))
  );
}

function parseDocxBanks(buffer, filename) {
  const xml = readZipEntry(buffer, "word/document.xml").toString("utf8");
  const blocks = [...xml.matchAll(/<w:(p|tbl)[\s\S]*?<\/w:\1>/g)].map((match) => ({
    type: match[1],
    xml: match[0],
  }));
  const baseName = path.basename(String(filename || "Cuestionario Word"), path.extname(String(filename || ""))).replace(/[_-]+/g, " ").trim() || "Cuestionario Word";
  const banks = [];
  let currentArea = "Importado desde Word";
  let lastTitle = "";

  blocks.forEach((block) => {
    if (block.type === "p") {
      const text = textFromWordXml(block.xml);
      if (!text) return;
      if (/^Área\s+/i.test(text) || /^Diseño\s+E\s+Industria/i.test(text)) {
        currentArea = text;
        lastTitle = "";
        return;
      }
      if (/Ponderación|Mejor respuesta|Buena respuesta|Parcialmente adecuada|Poco pertinente/i.test(text)) return;
      lastTitle = text;
      return;
    }
    const questions = parseQuestionRows(tableRowsFromWordXml(block.xml));
    if (questions.length) {
      banks.push({
        id: "",
        name: lastTitle || (banks.length ? `${baseName} ${banks.length + 1}` : baseName),
        area: currentArea,
        subject: lastTitle || "",
        career: currentArea.replace(/^Área\s+/i, ""),
        challengeText: lastTitle ? `Desafío ${lastTitle}: responder con pertinencia técnica según la asignatura y el área de trabajo.` : "",
        questions,
      });
      lastTitle = "";
    }
  });
  if (!banks.length) throw new Error("El Word no tiene preguntas con el formato esperado");
  return banks;
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

function closeExpiredTimer(session) {
  if (!session.acceptingAnswers || !session.timerStartedAt || remainingSeconds(session) > 0) return false;
  session.durationSeconds = 0;
  session.timerStartedAt = null;
  session.acceptingAnswers = false;
  session.updatedAt = new Date().toISOString();
  saveSessionStore();
  return true;
}

function resetSessionToInitial(session) {
  session.acceptingAnswers = false;
  session.quizPublished = false;
  session.currentQuestionIndex = null;
  session.questionStartedAt = null;
  session.timerStartedAt = null;
  session.durationSeconds = Math.max(60, Number(session.initialDurationSeconds || session.durationSeconds || 600));
  session.showRanking = false;
  session.revealPodium = false;
  session.winnersPublished = false;
  session.winnersPublishedAt = null;
  session.inviteVisible = false;
}

function autoResetCompletedSession(session) {
  if (!session.winnersPublished || !session.winnersPublishedAt) return false;
  if (elapsedSeconds(session.winnersPublishedAt) < AUTO_RESET_AFTER_SECONDS) return false;
  resetSessionToInitial(session);
  session.updatedAt = new Date().toISOString();
  saveSessionStore();
  return true;
}

function publicSession(session, req) {
  closeExpiredTimer(session);
  autoResetCompletedSession(session);
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
    challengeText: session.challengeText || "",
    elapsedSeconds: elapsedSeconds(session.timerStartedAt),
    remainingSeconds: remainingSeconds(session),
    questionElapsedSeconds: elapsedSeconds(session.questionStartedAt),
    projectionVideo: data.projectionVideo || null,
    joinUrl: `${inviteBase(req)}/estudiante?code=${session.code}`,
    projectionUrl: `${inviteBase(req)}/proyeccion?code=${session.code}`,
    qrUrl: `/api/session/${session.code}/qr`,
    participants,
    globalParticipants: rankAllParticipants(),
    inviteVisible: Boolean(session.inviteVisible),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/uploads" || url.pathname.startsWith("/uploads/")) {
    const relative = path.normalize(decodeURIComponent(url.pathname.replace(/^\/uploads\/?/, ""))).replace(/^(\.\.[/\\])+/, "");
    const full = path.join(UPLOADS_DIR, relative);
    if (!full.startsWith(UPLOADS_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const type =
      ext === ".docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" :
      ext === ".mp4" ? "video/mp4" :
      ext === ".webm" ? "video/webm" :
      ext === ".ogg" ? "video/ogg" :
      ext === ".mov" ? "video/quicktime" :
      "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" });
    fs.createReadStream(full).pipe(res);
    return;
  }
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

  if (req.method === "POST" && url.pathname === "/api/projection-video") {
    if (!requireAdmin(req, res)) return;
    try {
      const file = await receiveVideoUpload(req, res);
      if (!file) {
        sendJson(res, 400, { error: "Selecciona un video para la proyección" });
        return;
      }
      data.projectionVideo = {
        originalName: file.originalname,
        filename: file.filename,
        url: `/uploads/${encodeURIComponent(file.filename)}`,
        size: file.size,
        uploadedAt: new Date().toISOString(),
      };
      saveData();
      sendJson(res, 200, { projectionVideo: data.projectionVideo });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "No se pudo cargar el video" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sections") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const payload = sectionPayload(body);
    if (!payload.section || !payload.subject) {
      sendJson(res, 400, { error: "Ingresa al menos sección y asignatura" });
      return;
    }
    const id = String(body.id || "").trim();
    const existingIndex = id ? data.sections.findIndex((item) => item.id === id) : -1;
    if (existingIndex >= 0) {
      data.sections[existingIndex] = { ...data.sections[existingIndex], ...payload, id };
    } else {
      data.sections.push({ id: makeSectionId(payload), ...payload });
    }
    saveData();
    sendJson(res, 200, { sections: data.sections });
    return;
  }

  const sectionDeleteMatch = url.pathname.match(/^\/api\/sections\/([^/]+)$/);
  if (req.method === "DELETE" && sectionDeleteMatch) {
    if (!requireAdmin(req, res)) return;
    const id = decodeURIComponent(sectionDeleteMatch[1]);
    const index = data.sections.findIndex((section) => section.id === id);
    if (index < 0) {
      sendJson(res, 404, { error: "Seccion no encontrada" });
      return;
    }
    const inSessions = [...sessions.values()].some((session) => session.sectionId === id);
    const inResponses = Object.keys(responseStore).some((key) => key.startsWith(`${id}::`));
    if (inSessions || inResponses) {
      sendJson(res, 409, { error: "No se puede eliminar una sección con formularios o respuestas registradas" });
      return;
    }
    data.sections.splice(index, 1);
    saveData();
    sendJson(res, 200, { sections: data.sections });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/responses") {
    if (!requireAdmin(req, res)) return;
    const sectionId = url.searchParams.get("sectionId") || "";
    const bankId = url.searchParams.get("bankId") || "";
    const section = data.sections.find((item) => item.id === sectionId) || null;
    const bank = data.banks.find((item) => item.id === bankId) || null;
    if (!section || !bank) {
      sendJson(res, 400, { error: "Selecciona una sección y un banco válido" });
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

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    if (!requireAdmin(req, res)) return;
    const sectionId = url.searchParams.get("sectionId") || "";
    const bankId = url.searchParams.get("bankId") || "";
    const items = [...sessions.values()]
      .filter((session) => !sectionId || session.sectionId === sectionId)
      .filter((session) => !bankId || session.bankId === bankId)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
      .map((session) => publicSession(session, req));
    sendJson(res, 200, { sessions: items });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/session/latest") {
    const latest = [...sessions.values()]
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))[0];
    if (!latest) {
      sendJson(res, 404, { error: "No hay formularios creados" });
      return;
    }
    sendJson(res, 200, publicSession(latest, req));
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

  if (req.method === "POST" && url.pathname === "/api/banks") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const payload = bankPayload(body);
    if (!payload.name) {
      sendJson(res, 400, { error: "Ingresa el nombre del banco de preguntas" });
      return;
    }
    const id = String(body.id || "").trim();
    const index = id ? data.banks.findIndex((bank) => bank.id === id) : -1;
    if (index >= 0) {
      data.banks[index] = { ...data.banks[index], ...payload, id };
    } else {
      data.banks.push({ id: makeBankId(payload.name), ...payload, questions: [] });
    }
    saveData();
    sendJson(res, 200, { banks: data.banks });
    return;
  }

  const bankQuestionMatch = url.pathname.match(/^\/api\/banks\/([^/]+)\/questions$/);
  if (req.method === "POST" && bankQuestionMatch) {
    if (!requireAdmin(req, res)) return;
    const id = decodeURIComponent(bankQuestionMatch[1]);
    const bank = data.banks.find((item) => item.id === id);
    if (!bank) {
      sendJson(res, 404, { error: "Banco no encontrado" });
      return;
    }
    const payload = questionPayload(await readBody(req));
    if (!payload.text) {
      sendJson(res, 400, { error: "Ingresa el texto de la pregunta" });
      return;
    }
    if (payload.answers.length < 2) {
      sendJson(res, 400, { error: "Ingresa al menos dos alternativas" });
      return;
    }
    bank.questions = Array.isArray(bank.questions) ? bank.questions : [];
    bank.questions.push(payload);
    saveData();
    sendJson(res, 200, { bank, banks: data.banks });
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
    const bank = data.banks[index];
    const force = url.searchParams.get("force") === "1";
    const inUse = [...sessions.values()].some((session) => session.bankId === id);
    if (inUse && !force) {
      sendJson(res, 409, { error: "No se puede eliminar un banco usado por una sesión activa" });
      return;
    }
    let removedSessions = 0;
    if (inUse && force) {
      for (const [code, session] of sessions.entries()) {
        if (session.bankId === id) {
          sessions.delete(code);
          removedSessions += 1;
        }
      }
      saveSessionStore();
    }
    data.banks.splice(index, 1);
    const uploadDeleted = removeUploadForBank(bank, data.banks);
    saveData();
    sendJson(res, 200, { banks: data.banks, uploadDeleted, removedSessions });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/banks/import-word") {
    if (!requireAdmin(req, res)) return;
    let raw;
    let filename = "cuestionario.docx";
    let savedUpload = null;
    const contentType = String(req.headers["content-type"] || "");
    if (contentType.includes("multipart/form-data")) {
      try {
        const file = await receiveWordUpload(req, res);
        if (!file) {
          sendJson(res, 400, { error: "Selecciona un archivo Word" });
          return;
        }
        raw = fs.readFileSync(file.path);
        filename = file.originalname || file.filename;
        savedUpload = {
          originalName: file.originalname,
          filename: file.filename,
          url: `/uploads/${encodeURIComponent(file.filename)}`,
          size: file.size,
          uploadedAt: new Date().toISOString(),
        };
      } catch (error) {
        sendJson(res, 400, { error: error.message || "No se pudo recibir el archivo Word" });
        return;
      }
    } else {
      const body = await readBody(req);
      raw = Buffer.from(String(body.content || ""), "base64");
      filename = String(body.filename || filename);
    }
    if (!raw.length) {
      sendJson(res, 400, { error: "Archivo Word vacio" });
      return;
    }
    const importBanks = (imported) => {
      if (!Array.isArray(imported) || !imported.length) {
        throw new Error("El Word no tiene preguntas con el formato esperado");
      }
      imported.forEach((bank) => {
        bank.id = `word-${Date.now()}-${crypto.randomInt(10000)}`;
        if (savedUpload) bank.upload = savedUpload;
        data.banks.push(bank);
      });
      saveData();
      sendJson(res, 200, { banks: imported, allBanks: data.banks });
    };
    try {
      importBanks(parseDocxBanks(raw, filename));
      return;
    } catch (jsError) {
      if (process.env.WORD_IMPORT_FALLBACK_PYTHON !== "1") {
        if (savedUpload?.filename) removeUploadForBank({ upload: savedUpload }, data.banks);
        sendJson(res, 400, { error: jsError.message || "El Word no tiene el formato esperado de preguntas" });
        return;
      }
    }
    const safeName = String(filename || "cuestionario.docx").replace(/[^\w.-]+/g, "_");
    const tmpPath = path.join(os.tmpdir(), `upload-${Date.now()}-${safeName}`);
    fs.writeFileSync(tmpPath, raw);
    childProcess.execFile(
      process.env.PYTHON_BIN || process.env.PYTHON_PATH || "python",
      [path.join(ROOT, "parse_word.py"), tmpPath],
      { cwd: ROOT, timeout: 30000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
      (error, stdout) => {
        try { fs.unlinkSync(tmpPath); } catch {}
        if (error) {
          if (savedUpload?.filename) removeUploadForBank({ upload: savedUpload }, data.banks);
          sendJson(res, 500, { error: "No se pudo leer el Word" });
          return;
        }
        try {
          const imported = JSON.parse(stdout);
          importBanks(imported);
        } catch (parseError) {
          if (savedUpload?.filename) removeUploadForBank({ upload: savedUpload }, data.banks);
          sendJson(res, 400, { error: parseError.message || "El Word no tiene el formato esperado de preguntas" });
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
    const bank = data.banks.find((item) => item.id === body.bankId);
    const session = {
      code,
      sectionId: body.sectionId,
      bankId: body.bankId,
      currentQuestionIndex: null,
      acceptingAnswers: false,
      quizPublished: false,
      selectedQuestions: [],
      durationSeconds: Math.max(60, Number(body.durationSeconds || 600)),
      initialDurationSeconds: Math.max(60, Number(body.durationSeconds || 600)),
      expectedParticipants: Math.max(0, Number(body.expectedParticipants || 0)),
      challengeText: String(body.challengeText || bank?.challengeText || "").trim().slice(0, 600),
      answerOrders: {},
      showRanking: false,
      revealPodium: false,
      winnersPublished: false,
      winnersPublishedAt: null,
      inviteVisible: true,
      timerStartedAt: null,
      questionStartedAt: null,
      students: new Map(),
      createdAt: now,
    };
    sessions.set(code, session);
    touchSession(session);
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

    if (req.method === "DELETE" && !action) {
      if (!requireAdmin(req, res)) return;
      sessions.delete(code);
      saveSessionStore();
      sendJson(res, 200, { deleted: true, code });
      return;
    }

    const body = await readBody(req);
    if (req.method === "POST" && action === "question") {
      if (!requireAdmin(req, res)) return;
      session.currentQuestionIndex = Number(body.questionIndex);
      session.acceptingAnswers = true;
      session.inviteVisible = true;
      session.quizPublished = true;
      session.selectedQuestions = [Number(body.questionIndex)];
      session.revealPodium = false;
      session.winnersPublished = false;
      session.winnersPublishedAt = null;
      session.questionStartedAt = new Date().toISOString();
      touchSession(session);
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
      session.inviteVisible = true;
      session.showRanking = false;
      if (Number(body.durationSeconds) >= 60) {
        session.durationSeconds = Number(body.durationSeconds);
        session.initialDurationSeconds = Number(body.durationSeconds);
      }
      if (Number(body.expectedParticipants) >= 0) session.expectedParticipants = Number(body.expectedParticipants);
      if (typeof body.challengeText === "string") session.challengeText = body.challengeText.trim().slice(0, 600);
      else if (!session.challengeText && bank?.challengeText) session.challengeText = String(bank.challengeText).slice(0, 600);
      session.timerStartedAt = null;
      session.currentQuestionIndex = null;
      session.questionStartedAt = null;
      session.revealPodium = false;
      session.winnersPublished = false;
      session.winnersPublishedAt = null;
      touchSession(session);
      sendJson(res, 200, publicSession(session, req));
      return;
    }

    if (req.method === "POST" && action === "answer") {
      if (!session.quizPublished || !session.acceptingAnswers) {
        sendJson(res, 409, { error: "El cuestionario no está abierto" });
        return;
      }
      if (session.timerStartedAt && remainingSeconds(session) <= 0) {
        session.acceptingAnswers = false;
        touchSession(session);
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
        sendJson(res, 400, { error: "Respuesta inválida" });
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
      touchSession(session);
      const ranking = rankParticipants(session);
      const ranked = ranking.find((item) => item.id === id);
      sendJson(res, 200, { studentId: id, points: answer.points, total: student.score, place: ranked?.place });
      return;
    }

    if (req.method === "POST" && action === "settings") {
      if (!requireAdmin(req, res)) return;
      if (typeof body.showRanking === "boolean") session.showRanking = body.showRanking;
      if (Number(body.expectedParticipants) >= 0) session.expectedParticipants = Number(body.expectedParticipants);
      if (typeof body.challengeText === "string") session.challengeText = body.challengeText.trim().slice(0, 600);
      const isClosingAnswers = body.acceptingAnswers === false;
      if (Number(body.durationSeconds) >= 60 && !isClosingAnswers) {
        session.durationSeconds = Number(body.durationSeconds);
        session.initialDurationSeconds = Number(body.durationSeconds);
      }
      if (typeof body.acceptingAnswers === "boolean") {
        if (body.acceptingAnswers) {
          session.acceptingAnswers = true;
          session.inviteVisible = true;
          if (remainingSeconds(session) <= 0) {
            session.durationSeconds = Math.max(60, Number(body.durationSeconds || session.durationSeconds || 600));
            session.initialDurationSeconds = session.durationSeconds;
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
          session.inviteVisible = false;
          if (session.timerStartedAt) {
            session.durationSeconds = remainingSeconds(session);
            session.timerStartedAt = null;
          }
          session.acceptingAnswers = false;
          session.winnersPublishedAt = new Date().toISOString();
        } else {
          session.winnersPublishedAt = null;
        }
      }
      touchSession(session);
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
      touchSession(session);
      sendJson(res, 200, publicSession(session, req));
      return;
    }

    if (req.method === "POST" && action === "timer") {
      if (!requireAdmin(req, res)) return;
      if (body.start === true) session.timerStartedAt = new Date().toISOString();
      if (body.start === true) session.inviteVisible = true;
      if (body.reset === true) session.timerStartedAt = null;
      touchSession(session);
      sendJson(res, 200, publicSession(session, req));
      return;
    }

    if (req.method === "POST" && action === "podium") {
      if (!requireAdmin(req, res)) return;
      session.revealPodium = Boolean(body.reveal);
      if (session.revealPodium) session.winnersPublished = true;
      touchSession(session);
      sendJson(res, 200, publicSession(session, req));
      return;
    }

    if (req.method === "POST" && action === "reset") {
      if (!requireAdmin(req, res)) return;
      resetSessionToInitial(session);
      touchSession(session);
      sendJson(res, 200, publicSession(session, req));
      return;
    }
  }

  serveStatic(req, res);
});

const port = Number(process.env.PORT || 8787);
server.listen(port, "0.0.0.0", () => {
  console.log(`Olimpiadas listo en http://localhost:${port}`);
  if (generatedAdminPassword) {
    console.log(`Admin temporal: usuario ${ADMIN_USERNAME} | clave ${generatedAdminPassword}`);
  }
  if (generatedProjectionPassword) {
    console.log(`Proyeccion temporal: usuario ${PROJECTION_USERNAME} | clave ${generatedProjectionPassword}`);
  }
});
