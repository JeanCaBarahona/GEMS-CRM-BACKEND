/**
 * Reactiva cuentas (isActive: true) por correo. Necesario porque el login del
 * código nuevo rechaza usuarios con isActive: false.
 *
 *   node scripts/activate-user.js correo@dominio.com [otro@dominio.com ...]
 *   node scripts/activate-user.js --list        → solo lista las desactivadas
 */
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const emails = args.filter(a => a.includes('@')).map(e => e.trim().toLowerCase());

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Base de datos: ${mongoose.connection.name}\n`);
  const User = require('../models/User');

  if (LIST || emails.length === 0) {
    const off = await User.find({ isActive: false }).select('email name role').lean();
    console.log(`Cuentas desactivadas (${off.length}):`);
    off.forEach(u => console.log(`  - ${u.email}  (${u.name || 'sin nombre'}, ${u.role || 'sin rol'})`));
    if (emails.length === 0 && !LIST) {
      console.log('\nPasa uno o más correos para reactivarlos.');
    }
    await mongoose.disconnect();
    process.exit(0);
  }

  for (const email of emails) {
    const user = await User.findOne({ email });
    if (!user) { console.log(`  ✗ ${email}: no existe`); continue; }
    if (user.isActive) { console.log(`  · ${email}: ya estaba activo`); continue; }
    user.isActive = true;
    await user.save();
    console.log(`  ✓ ${email}: activado`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
