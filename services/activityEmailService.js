/**
 * Emails de notificación del módulo de Actividades (menciones, asignación,
 * comentarios, vencimientos). No se usa desde el módulo de Soporte/Tickets,
 * que tiene su propio flujo de emails en emailService.js.
 */
const { sendMail, getFrontendUrl } = require('./emailService');

// Interruptor de emergencia: ACTIVITY_EMAILS_DISABLED=true detiene todos los
// envíos de este archivo sin tocar código (útil también para probar en local
// contra la base de producción sin mandar correos reales a compañeros).
function emailsEnabled() {
  return process.env.ACTIVITY_EMAILS_DISABLED !== 'true';
}

function activityLink(activityId) {
  return `${getFrontendUrl()}/activities?openActivity=${activityId}`;
}

function escapeHtml(text) {
  return (text || '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function baseTemplate({ accentColor, eyebrow, heading, bodyHtml, ctaUrl, ctaLabel }) {
  return `
  <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:auto;background:#f9fafc;border-radius:12px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:28px 40px;text-align:center">
      <p style="color:#a0aec0;margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:1px">${eyebrow}</p>
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">${heading}</h1>
    </div>
    <div style="padding:32px 40px;background:#fff">
      ${bodyHtml}
      ${ctaUrl ? `
      <div style="text-align:center;margin:28px 0 8px">
        <a href="${ctaUrl}" style="display:inline-block;background-color:${accentColor};color:#ffffff !important;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px">${ctaLabel}</a>
      </div>` : ''}
    </div>
    <div style="background:#f7fafc;padding:16px 40px;text-align:center">
      <p style="color:#a0aec0;font-size:11px;margin:0">Customer Touch CRM · Notificación automática de Actividades</p>
    </div>
  </div>`;
}

async function sendMentionEmail({ toUser, fromUserName, activityId, activityTitle, text }) {
  if (!emailsEnabled() || !toUser?.email) return null;
  const html = baseTemplate({
    accentColor: '#667eea',
    eyebrow: 'Te mencionaron',
    heading: `${escapeHtml(fromUserName)} te mencionó`,
    bodyHtml: `
      <p style="font-size:15px;color:#2d3748">Hola <strong>${escapeHtml(toUser.name)}</strong>,</p>
      <p style="color:#4a5568">Te mencionaron en la actividad <strong>${escapeHtml(activityTitle)}</strong>:</p>
      <div style="background:#f7fafc;border-left:4px solid #667eea;border-radius:8px;padding:16px 20px;margin:16px 0;color:#2d3748;font-style:italic">
        "${escapeHtml(text).slice(0, 300)}"
      </div>`,
    ctaUrl: activityLink(activityId),
    ctaLabel: 'Ver actividad'
  });
  return sendMail({ to: toUser.email, subject: `${fromUserName} te mencionó en «${activityTitle}»`, html });
}

async function sendAssignmentEmail({ toUser, fromUserName, activityId, activityTitle }) {
  if (!emailsEnabled() || !toUser?.email) return null;
  const html = baseTemplate({
    accentColor: '#48bb78',
    eyebrow: 'Nueva asignación',
    heading: 'Te asignaron una actividad',
    bodyHtml: `
      <p style="font-size:15px;color:#2d3748">Hola <strong>${escapeHtml(toUser.name)}</strong>,</p>
      <p style="color:#4a5568"><strong>${escapeHtml(fromUserName)}</strong> te asignó la actividad:</p>
      <div style="background:#f7fafc;border-left:4px solid #48bb78;border-radius:8px;padding:16px 20px;margin:16px 0;color:#2d3748;font-weight:600">
        ${escapeHtml(activityTitle)}
      </div>`,
    ctaUrl: activityLink(activityId),
    ctaLabel: 'Ver actividad'
  });
  return sendMail({ to: toUser.email, subject: `Nueva actividad asignada: ${activityTitle}`, html });
}

async function sendCommentEmail({ toUser, fromUserName, activityId, activityTitle, snippet }) {
  if (!emailsEnabled() || !toUser?.email) return null;
  const html = baseTemplate({
    accentColor: '#667eea',
    eyebrow: 'Nuevo comentario',
    heading: `${escapeHtml(fromUserName)} comentó`,
    bodyHtml: `
      <p style="font-size:15px;color:#2d3748">Hola <strong>${escapeHtml(toUser.name)}</strong>,</p>
      <p style="color:#4a5568">Nuevo comentario en <strong>${escapeHtml(activityTitle)}</strong>:</p>
      <div style="background:#f7fafc;border-left:4px solid #667eea;border-radius:8px;padding:16px 20px;margin:16px 0;color:#2d3748;font-style:italic">
        "${escapeHtml(snippet).slice(0, 300)}"
      </div>`,
    ctaUrl: activityLink(activityId),
    ctaLabel: 'Ver actividad'
  });
  return sendMail({ to: toUser.email, subject: `Nuevo comentario en «${activityTitle}»`, html });
}

async function sendDueSoonEmail({ toUser, activityId, activityTitle, dueDate }) {
  if (!emailsEnabled() || !toUser?.email) return null;
  const html = baseTemplate({
    accentColor: '#d97706',
    eyebrow: 'Por vencer',
    heading: 'Una actividad tuya vence pronto',
    bodyHtml: `
      <p style="font-size:15px;color:#2d3748">Hola <strong>${escapeHtml(toUser.name)}</strong>,</p>
      <div style="background:#fffbeb;border-left:4px solid #d97706;border-radius:8px;padding:16px 20px;margin:16px 0;color:#2d3748">
        <p style="margin:0 0 4px;font-weight:600">${escapeHtml(activityTitle)}</p>
        <p style="margin:0;font-size:13px;color:#92400e">Vence: ${dueDate}</p>
      </div>`,
    ctaUrl: activityLink(activityId),
    ctaLabel: 'Ver actividad'
  });
  return sendMail({ to: toUser.email, subject: `Vence pronto: ${activityTitle}`, html });
}

async function sendOverdueEmail({ toUser, activityId, activityTitle, dueDate }) {
  if (!emailsEnabled() || !toUser?.email) return null;
  const html = baseTemplate({
    accentColor: '#ef4444',
    eyebrow: 'Vencida',
    heading: 'Una actividad tuya está vencida',
    bodyHtml: `
      <p style="font-size:15px;color:#2d3748">Hola <strong>${escapeHtml(toUser.name)}</strong>,</p>
      <div style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;padding:16px 20px;margin:16px 0;color:#2d3748">
        <p style="margin:0 0 4px;font-weight:600">${escapeHtml(activityTitle)}</p>
        <p style="margin:0;font-size:13px;color:#991b1b">Venció: ${dueDate}</p>
      </div>`,
    ctaUrl: activityLink(activityId),
    ctaLabel: 'Ver actividad'
  });
  return sendMail({ to: toUser.email, subject: `⚠️ Vencida: ${activityTitle}`, html });
}

module.exports = {
  sendMentionEmail,
  sendAssignmentEmail,
  sendCommentEmail,
  sendDueSoonEmail,
  sendOverdueEmail
};
