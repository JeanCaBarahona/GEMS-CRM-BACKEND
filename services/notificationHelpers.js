// Helpers para crear notificaciones de mención, asignación, comentarios y
// vencimientos. Se hacen "fire and forget" — si alguno falla no rompe la
// operación principal.
//
// El envío de EMAIL (además de la notificación en campanita) solo se activa
// para entityType === 'activity' (módulo Actividades). El módulo de Soporte
// (Tickets) tiene su propio flujo de emails en emailService.js y no pasa por
// aquí; el tablero Kanban (entityType 'task') sigue solo con notificación
// en campanita, sin correo, hasta que se pida explícitamente.

const Notification = require('../models/Notification');
const User = require('../models/User');

/**
 * Normaliza un nombre: quita tildes, espacios y baja a minúsculas.
 * "Sebastián Pulgarín Gómez" -> "sebastianpulgaringomez"
 */
function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remover combining marks
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * Detecta menciones @nombre en un texto y devuelve los _id de usuarios coincidentes.
 */
async function resolveMentionedUserIds(text) {
  if (!text || typeof text !== 'string') return [];
  // Regex unicode-aware: acepta letras con tildes/ñ, números y _
  const matches = text.match(/@([\p{L}\p{N}_]+)/gu) || [];
  if (matches.length === 0) return [];

  const handles = matches.map(m => normalize(m.slice(1)));

  const users = await User.find({}).select('_id name').lean();
  const found = new Set();
  for (const u of users) {
    const handle = normalize(u.name);
    // Match exacto, o que el handle del texto sea prefijo del nombre completo (tolerancia)
    if (handles.includes(handle) || handles.some(h => h.length >= 3 && handle.startsWith(h))) {
      found.add(String(u._id));
    }
  }
  return Array.from(found);
}

// Nombre de quien origina la notificación, para el cuerpo del email.
async function getFromUserName(fromUserId) {
  if (!fromUserId) return 'Alguien';
  const user = await User.findById(fromUserId).select('name').lean();
  return user?.name || 'Alguien';
}

// Usuarios destinatarios con email, para poder enviarles el correo.
async function getEmailableUsers(userIds) {
  if (!userIds || userIds.length === 0) return [];
  const users = await User.find({ _id: { $in: userIds } }).select('name email').lean();
  return users.filter(u => u.email);
}

/**
 * Crea notificaciones de mención para cada usuario mencionado en el texto.
 * NOTA: permite auto-mención (útil para testing y para recordatorios personales).
 */
async function notifyMentions({ text, entityType, entityId, entityTitle, fromUserId }) {
  try {
    const userIds = await resolveMentionedUserIds(text);
    if (userIds.length === 0) return;

    const ops = userIds.map(uid => ({
      userId: uid,
      category: 'mention',
      entityType,
      entityId,
      title: 'Te mencionaron en una tarea',
      message: entityTitle || '',
      read: false,
      fromUserId,
      metadata: { text }
    }));

    if (ops.length > 0) await Notification.insertMany(ops);

    if (entityType === 'activity') {
      const [recipients, fromUserName] = await Promise.all([
        getEmailableUsers(userIds),
        getFromUserName(fromUserId)
      ]);
      const { sendMentionEmail } = require('./activityEmailService');
      await Promise.all(recipients.map(toUser =>
        sendMentionEmail({ toUser, fromUserName, activityId: entityId, activityTitle: entityTitle, text })
      ));
    }
  } catch (e) {
    console.warn('notifyMentions error:', e.message);
  }
}

/**
 * Crea notificaciones de asignación (excluye al asignador para evitar auto-spam).
 */
async function notifyAssignment({ assignedTo, entityType, entityId, entityTitle, fromUserId }) {
  try {
    const list = Array.isArray(assignedTo) ? assignedTo : [assignedTo];
    const recipientIds = list
      .map(uid => (uid && typeof uid === 'object') ? uid._id : uid) // acepta ids o usuarios poblados
      .filter(uid => uid && String(uid) !== String(fromUserId));

    const ops = recipientIds.map(uid => ({
      userId: uid,
      category: 'assignment',
      entityType,
      entityId,
      title: 'Nueva tarea asignada',
      message: entityTitle || '',
      read: false,
      fromUserId
    }));

    if (ops.length > 0) await Notification.insertMany(ops);

    if (entityType === 'activity' && recipientIds.length > 0) {
      const [recipients, fromUserName] = await Promise.all([
        getEmailableUsers(recipientIds),
        getFromUserName(fromUserId)
      ]);
      const { sendAssignmentEmail } = require('./activityEmailService');
      await Promise.all(recipients.map(toUser =>
        sendAssignmentEmail({ toUser, fromUserName, activityId: entityId, activityTitle: entityTitle })
      ));
    }
  } catch (e) {
    console.warn('notifyAssignment error:', e.message);
  }
}

/**
 * Notifica a los demás asignados cuando se agrega un comentario nuevo (no mención).
 */
async function notifyComment({ recipients, entityType, entityId, entityTitle, fromUserId, snippet }) {
  try {
    const recipientIds = (recipients || [])
      .map(uid => (uid && typeof uid === 'object') ? uid._id : uid)
      .filter(uid => uid && String(uid) !== String(fromUserId));

    const ops = recipientIds.map(uid => ({
      userId: uid,
      category: 'comment',
      entityType,
      entityId,
      title: 'Nuevo comentario en una tarea',
      message: entityTitle || '',
      read: false,
      fromUserId,
      metadata: { snippet }
    }));

    if (ops.length > 0) await Notification.insertMany(ops);

    if (entityType === 'activity' && recipientIds.length > 0) {
      const [emailRecipients, fromUserName] = await Promise.all([
        getEmailableUsers(recipientIds),
        getFromUserName(fromUserId)
      ]);
      const { sendCommentEmail } = require('./activityEmailService');
      await Promise.all(emailRecipients.map(toUser =>
        sendCommentEmail({ toUser, fromUserName, activityId: entityId, activityTitle: entityTitle, snippet })
      ));
    }
  } catch (e) {
    console.warn('notifyComment error:', e.message);
  }
}

/**
 * Notificación (campanita + email) de una actividad por vencer o vencida.
 * Solo la usa el cron de vencimientos (services/cronService.js) sobre Activity;
 * no aplica a tickets ni al tablero Kanban.
 */
async function notifyActivityDueDate({ activity, kind, dueDateLabel }) {
  try {
    const assignees = activity.assignedTo || [];
    const recipientIds = assignees.map(u => (u && typeof u === 'object') ? u._id : u).filter(Boolean);
    if (recipientIds.length === 0) return;

    const title = kind === 'overdue' ? 'Actividad vencida' : 'Actividad por vencer';
    const ops = recipientIds.map(uid => ({
      userId: uid,
      category: kind,
      entityType: 'activity',
      entityId: activity._id,
      title,
      message: activity.title,
      read: false
    }));
    await Notification.insertMany(ops);

    const emailRecipients = assignees.filter(u => u && typeof u === 'object' && u.email);
    const { sendDueSoonEmail, sendOverdueEmail } = require('./activityEmailService');
    const sendFn = kind === 'overdue' ? sendOverdueEmail : sendDueSoonEmail;
    await Promise.all(emailRecipients.map(toUser =>
      sendFn({ toUser, activityId: activity._id, activityTitle: activity.title, dueDate: dueDateLabel })
    ));
  } catch (e) {
    console.warn('notifyActivityDueDate error:', e.message);
  }
}

module.exports = {
  resolveMentionedUserIds,
  notifyMentions,
  notifyAssignment,
  notifyComment,
  notifyActivityDueDate
};
