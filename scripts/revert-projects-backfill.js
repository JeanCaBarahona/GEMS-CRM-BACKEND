/**
 * Revierte lo que escribió backfill-projects.js: quita los proyectos "Interno"
 * marcados como isDefault y limpia el projectId de las tareas y actividades
 * que apuntaban a ellos.
 *
 *   node scripts/revert-projects-backfill.js            → SIMULACIÓN
 *   node scripts/revert-projects-backfill.js --apply    → aplica
 */
require('dotenv').config();
const mongoose = require('mongoose');
const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Base de datos: ${mongoose.connection.name}`);
  console.log(APPLY ? '\n>>> MODO APLICAR\n' : '\n>>> SIMULACIÓN (usa --apply para aplicar)\n');

  const Client = require('../models/Client');
  const Task = require('../models/Task');
  const Activity = require('../models/Activity');

  const clients = await Client.find({ 'projects.isDefault': true });
  let removed = 0, tasksCleared = 0, actsCleared = 0;

  for (const client of clients) {
    const targets = (client.projects || []).filter(p => p.isDefault && p.name === 'Interno');
    if (!targets.length) continue;
    const ids = targets.map(p => p._id);

    const filter = { projectId: { $in: ids } };
    const [nt, na] = await Promise.all([Task.countDocuments(filter), Activity.countDocuments(filter)]);
    console.log(`  ${client.name}: quitar ${targets.length} proyecto(s) "Interno" · limpiar ${nt} tarea(s), ${na} actividad(es)`);

    if (APPLY) {
      if (nt) await Task.updateMany(filter, { $unset: { projectId: '' } });
      if (na) await Activity.updateMany(filter, { $unset: { projectId: '' } });
      for (const id of ids) client.projects.id(id)?.deleteOne();
      await client.save();
    }
    removed += targets.length; tasksCleared += nt; actsCleared += na;
  }

  console.log('\n───────── Resumen ─────────');
  console.log(`  Proyectos "Interno" a quitar: ${removed}`);
  console.log(`  Tareas a limpiar:            ${tasksCleared}`);
  console.log(`  Actividades a limpiar:       ${actsCleared}`);
  if (!APPLY) console.log('\n  Nada se escribió.');
  await mongoose.disconnect();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
