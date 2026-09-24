/**
 * Team Report Service
 * Genera KPIs por persona y reportes de equipo para dashboard y emails.
 */
const Activity = require('../models/Activity');
const Task = require('../models/Task');
const User = require('../models/User');
const { sendMail } = require('./emailService');
const Setting = require('../models/Setting');

// ─── Helpers ────────────────────────────────────────────────────────────────

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // lunes
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function weeksAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

const MONTH_NAMES_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const DAY_NAMES_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

// ─── KPIs por persona ───────────────────────────────────────────────────────

async function getTeamKPIs({ period = 'month', department } = {}) {
  const now = new Date();
  let since;
  if (period === 'week') since = startOfWeek(now);
  else if (period === 'month') since = startOfMonth(now);
  else if (period === 'quarter') since = monthsAgo(3);
  else since = new Date(now.getFullYear(), 0, 1); // year

  // Obtener usuarios activos
  const userFilter = { isActive: { $ne: false } };
  if (department) userFilter.department = department;
  const users = await User.find(userFilter).select('_id name email role department avatar photo').lean();
  const userIds = users.map(u => u._id);

  // Actividades en el período
  const activities = await Activity.find({
    assignedTo: { $in: userIds },
    $or: [
      { updatedAt: { $gte: since } },
      { createdAt: { $gte: since } },
    ],
  }).lean();

  // Tareas en el período
  const tasks = await Task.find({
    assignedTo: { $in: userIds },
    $or: [
      { updatedAt: { $gte: since } },
      { createdAt: { $gte: since } },
    ],
  }).lean();

  // Calcular KPIs por persona
  const kpis = users.map(user => {
    const uid = String(user._id);

    // Actividades de este usuario
    const userActivities = activities.filter(a =>
      (a.assignedTo || []).some(id => String(id) === uid)
    );
    const userTasks = tasks.filter(t =>
      (t.assignedTo || []).some(id => String(id) === uid)
    );

    const totalItems = userActivities.length + userTasks.length;

    const completedActivities = userActivities.filter(a => a.status === 'completed').length;
    const completedTasks = userTasks.filter(t => t.status === 'resolved' || t.status === 'closed').length;
    const totalCompleted = completedActivities + completedTasks;

    // Tasa de cumplimiento
    const complianceRate = totalItems > 0 ? Math.round((totalCompleted / totalItems) * 100) : 0;

    // Tiempo promedio de resolución (días)
    const resolvedItems = [
      ...userActivities.filter(a => a.status === 'completed'),
      ...userTasks.filter(t => t.status === 'resolved' || t.status === 'closed'),
    ];
    let avgResolutionDays = 0;
    if (resolvedItems.length > 0) {
      const totalDays = resolvedItems.reduce((sum, item) => {
        const created = new Date(item.createdAt).getTime();
        const resolved = new Date(item.updatedAt).getTime();
        return sum + (resolved - created) / (1000 * 60 * 60 * 24);
      }, 0);
      avgResolutionDays = Math.round((totalDays / resolvedItems.length) * 10) / 10;
    }

    // Horas trabajadas (timeSpent de activities + actualHours de tasks)
    const hoursWorked = Math.round(
      (userActivities.reduce((s, a) => s + (a.timeSpent || 0), 0) / 3600) +
      userTasks.reduce((s, t) => s + (t.actualHours || 0), 0)
    * 10) / 10;

    // Carga actual (pendientes + en progreso)
    const pendingActivities = userActivities.filter(a => a.status === 'pending' || a.status === 'in-progress').length;
    const pendingTasks = userTasks.filter(t => t.status === 'new' || t.status === 'active').length;
    const currentWorkload = pendingActivities + pendingTasks;

    // Vencidas
    const overdueActivities = userActivities.filter(a => {
      if (a.status === 'completed' || a.status === 'cancelled') return false;
      const due = a.dueDate || a.date;
      return due && new Date(due) < now;
    }).length;
    const overdueTasks = userTasks.filter(t => {
      if (t.status === 'resolved' || t.status === 'closed') return false;
      return t.dueDate && new Date(t.dueDate) < now;
    }).length;
    const overdueCount = overdueActivities + overdueTasks;

    return {
      user: { _id: user._id, name: user.name, email: user.email, role: user.role, department: user.department, avatar: user.avatar, photo: user.photo },
      totalItems,
      totalCompleted,
      complianceRate,
      avgResolutionDays,
      hoursWorked,
      currentWorkload,
      overdueCount,
    };
  });

  // Ordenar por compliance rate desc
  kpis.sort((a, b) => b.complianceRate - a.complianceRate);

  // Totales del equipo
  const teamTotals = {
    totalItems: kpis.reduce((s, k) => s + k.totalItems, 0),
    totalCompleted: kpis.reduce((s, k) => s + k.totalCompleted, 0),
    avgCompliance: kpis.length > 0 ? Math.round(kpis.reduce((s, k) => s + k.complianceRate, 0) / kpis.length) : 0,
    avgResolution: kpis.length > 0 ? Math.round(kpis.reduce((s, k) => s + k.avgResolutionDays, 0) / kpis.length * 10) / 10 : 0,
    totalWorkload: kpis.reduce((s, k) => s + k.currentWorkload, 0),
    totalOverdue: kpis.reduce((s, k) => s + k.overdueCount, 0),
    totalHours: Math.round(kpis.reduce((s, k) => s + k.hoursWorked, 0) * 10) / 10,
  };

  return { kpis, teamTotals, period, since: since.toISOString() };
}

// ─── Tendencias semanales (últimas 8 semanas) ────────────────────────────

async function getWeeklyTrends({ department } = {}) {
  const weeks = 8;
  const since = weeksAgo(weeks);

  const userFilter = { isActive: { $ne: false } };
  if (department) userFilter.department = department;
  const userIds = (await User.find(userFilter).select('_id').lean()).map(u => u._id);

  const activities = await Activity.find({
    assignedTo: { $in: userIds },
    updatedAt: { $gte: since },
    status: 'completed',
  }).select('updatedAt assignedTo').lean();

  const tasks = await Task.find({
    assignedTo: { $in: userIds },
    updatedAt: { $gte: since },
    status: { $in: ['resolved', 'closed'] },
  }).select('updatedAt assignedTo').lean();

  // Agrupar por semana
  const weekBuckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const wStart = weeksAgo(i);
    const wEnd = i > 0 ? weeksAgo(i - 1) : new Date();

    const completedActs = activities.filter(a => {
      const d = new Date(a.updatedAt);
      return d >= wStart && d < wEnd;
    }).length;

    const completedTasks = tasks.filter(t => {
      const d = new Date(t.updatedAt);
      return d >= wStart && d < wEnd;
    }).length;

    weekBuckets.push({
      label: `${wStart.getDate()} ${MONTH_NAMES_ES[wStart.getMonth()]}`,
      weekStart: wStart.toISOString(),
      completed: completedActs + completedTasks,
      activities: completedActs,
      tasks: completedTasks,
    });
  }

  return weekBuckets;
}

// ─── Tendencias mensuales (últimos 6 meses) ──────────────────────────────

async function getMonthlyTrends({ department } = {}) {
  const months = 6;
  const since = monthsAgo(months);

  const userFilter = { isActive: { $ne: false } };
  if (department) userFilter.department = department;
  const userIds = (await User.find(userFilter).select('_id').lean()).map(u => u._id);

  const activities = await Activity.find({
    assignedTo: { $in: userIds },
    updatedAt: { $gte: since },
  }).select('updatedAt status assignedTo createdAt').lean();

  const tasks = await Task.find({
    assignedTo: { $in: userIds },
    updatedAt: { $gte: since },
  }).select('updatedAt status assignedTo createdAt').lean();

  const monthBuckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const mStart = monthsAgo(i);
    const mEnd = i > 0 ? monthsAgo(i - 1) : new Date();

    const mActs = activities.filter(a => {
      const d = new Date(a.updatedAt);
      return d >= mStart && d < mEnd;
    });
    const mTasks = tasks.filter(t => {
      const d = new Date(t.updatedAt);
      return d >= mStart && d < mEnd;
    });

    const completed = mActs.filter(a => a.status === 'completed').length +
                      mTasks.filter(t => t.status === 'resolved' || t.status === 'closed').length;
    const created = activities.filter(a => {
      const d = new Date(a.createdAt);
      return d >= mStart && d < mEnd;
    }).length + tasks.filter(t => {
      const d = new Date(t.createdAt);
      return d >= mStart && d < mEnd;
    }).length;

    monthBuckets.push({
      label: `${MONTH_NAMES_ES[mStart.getMonth()]} ${mStart.getFullYear()}`,
      month: mStart.getMonth() + 1,
      year: mStart.getFullYear(),
      completed,
      created,
    });
  }

  return monthBuckets;
}

// ─── Team Summary (para email) ──────────────────────────────────────────

async function generateTeamSummary({ period = 'week', department } = {}) {
  const { kpis, teamTotals } = await getTeamKPIs({ period, department });
  const weeklyTrends = await getWeeklyTrends({ department });

  // Quién está sobrecargado (> 10 items pendientes o > 3 vencidos)
  const overloaded = kpis.filter(k => k.currentWorkload > 10 || k.overdueCount > 3);
  // Top performers
  const topPerformers = kpis.filter(k => k.totalCompleted > 0).slice(0, 3);
  // Necesitan atención
  const needsAttention = kpis.filter(k => k.overdueCount > 0).sort((a, b) => b.overdueCount - a.overdueCount);

  return {
    teamTotals,
    kpis,
    overloaded,
    topPerformers,
    needsAttention,
    weeklyTrends,
    generatedAt: new Date().toISOString(),
  };
}

// ─── HTML Email Template ─────────────────────────────────────────────────

function buildReportEmailHtml(summary, { period = 'week' } = {}) {
  const periodLabel = { week: 'Semanal', month: 'Mensual', quarter: 'Trimestral', year: 'Anual' }[period] || period;
  const { teamTotals, kpis, overloaded, topPerformers, needsAttention } = summary;

  const complianceColor = teamTotals.avgCompliance >= 70 ? '#10b981' : teamTotals.avgCompliance >= 40 ? '#f59e0b' : '#ef4444';

  let html = `
  <div style="font-family:'Inter',Arial,sans-serif;max-width:700px;margin:auto;background:#f8fafc;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e1b4b 0%,#312e81 50%,#4338ca 100%);padding:36px 40px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:24px;font-weight:800;letter-spacing:-0.5px;">📊 Reporte ${periodLabel} del Equipo</h1>
      <p style="color:#a5b4fc;margin:10px 0 0;font-size:13px;font-weight:500;">${new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
    </div>

    <div style="padding:32px 40px;">
      <!-- Resumen general -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:28px;">
        <tr>
          <td style="text-align:center;padding:16px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;width:25%;">
            <div style="font-size:28px;font-weight:800;color:#1e293b;">${teamTotals.totalCompleted}</div>
            <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Completadas</div>
          </td>
          <td style="width:8px;"></td>
          <td style="text-align:center;padding:16px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;width:25%;">
            <div style="font-size:28px;font-weight:800;color:${complianceColor};">${teamTotals.avgCompliance}%</div>
            <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Cumplimiento</div>
          </td>
          <td style="width:8px;"></td>
          <td style="text-align:center;padding:16px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;width:25%;">
            <div style="font-size:28px;font-weight:800;color:#1e293b;">${teamTotals.totalWorkload}</div>
            <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Pendientes</div>
          </td>
          <td style="width:8px;"></td>
          <td style="text-align:center;padding:16px;background:${teamTotals.totalOverdue > 0 ? '#fef2f2' : '#fff'};border-radius:12px;border:1px solid ${teamTotals.totalOverdue > 0 ? '#fecaca' : '#e2e8f0'};width:25%;">
            <div style="font-size:28px;font-weight:800;color:${teamTotals.totalOverdue > 0 ? '#ef4444' : '#1e293b'};">${teamTotals.totalOverdue}</div>
            <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Vencidas</div>
          </td>
        </tr>
      </table>`;

  // Alertas de sobrecarga
  if (overloaded.length > 0) {
    html += `
      <div style="background:#fef3c7;border-left:4px solid #f59e0b;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#92400e;">⚠️ Personas sobrecargadas</p>
        ${overloaded.map(k => `<p style="margin:4px 0;font-size:13px;color:#78350f;"><strong>${k.user.name}</strong> — ${k.currentWorkload} pendientes, ${k.overdueCount} vencidas</p>`).join('')}
      </div>`;
  }

  // Tabla de rendimiento
  html += `
      <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:0 0 12px;letter-spacing:-0.3px;">Rendimiento por persona</h2>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:12px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e2e8f0;">Persona</th>
            <th style="padding:12px 8px;text-align:center;font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e2e8f0;">Completadas</th>
            <th style="padding:12px 8px;text-align:center;font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e2e8f0;">Cumplimiento</th>
            <th style="padding:12px 8px;text-align:center;font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e2e8f0;">Prom. días</th>
            <th style="padding:12px 8px;text-align:center;font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e2e8f0;">Pendientes</th>
            <th style="padding:12px 8px;text-align:center;font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e2e8f0;">Vencidas</th>
          </tr>
        </thead>
        <tbody>`;

  kpis.forEach((k, i) => {
    const rateColor = k.complianceRate >= 70 ? '#10b981' : k.complianceRate >= 40 ? '#f59e0b' : '#ef4444';
    const rowBg = i % 2 === 0 ? '#fff' : '#f8fafc';
    html += `
          <tr style="background:${rowBg};">
            <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;color:#1e293b;">${k.user.name}</td>
            <td style="padding:10px 8px;border-bottom:1px solid #f1f5f9;text-align:center;font-size:13px;font-weight:700;color:#1e293b;">${k.totalCompleted}</td>
            <td style="padding:10px 8px;border-bottom:1px solid #f1f5f9;text-align:center;font-size:13px;font-weight:700;color:${rateColor};">${k.complianceRate}%</td>
            <td style="padding:10px 8px;border-bottom:1px solid #f1f5f9;text-align:center;font-size:13px;color:#64748b;">${k.avgResolutionDays}d</td>
            <td style="padding:10px 8px;border-bottom:1px solid #f1f5f9;text-align:center;font-size:13px;font-weight:600;color:#1e293b;">${k.currentWorkload}</td>
            <td style="padding:10px 8px;border-bottom:1px solid #f1f5f9;text-align:center;font-size:13px;font-weight:700;color:${k.overdueCount > 0 ? '#ef4444' : '#94a3b8'};">${k.overdueCount}</td>
          </tr>`;
  });

  html += `
        </tbody>
      </table>

      <!-- Necesitan atención -->`;

  if (needsAttention.length > 0) {
    html += `
      <div style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;padding:16px 20px;margin-top:24px;">
        <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#991b1b;">🔴 Tareas vencidas por persona</p>
        ${needsAttention.map(k => `<p style="margin:4px 0;font-size:13px;color:#7f1d1d;"><strong>${k.user.name}</strong>: ${k.overdueCount} ${k.overdueCount === 1 ? 'tarea vencida' : 'tareas vencidas'}</p>`).join('')}
      </div>`;
  }

  html += `
    </div>

    <!-- Footer -->
    <div style="background:#f1f5f9;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0;">
      <p style="color:#94a3b8;font-size:11px;margin:0;font-weight:500;">Generado automáticamente por GEMS CRM · ${new Date().toLocaleString('es-CO')}</p>
    </div>
  </div>`;

  return html;
}

// ─── Enviar reporte por email ────────────────────────────────────────────

async function sendTeamReport({ recipients, period = 'week', department } = {}) {
  const summary = await generateTeamSummary({ period, department });
  const html = buildReportEmailHtml(summary, { period });

  const periodLabel = { week: 'Semanal', month: 'Mensual', quarter: 'Trimestral', year: 'Anual' }[period] || period;
  const subject = `📊 Reporte ${periodLabel} del Equipo — ${new Date().toLocaleDateString('es-CO')}`;

  // Si no se pasan recipients, buscar en settings o enviar a admins
  if (!recipients || recipients.length === 0) {
    const settings = await Setting.findOne({ key: 'teamReports' }).lean();
    if (settings?.value?.recipients?.length > 0) {
      recipients = settings.value.recipients;
    } else {
      const admins = await User.find({ role: { $in: ['admin', 'manager'] }, isActive: { $ne: false } }).select('email').lean();
      recipients = admins.map(a => a.email).filter(Boolean);
    }
  }

  if (recipients.length === 0) {
    console.warn('[TeamReport] No recipients found, skipping email');
    return { success: false, error: 'No hay destinatarios configurados' };
  }

  const results = [];
  for (const email of recipients) {
    const info = await sendMail({ to: email, subject, html });
    results.push({ email, sent: !!info });
  }

  return { success: true, results, summary };
}

module.exports = {
  getTeamKPIs,
  getWeeklyTrends,
  getMonthlyTrends,
  generateTeamSummary,
  buildReportEmailHtml,
  sendTeamReport,
};
