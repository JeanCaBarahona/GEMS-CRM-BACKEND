/**
 * Verificación previa de migrateToMultiTenant.js. SOLO LECTURA: no escribe nada.
 * Reporta qué cambiaría la migración y si el login quedará funcionando.
 */
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
require('dotenv').config();
const mongoose = require('mongoose');

const SLUG = process.env.DEFAULT_ORG_SLUG || 'gems';
const NAME = process.env.DEFAULT_ORG_NAME || 'GEMS Innovations';
const TENANT_MODELS = ['Activity','Board','Case','ChatRoom','Client','Doc','FixedExpense','Followup',
  'Issue','Message','Minute','Notification','Payment','ProspectConversation','Role','Setting','Task',
  'Team','Ticket','Transaction','Wiki'];

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Base de datos: ${mongoose.connection.name}`);
  console.log('>>> SOLO LECTURA — no se escribe nada\n');

  const Organization = require('../models/Organization');
  const Membership = require('../models/Membership');
  const User = require('../models/User');

  const org = await Organization.findOne({ slug: SLUG });
  console.log(`1. Organización "${NAME}" (slug: ${SLUG}): ${org ? 'YA EXISTE' : 'SE VA A CREAR'}`);

  console.log('\n2. Documentos que recibirán organizationId:');
  let totalDocs = 0;
  for (const name of TENANT_MODELS) {
    try {
      const Model = require(`../models/${name}`);
      const pend = await Model.countDocuments({ $or: [{ organizationId: { $exists: false } }, { organizationId: null }] });
      const tot = await Model.countDocuments({});
      if (tot > 0) console.log(`   ${name.padEnd(22)} ${String(pend).padStart(5)} de ${tot}`);
      totalDocs += pend;
    } catch (err) {
      console.log(`   ${name.padEnd(22)} ERROR: ${err.message}`);
    }
  }
  console.log(`   ${'TOTAL'.padEnd(22)} ${String(totalDocs).padStart(5)} documentos`);

  console.log('\n3. Memberships:');
  const users = await User.find({}).select('email role isActive isVerified isSuperAdmin isTwoFactorEnabled').lean();
  let crear = 0, existen = 0;
  for (const u of users) {
    const has = org ? await Membership.findOne({ user: u._id, organization: org._id }).lean() : null;
    if (has) existen++; else crear++;
  }
  console.log(`   usuarios totales: ${users.length}`);
  console.log(`   memberships a crear: ${crear}   ya existentes: ${existen}`);

  console.log('\n4. ¿Quién podrá iniciar sesión después?');
  const inactivos = users.filter(u => u.isActive === false);
  const noVerif = users.filter(u => u.isVerified === false);
  const superA = users.filter(u => u.isSuperAdmin);
  const con2fa = users.filter(u => u.isTwoFactorEnabled);
  console.log(`   podrán entrar en un solo paso: ${users.length - inactivos.length - noVerif.length - superA.length}`);
  console.log(`   bloqueados por isActive=false:  ${inactivos.length}${inactivos.length ? ' -> ' + inactivos.map(u=>u.email).join(', ') : ''}`);
  console.log(`   bloqueados por isVerified=false: ${noVerif.length}${noVerif.length ? ' -> ' + noVerif.map(u=>u.email).join(', ') : ''}`);
  console.log(`   super admins (pasan por selector): ${superA.length}${superA.length ? ' -> ' + superA.map(u=>u.email).join(', ') : ''}`);
  console.log(`   con 2FA activo (paso extra):       ${con2fa.length}`);

  console.log('\n5. Roles de los usuarios (define permisos del membership):');
  const roles = {};
  users.forEach(u => { roles[u.role || '(sin rol)'] = (roles[u.role || '(sin rol)'] || 0) + 1; });
  Object.entries(roles).forEach(([r, n]) => console.log(`   ${r.padEnd(22)} ${n}`));

  await mongoose.disconnect();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
