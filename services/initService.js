/**
 * Inicialización mínima al arrancar el servidor.
 *
 * Reglas multi-tenant:
 *  - El soporte global de GEMS y roles de sistema se crean DENTRO de la org default ("gems").
 *  - Si la org default no existe todavía (primera vez), no se hace nada: corre el script
 *    `node scripts/migrateToMultiTenant.js` o regístrate como primer usuario por /auth/register.
 */
const User = require('../models/User');
const Role = require('../models/Role');
const Organization = require('../models/Organization');
const Membership = require('../models/Membership');

const DEFAULT_ORG_SLUG = process.env.DEFAULT_ORG_SLUG || 'gems';

async function ensureSupportUser() {
  try {
    const defaultOrg = await Organization.findOne({ slug: DEFAULT_ORG_SLUG });
    if (!defaultOrg) {
      console.log('[Init] Org default aún no existe; saltando ensureSupportUser.');
      return;
    }

    const supportEmail = process.env.SUPPORT_EMAIL || 'soporte@gems.cr';
    let supportUser = await User.findOne({ email: supportEmail });

    if (!supportUser) {
      console.log(`[Init] Creando usuario de soporte: ${supportEmail}`);
      supportUser = new User({
        name: 'Soporte GEMS',
        email: supportEmail,
        password: process.env.SUPPORT_PASSWORD || 'Support.2024!',
        role: 'support',
        isActive: true
      });
      await supportUser.save();
    }

    const membership = await Membership.findOne({
      user: supportUser._id,
      organization: defaultOrg._id
    });

    if (!membership) {
      await Membership.create({
        user: supportUser._id,
        organization: defaultOrg._id,
        role: 'support',
        status: 'active',
        position: 'Support Manager',
        department: 'Soporte Técnico',
        acceptedAt: new Date()
      });
      console.log('[Init] Membership de soporte creado en org default');
    }
  } catch (err) {
    console.error('[Init] Error en ensureSupportUser:', err.message);
  }
}

const DEFAULT_ROLE_DEFS = [
  {
    name: 'Administrador',
    description: 'Acceso total al sistema',
    isSystem: true,
    permissions: {
      dashboard: true,
      clients: { view: true, create: true, edit: true, delete: true },
      activities: { view: true, create: true, edit: true, delete: true },
      reports: { view: true, export: true },
      accounting: { view: true, create: true, edit: true, delete: true },
      cases: { view: true, create: true, edit: true, delete: true },
      team: { view: true, create: true, edit: true, delete: true }
    }
  },
  {
    name: 'Gerencia',
    description: 'Gestión de equipos y clientes, sin borrado directivo',
    isSystem: true,
    permissions: {
      dashboard: true,
      clients: { view: true, create: true, edit: true, delete: false },
      activities: { view: true, create: true, edit: true, delete: false },
      reports: { view: true, export: true },
      accounting: { view: true, create: true, edit: true, delete: false },
      cases: { view: true, create: true, edit: true, delete: false },
      team: { view: true, create: true, edit: true, delete: false }
    }
  },
  {
    name: 'Ejecutivo Comercial',
    description: 'Gestión de ventas y prospectos',
    isSystem: true,
    permissions: {
      dashboard: true,
      clients: { view: true, create: true, edit: true, delete: false },
      activities: { view: true, create: true, edit: true, delete: true },
      reports: { view: false, export: false },
      accounting: { view: false, create: false, edit: false, delete: false },
      cases: { view: true, create: true, edit: false, delete: false },
      team: { view: true, create: false, edit: false, delete: false }
    }
  },
  {
    name: 'Soporte Técnico',
    description: 'Resolución de incidencias técnicas',
    isSystem: true,
    permissions: {
      dashboard: true,
      clients: { view: true, create: false, edit: false, delete: false },
      activities: { view: true, create: true, edit: true, delete: true },
      reports: { view: false, export: false },
      accounting: { view: false, create: false, edit: false, delete: false },
      cases: { view: true, create: true, edit: true, delete: true },
      team: { view: true, create: false, edit: false, delete: false }
    }
  }
];

/**
 * Asegura los roles de sistema dentro de cualquier org. Idempotente.
 * Usar al crear una nueva organización: ensureDefaultRolesForOrg(org._id)
 */
async function ensureDefaultRolesForOrg(organizationId) {
  for (const def of DEFAULT_ROLE_DEFS) {
    const exists = await Role.findOne({ organizationId, name: def.name });
    if (!exists) {
      await Role.create({ ...def, organizationId });
    }
  }
}

/**
 * Backfillea los roles de sistema en TODAS las orgs activas. Se ejecuta al arrancar.
 */
async function ensureDefaultRoles() {
  try {
    const orgs = await Organization.find({ status: 'active' }).select('_id name');
    for (const org of orgs) {
      await ensureDefaultRolesForOrg(org._id);
    }
    if (orgs.length > 0) {
      console.log(`[Init] Roles de sistema verificados en ${orgs.length} organización(es)`);
    }
  } catch (err) {
    console.error('[Init] Error en ensureDefaultRoles:', err.message);
  }
}

// ─── Proyectos por defecto de cada cliente ──────────────────────────────────
// Todo cliente tiene "Interno" y "Soporte" (protegidos: isDefault no se puede
// borrar). Los clientes nuevos ya nacen con ellos (routes/clients.js); esto
// completa los existentes. Idempotente: solo agrega lo que falta y, si ya había
// un proyecto con ese nombre, lo marca como por defecto en vez de duplicarlo.
const DEFAULT_CLIENT_PROJECTS = ['Interno', 'Soporte'];

const normalizeName = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

async function ensureDefaultClientProjects() {
  try {
    const Client = require('../models/Client');
    const clients = await Client.find().select('projects._id projects.name projects.isDefault').lean();
    let added = 0, marked = 0;

    for (const client of clients) {
      for (const name of DEFAULT_CLIENT_PROJECTS) {
        const existing = (client.projects || []).find(p => normalizeName(p.name) === normalizeName(name));
        // updateOne (no save) para no revalidar datos viejos del cliente, ej. correos
        // guardados antes de la validación de formato.
        if (!existing) {
          await Client.updateOne({ _id: client._id }, { $push: { projects: { name, status: 'active', isDefault: true } } });
          added++;
        } else if (!existing.isDefault) {
          await Client.updateOne({ _id: client._id, 'projects._id': existing._id }, { $set: { 'projects.$.isDefault': true } });
          marked++;
        }
      }
    }

    if (added || marked) {
      console.log(`[Init] Proyectos por defecto: ${added} creados, ${marked} marcados en ${clients.length} cliente(s)`);
    }
  } catch (err) {
    console.error('[Init] Error asegurando proyectos por defecto de clientes:', err.message);
  }
}

module.exports = {
  ensureSupportUser,
  ensureDefaultRoles,
  ensureDefaultRolesForOrg,
  ensureDefaultClientProjects,
  DEFAULT_CLIENT_PROJECTS
};
