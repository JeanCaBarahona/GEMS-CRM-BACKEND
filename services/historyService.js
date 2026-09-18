const mongoose = require('mongoose');
const User = require('../models/User');

// Campos que una edición nunca debe sobrescribir: identidad, tenant, autoría y el propio historial.
const PROTECTED_FIELDS = ['_id', '__v', 'organizationId', 'createdBy', 'createdAt', 'history'];

const COMMENT_SNIPPET_LENGTH = 140;

// Populate de history.changedBy para las respuestas que devuelven el documento completo
const HISTORY_POPULATE = { path: 'history.changedBy', select: 'name email photo' };

// Lleva un valor a una forma comparable y serializable: ids y fechas como string,
// vacíos como null y subdocumentos sin su _id (se regenera al reasignarlos).
function normalizeHistoryValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (Array.isArray(value)) {
    const items = value.map(normalizeHistoryValue).filter(v => v !== null);
    return items.length ? items : null;
  }
  if (typeof value === 'object') {
    const plain = typeof value.toObject === 'function' ? value.toObject() : value;
    const normalized = {};
    for (const key of Object.keys(plain).sort()) {
      if (key === '_id') continue;
      const v = normalizeHistoryValue(plain[key]);
      if (v !== null) normalized[key] = v;
    }
    return Object.keys(normalized).length ? normalized : null;
  }
  return value;
}

// Para asignaciones se guardan también los nombres, así el historial sigue siendo
// legible aunque el usuario cambie de nombre o deje la organización.
async function describeUsers(ids) {
  if (!ids) return null;
  const users = await User.find({ _id: { $in: ids } }).select('name').lean();
  const names = new Map(users.map(u => [String(u._id), u.name]));
  return ids.map(id => ({ _id: id, name: names.get(String(id)) || null }));
}

function commentSnippet(text) {
  const clean = (text || '').toString().trim();
  return clean.length > COMMENT_SNIPPET_LENGTH ? `${clean.slice(0, COMMENT_SNIPPET_LENGTH)}…` : clean;
}

/**
 * Aplica `updates` al documento y registra en su historial cada campo que cambió.
 * Compara contra los valores ya casteados por Mongoose (ObjectId, Date, arrays),
 * no contra el body crudo, para no registrar cambios que no ocurrieron.
 * No guarda: el llamador hace `save()`.
 *
 * @param {Set<string>} untracked  campos que se aplican pero no se registran
 * @param {Set<string>} valueless  campos que se registran sin valores (por tamaño)
 */
async function applyTrackedUpdates(doc, updates, userId, { untracked = new Set(), valueless = new Set() } = {}) {
  const safeUpdates = { ...updates };
  PROTECTED_FIELDS.forEach(field => delete safeUpdates[field]);

  const before = doc.toObject({ depopulate: true });
  Object.assign(doc, safeUpdates);
  const after = doc.toObject({ depopulate: true });

  for (const field of Object.keys(safeUpdates)) {
    if (untracked.has(field)) continue;
    const oldValue = normalizeHistoryValue(before[field]);
    const newValue = normalizeHistoryValue(after[field]);
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;

    if (valueless.has(field)) {
      doc.logChange(field, undefined, undefined, userId);
    } else if (field === 'assignedTo') {
      const [oldUsers, newUsers] = await Promise.all([describeUsers(oldValue), describeUsers(newValue)]);
      doc.logChange(field, oldUsers, newUsers, userId);
    } else {
      doc.logChange(field, oldValue, newValue, userId);
    }
  }
}

module.exports = {
  PROTECTED_FIELDS,
  HISTORY_POPULATE,
  normalizeHistoryValue,
  commentSnippet,
  applyTrackedUpdates
};
