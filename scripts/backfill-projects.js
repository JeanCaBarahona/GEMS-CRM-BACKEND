/**
 * Crea el proyecto por defecto "Interno" en cada cliente que no tenga proyectos
 * y asigna a ese proyecto las tareas y actividades del cliente que aún no tengan projectId.
 *
 *   node scripts/backfill-projects.js            → SIMULACIÓN, no escribe nada
 *   node scripts/backfill-projects.js --apply    → aplica los cambios
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const DEFAULT_NAME = 'Interno';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Base de datos: ${mongoose.connection.name}`);
  console.log(APPLY ? '\n>>> MODO APLICAR: se van a escribir los cambios\n'
                    : '\n>>> SIMULACIÓN: no se escribe nada (usa --apply para aplicar)\n');

  const Client = require('../models/Client');
  const Task = require('../models/Task');
  const Activity = require('../models/Activity');

  const clients = await Client.find({});
  let created = 0, tasksLinked = 0, actsLinked = 0;

  for (const client of clients) {
    let project = (client.projects || []).find(p => p.isDefault)
      || (client.projects || []).find(p => p.name.trim().toLowerCase() === DEFAULT_NAME.toLowerCase());

    if (!project) {
      const doc = { name: DEFAULT_NAME, status: 'active', isDefault: true,
                    description: 'Proyecto por defecto para el trabajo sin proyecto asignado.' };
      if (APPLY) {
        client.projects.push(doc);
        await client.save();
        project = client.projects[client.projects.length - 1];
      } else {
        project = { _id: '(nuevo)' };
      }
      created++;
      console.log(`  + "${DEFAULT_NAME}" en cliente: ${client.name}`);
    }

    const filter = { organizationId: client.organizationId, clientId: client._id,
                     $or: [{ projectId: null }, { projectId: { $exists: false } }] };
    const [nt, na] = await Promise.all([Task.countDocuments(filter), Activity.countDocuments(filter)]);

    if (nt || na) {
      console.log(`    ${client.name}: ${nt} tarea(s), ${na} actividad(es) -> "${DEFAULT_NAME}"`);
      if (APPLY) {
        if (nt) await Task.updateMany(filter, { $set: { projectId: project._id } });
        if (na) await Activity.updateMany(filter, { $set: { projectId: project._id } });
      }
      tasksLinked += nt; actsLinked += na;
    }
  }

  const orphanTasks = await Task.countDocuments({ clientId: null, $or: [{ projectId: null }, { projectId: { $exists: false } }] });
  const orphanActs = await Activity.countDocuments({ clientId: null, $or: [{ projectId: null }, { projectId: { $exists: false } }] });

  console.log('\n───────── Resumen ─────────');
  console.log(`  Clientes revisados:                 ${clients.length}`);
  console.log(`  Proyectos "${DEFAULT_NAME}" a crear:         ${created}`);
  console.log(`  Tareas a vincular:                  ${tasksLinked}`);
  console.log(`  Actividades a vincular:             ${actsLinked}`);
  console.log(`  Sin cliente (quedan sin proyecto):  ${orphanTasks} tarea(s), ${orphanActs} actividad(es)`);
  if (!APPLY) console.log('\n  Nada se escribió. Ejecuta con --apply para aplicar.');
  await mongoose.disconnect();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
